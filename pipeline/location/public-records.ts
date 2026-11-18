/**
 * 공시가격·개별공시지가·건축물대장 보강.
 * housing-official-price / gongsijiga-search 는 realtyprice.kr 공개 표면을 직접 호출하고,
 * 공동주택 공시가격은 VWorld(VWORLD_KEY, 필지+호)를 먼저 보고, 없거나 못 좁히면 realtyprice.kr(단지명 검색)로 받는다.
 * 건축물대장 표제부는 data.go.kr 건축HUB 를 자체 키(MOLIT_SERVICE_KEY)로 먼저 부르고, 키가 없거나 응답이 실패면
 * k-skill 프록시(키 없음)로 받는다. 주소→필지는 프록시만 쓴다.
 *
 * 공시가격은 시세가 아니다. 후보·동·호가 하나로 안 좁혀지면 고르지 않고 비운다.
 * 법원경매 크롤러와 같은 사이트를 다시 치지 않는다.
 */
import { createRequire } from 'node:module';
import type { BuildingInfo, PropertyType } from '../../shared/types.ts';
import { query } from '../../shared/db.ts';
import { requestKskillProxy } from '../../shared/kskill-real-estate.ts';
import { stripToJibun } from './osm.ts';
import { extractDong } from './comps.ts';

const require = createRequire(import.meta.url);
const PROXY_BASE = (process.env.KSKILL_PROXY_BASE_URL ?? 'https://k-skill-proxy.nomadamas.org').replace(/\/$/, '');
const VWORLD_PRICE_URL = 'https://api.vworld.kr/ned/data/getApartHousingPriceAttr';
const REGISTER_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo';
const UA = 'gyeongmae-agent/0.1 (personal auction research; public-record enrichment)';
const TIMEOUT_MS = 8_000;
const HIT_TTL_MS = 30 * 86_400_000;
const MISS_TTL_MS = 7 * 86_400_000;
const DELAY_MS = Number(process.env.KSKILL_ENRICH_DELAY_MS ?? 250);

export interface AuctionAddressParts {
  jibun: string;
  isJibun: boolean;
  bun?: string;
  ji?: string;
  dong?: string;
  complexName?: string;
  dongName?: string;
  hoName?: string;
}

export interface ApartmentCandidate {
  noticeDate: string;
  aptCode: string;
  complexName?: string | null;
  roadAddress?: string | null;
  landAddress?: string | null;
  pnu?: string | null;
}

export interface UnitChoice {
  code: string;
  name: string;
}

export interface PublicRecordEnrichment {
  gongPrice?: number;
  landPricePerSqm?: number;
  building?: BuildingInfo;
  notes: string[];
}

export interface PublicRecordSources {
  geocode(address: string): Promise<{ pnu: string; jibun?: string } | null>;
  building(pnu: string): Promise<BuildingInfo | null>;
  /** source 가 없으면 realtyprice.kr(예전 캐시 포함). */
  apartment(parts: AuctionAddressParts, pnu: string | null): Promise<{ priceWon: number; year: number; label: string; source?: string } | null>;
  house(pnu: string): Promise<{ priceWon: number; year: number } | null>;
  land(jibun: string): Promise<{ pricePerSqm: number; year: number } | null>;
}

const COLLECTIVE: Record<string, true> = { apartment: true, villa: true, officetel: true };

export function parseAuctionAddress(address: string): AuctionAddressParts {
  const stripped = stripToJibun(address);
  const tokens = stripped.trim().split(/\s+/);
  const last = tokens.at(-1) ?? '';
  const prev = tokens.at(-2) ?? '';
  const isJibun = /^\d+(-\d+)?$/.test(last) && /(동|리|가|읍|면)$/.test(prev);
  const [bun, ji] = isJibun ? last.split('-') : [];
  const at = address.indexOf(stripped);
  const tail = at >= 0 ? address.slice(at + stripped.length).trim() : '';
  const dongMatch = tail.match(/(?:^|\s)(\d{1,4}|[A-Za-z]|[가-힣]{1,3})동(?:\s|$)/);
  const hoMatch = tail.match(/(\d{1,5})호/);
  const paren = address.match(/\([^,)]*,\s*([^)]+)\)/);
  let complexName = paren?.[1]?.trim();
  if (!complexName && tail) {
    const name = tail.split(/\s+/).filter((token) => !/(동|호)$/.test(token) && !/층/.test(token) && !/^\d/.test(token));
    if (name.length) complexName = name.join(' ');
  }
  return {
    jibun: isJibun ? stripped : address.trim(),
    isJibun,
    bun,
    ji,
    dong: isJibun ? prev : undefined,
    complexName: complexName || undefined,
    dongName: dongMatch?.[1],
    hoName: hoMatch?.[1],
  };
}

export function unitLabelMatches(upstream: string, wanted: string): boolean {
  const norm = (value: string) => value.replace(/\s/g, '').replace(/(동|호)$/, '');
  const left = norm(upstream);
  const right = norm(wanted);
  return left.length > 0 && left === right;
}

export function selectUniqueUnit(items: UnitChoice[], wanted: string | undefined): UnitChoice | null {
  if (!items.length) return null;
  if (!wanted) return items.length === 1 ? items[0]! : null;
  const matches = items.filter((item) => unitLabelMatches(item.name, wanted));
  return matches.length === 1 ? matches[0]! : null;
}

function bunAppears(text: string, bun: string, ji?: string): boolean {
  const src = text.replace(/\s/g, '');
  if (ji) {
    return new RegExp(`(?:^|\\D)${bun}-${ji}(?:번지)?(?:\\D|$)`).test(src);
  }
  return new RegExp(`(?:^|\\D)${bun}(?:번지)?(?:\\D|$)`).test(src);
}

export function candidateMatchesJibun(
  candidate: { landAddress?: string | null; roadAddress?: string | null },
  parts: AuctionAddressParts,
): boolean {
  if (!parts.bun) return false;
  const text = `${candidate.landAddress ?? ''} ${candidate.roadAddress ?? ''}`;
  if (!bunAppears(text, parts.bun, parts.ji)) return false;
  return !parts.dong || text.includes(parts.dong);
}

/** 후보가 하나면 그 후보. 여러 개면 지번이 하나로 맞는 경우만. 첫 후보를 고르지 않는다. */
export function chooseApartmentCandidate(candidates: ApartmentCandidate[], parts: AuctionAddressParts): ApartmentCandidate | null {
  const usable = candidates.filter((candidate) => candidate.aptCode && candidate.noticeDate);
  if (usable.length === 1) return usable[0]!;
  if (usable.length === 0) return null;
  const matched = usable.filter((candidate) => candidateMatchesJibun(candidate, parts));
  return matched.length === 1 ? matched[0]! : null;
}

export function pnuFromKakaoAddress(address: {
  b_code?: string;
  main_address_no?: string;
  sub_address_no?: string;
  mountain_yn?: string;
}): string | null {
  const bjd = address.b_code ?? '';
  const main = address.main_address_no ?? '';
  if (!/^\d{10}$/.test(bjd) || !/^\d{1,4}$/.test(main)) return null;
  const subRaw = (address.sub_address_no ?? '').trim();
  const sub = subRaw === '' ? '0' : subRaw;
  if (!/^\d{1,4}$/.test(sub)) return null;
  const land = address.mountain_yn === 'Y' ? '2' : '1';
  return `${bjd}${land}${main.padStart(4, '0')}${sub.padStart(4, '0')}`;
}

export function buildingFromTitle(item: Record<string, unknown>): BuildingInfo {
  const positiveInt = (value: unknown): number | undefined => {
    const n = parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const positive = (value: unknown): number | undefined => {
    const n = parseFloat(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const day = String(item.useAprDay ?? '');
  const mainUse = String(item.mainPurpsCdNm ?? '').trim();
  return {
    mainUse: mainUse || undefined,
    households: positiveInt(item.hhldCnt),
    units: positiveInt(item.hoCnt),
    approvalDate: /^\d{8}$/.test(day) ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` : undefined,
    floorsAbove: positiveInt(item.grndFlrCnt),
    floorsBelow: positiveInt(item.ugrndFlrCnt),
    far: positive(item.vlRat),
    bcr: positive(item.bcRat),
  };
}

export function pickTitleItem(items: Record<string, unknown>[]): Record<string, unknown> | null {
  if (!items.length) return null;
  return items.find((item) => item.mainAtchGbCdNm === '주건축물') ?? items[0]!;
}


export function mergeBuilding(base: BuildingInfo | undefined, extra: BuildingInfo | undefined): BuildingInfo | undefined {
  if (!extra) return base;
  if (!base) return extra;
  return {
    mainUse: base.mainUse || extra.mainUse,
    households: base.households || extra.households,
    units: base.units || extra.units,
    approvalDate: base.approvalDate || extra.approvalDate,
    floorsAbove: base.floorsAbove || extra.floorsAbove,
    floorsBelow: base.floorsBelow ?? extra.floorsBelow,
    far: base.far || extra.far,
    bcr: base.bcr || extra.bcr,
  };
}

export async function enrichMissingRecords(
  listing: { address: string; propertyType: PropertyType },
  existing: { gongPrice?: number; building?: BuildingInfo },
  sources: PublicRecordSources,
): Promise<PublicRecordEnrichment> {
  const notes: string[] = [];
  const parts = parseAuctionAddress(listing.address);
  const needGong = !(existing.gongPrice && existing.gongPrice > 0);
  const needBuilding = !existing.building?.mainUse;
  const needLand = listing.propertyType === 'land' || listing.propertyType === 'house' || listing.propertyType === 'commercial';
  if (!needGong && !needBuilding && !needLand) return { notes };

  let pnu: string | null = null;
  let jibunForLand = parts.isJibun ? parts.jibun : null;
  const collective = listing.propertyType in COLLECTIVE;
  const needGeo = needBuilding || (needGong && (collective || listing.propertyType === 'house')) || (needLand && !jibunForLand);
  if (needGeo) {
    const geo = await sources.geocode(parts.isJibun ? parts.jibun : stripToJibun(listing.address));
    pnu = geo?.pnu ?? null;
    if (!jibunForLand && geo?.jibun) jibunForLand = geo.jibun;
  }

  let building: BuildingInfo | undefined;
  if (needBuilding && pnu) building = (await sources.building(pnu)) ?? undefined;

  let gongPrice: number | undefined;
  if (needGong && collective && (parts.complexName || pnu)) {
    const apt = await sources.apartment(parts, pnu);
    if (apt?.priceWon) {
      gongPrice = apt.priceWon;
      notes.push(`공동주택공시가격 ${(apt.priceWon / 1e8).toFixed(2)}억 (${apt.source ?? 'realtyprice.kr'} ${apt.year}, ${apt.label}) — 시세·감정가 아님`);
    }
  } else if (needGong && listing.propertyType === 'house' && pnu) {
    const house = await sources.house(pnu);
    if (house?.priceWon) {
      gongPrice = house.priceWon;
      notes.push(`개별주택공시가격 ${(house.priceWon / 1e8).toFixed(2)}억 (realtyprice.kr ${house.year}) — 시세·감정가 아님`);
    }
  }

  let landPricePerSqm: number | undefined;
  if (needLand && jibunForLand) {
    const land = await sources.land(jibunForLand);
    if (land?.pricePerSqm) {
      landPricePerSqm = land.pricePerSqm;
      notes.push(`개별공시지가 ${land.pricePerSqm.toLocaleString('ko-KR')}원/㎡ (realtyprice.kr ${land.year}) — 시세 아님`);
    }
  }

  return { gongPrice, landPricePerSqm, building, notes };
}

interface HousingApi {
  searchApartmentCandidates(selector: { complexName: string }, options?: { timeoutMs?: number }): Promise<{ status: string; candidates: ApartmentCandidate[] }>;
  listApartmentDongs(candidate: ApartmentCandidate, options?: { timeoutMs?: number }): Promise<{ dongs: UnitChoice[] }>;
  listApartmentHos(candidate: ApartmentCandidate, dong: UnitChoice, options?: { timeoutMs?: number }): Promise<{ hos: UnitChoice[] }>;
  lookupApartmentPriceHistory(candidate: ApartmentCandidate, dong: UnitChoice, ho: UnitChoice, options?: { timeoutMs?: number }): Promise<{ price_won: number | null; year: number | null }[]>;
  lookupIndividualHousePriceByPnu(pnu: string, options?: { timeoutMs?: number }): Promise<{ status: string; history: { price_won: number | null; year: number | null }[] }>;
}

interface GongsijigaApi {
  lookupGongsijiga(address: string, fetchFn?: typeof fetch): Promise<{ latest?: { price_per_sqm?: number; year?: number } }>;
}

let housingApi: HousingApi | null = null;
let landApi: GongsijigaApi | null = null;
function housing(): HousingApi {
  housingApi ??= require('housing-official-price') as HousingApi;
  return housingApi;
}
function gongsijiga(): GongsijigaApi {
  landApi ??= require('gongsijiga-search') as GongsijigaApi;
  return landApi;
}

let ensured = false;
async function ensureCacheTable(): Promise<void> {
  if (ensured) return;
  await query(
    `create table if not exists gm_public_record_cache (
       kind text not null,
       cache_key text not null,
       payload jsonb,
       fetched_at timestamptz not null default now(),
       primary key (kind, cache_key)
     )`,
  );
  ensured = true;
}

export async function readCache(kind: string, key: string): Promise<unknown | undefined> {
  try {
    await ensureCacheTable();
    const rows = await query<{ payload: unknown; fetched_at: Date | string }>(
      'select payload, fetched_at from gm_public_record_cache where kind=$1 and cache_key=$2',
      [kind, key],
    );
    const row = rows[0];
    if (!row) return undefined;
    const age = Date.now() - new Date(row.fetched_at).getTime();
    const ttl = row.payload == null ? MISS_TTL_MS : HIT_TTL_MS;
    if (age > ttl) return undefined;
    return row.payload;
  } catch {
    return undefined;
  }
}

export async function writeCache(kind: string, key: string, payload: unknown): Promise<void> {
  try {
    await ensureCacheTable();
    await query(
      `insert into gm_public_record_cache (kind, cache_key, payload, fetched_at)
       values ($1,$2,$3::jsonb,now())
       on conflict (kind, cache_key) do update set payload=excluded.payload, fetched_at=now()`,
      [kind, key, payload == null ? null : JSON.stringify(payload)],
    );
  } catch { /* 캐시 실패는 조회를 막지 않음 */ }
}

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

let pace: Promise<void> = Promise.resolve();
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = pace.then(fn, fn);
  const wait = Promise.withResolvers<void>();
  pace = run.then(() => { setTimeout(wait.resolve, DELAY_MS); }, () => { setTimeout(wait.resolve, DELAY_MS); });
  return run;
}

// 연속 3회 실패하면 잠시 쉰다. 실행 내내 끄면 1만 건 배치에서 일시 장애 한 번에 나머지가 전부 빠진다.
const COOLDOWN_MS = 5 * 60_000;
const circuits = {
  geo: { fails: 0, downUntil: 0, label: '주소→필지 프록시', skipped: '필지 보강' },
  record: { fails: 0, downUntil: 0, label: '공시·대장', skipped: '공시가격/건축물대장 보강' },
};

function bump(kind: keyof typeof circuits, err: unknown): void {
  const circuit = circuits[kind];
  circuit.fails += 1;
  if (circuit.fails < 3) return;
  circuit.fails = 0;
  circuit.downUntil = Date.now() + COOLDOWN_MS;
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(`[kskill] ${circuit.label} 연속 실패(${reason}) — ${COOLDOWN_MS / 60_000}분간 ${circuit.skipped} 생략`);
}

async function cachedLookup<T>(kind: string, key: string, load: () => Promise<{ value: T | null; cacheable: boolean }>, circuit: keyof typeof circuits): Promise<T | null> {
  if (Date.now() < circuits[circuit].downUntil) return null;
  const hit = await readCache(kind, key);
  if (hit !== undefined) return hit as T | null;
  try {
    const result = await paced(load);
    if (result.cacheable) await writeCache(kind, key, result.value);
    if (result.value != null) circuits[circuit].fails = 0;
    return result.value;
  } catch (err) {
    bump(circuit, err);
    return null;
  }
}

function cacheableCode(code: string | undefined): boolean {
  return !!code && /^(AMBIGUOUS_|INVALID_|APARTMENT_CANDIDATE_NOT_FOUND|INDIVIDUAL_HOUSE_NOT_FOUND|ADDRESS_PARSE_FAILED|LAND_NOT_FOUND|REGION_NOT_FOUND|INVALID_BUNJI)/.test(code);
}

async function getJson(url: string): Promise<unknown> {
  const res = await requestKskillProxy(url, TIMEOUT_MS);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'UPSTREAM_HTTP_ERROR' });
  return res.json();
}

function parcelParams(pnu: string): URLSearchParams {
  const land = pnu[10] === '2' ? '1' : '0';
  return new URLSearchParams({
    sigunguCd: pnu.slice(0, 5),
    bjdongCd: pnu.slice(5, 10),
    platGbCd: land,
    bun: pnu.slice(11, 15),
    ji: pnu.slice(15, 19),
    numOfRows: '10',
  });
}

function kakaoParcel(payload: unknown): { pnu: string; jibun?: string } | null {
  if (!payload || typeof payload !== 'object' || !('documents' in payload) || !Array.isArray(payload.documents) || payload.documents.length !== 1) return null;
  const first = payload.documents[0];
  if (!first || typeof first !== 'object' || !('address' in first) || !first.address || typeof first.address !== 'object') return null;
  const addr = first.address;
  if (!('b_code' in addr) || typeof addr.b_code !== 'string') return null;
  if (!('main_address_no' in addr) || typeof addr.main_address_no !== 'string') return null;
  const sub = 'sub_address_no' in addr && typeof addr.sub_address_no === 'string' ? addr.sub_address_no : '';
  const mountain = 'mountain_yn' in addr && typeof addr.mountain_yn === 'string' ? addr.mountain_yn : 'N';
  const pnu = pnuFromKakaoAddress({
    b_code: addr.b_code,
    main_address_no: addr.main_address_no,
    sub_address_no: sub,
    mountain_yn: mountain,
  });
  if (!pnu) return null;
  const named = 'address_name' in addr && typeof addr.address_name === 'string' ? addr.address_name.trim() : '';
  return { pnu, jibun: named && parseAuctionAddress(named).isJibun ? named : undefined };
}

function titleItems(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object' || !('items' in payload) || !Array.isArray(payload.items)) return [];
  return payload.items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
}

async function geocodeParcel(address: string): Promise<{ pnu: string; jibun?: string } | null> {
  const url = new URL(`${PROXY_BASE}/v1/kakao-local/geocode`);
  url.searchParams.set('q', address);
  url.searchParams.set('limit', '2');
  return kakaoParcel(await getJson(url.toString()));
}

let ownRegisterOff = false; // 미승인(401/403)·쿼터(429) — 이번 실행은 프록시만 쓴다

/**
 * data.go.kr 건축HUB 표제부. null = 키 없음·실패(프록시로 넘긴다). 항목 필드는 프록시 응답과 같다.
 * 게이트웨이가 가끔 503(SERVICETIMEOUT)을 준다(2026-11 실측 60건 중 2건) — 그 건만 프록시로 받는다.
 */
async function ownTitleItems(pnu: string): Promise<Record<string, unknown>[] | null> {
  const key = process.env.MOLIT_SERVICE_KEY;
  if (!key || ownRegisterOff) return null;
  try {
    const res = await fetch(`${REGISTER_URL}?serviceKey=${encodeURIComponent(key)}&${parcelParams(pnu)}&pageNo=1&_type=json`, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      ownRegisterOff = true;
      console.warn(`[건축물대장] 자체 키 호출 불가(${res.status}) — 이번 실행은 k-skill 프록시만 사용`);
    }
    if (!res.ok) return null;
    const json = (await res.json()) as { response?: { header?: { resultCode?: string }; body?: { items?: { item?: unknown } | string } } };
    if (json.response?.header?.resultCode !== '00') return null;
    const items = json.response.body?.items;
    const raw = items && typeof items === 'object' ? items.item : undefined; // 결과가 없으면 items 가 빈 문자열로 온다
    return titleItems({ items: Array.isArray(raw) ? raw : raw ? [raw] : [] });
  } catch {
    return null;
  }
}

export async function fetchBuilding(pnu: string): Promise<BuildingInfo | null> {
  let items = await ownTitleItems(pnu);
  if (!items) {
    const url = new URL(`${PROXY_BASE}/v1/building-register/title`);
    for (const [key, value] of parcelParams(pnu)) url.searchParams.set(key, value);
    items = titleItems(await getJson(url.toString()));
  }
  const picked = pickTitleItem(items);
  if (!picked) return null;
  const building = buildingFromTitle(picked);
  return building.mainUse ? building : null;
}

export interface VworldPriceRow { stdrYear?: string; aphusNm?: string; dongNm?: string; hoNm?: string; pblntfPc?: string }

/**
 * 같은 필지·같은 호 후보에서 공시가격 하나를 고른다. 동이 맞는 행만 보고, 동 표기가 맞는 행이 없으면 동이 비어 있는 행만 본다
 * (빌라는 동 없이 등재된 경우가 많다). 남은 후보의 가격이 하나로 모이지 않으면 고르지 않는다.
 */
export function pickVworldPrice(rows: VworldPriceRow[], parts: AuctionAddressParts): VworldPriceRow | null {
  const hoName = parts.hoName;
  if (!hoName) return null;
  const sameHo = rows.filter((row) => unitLabelMatches(row.hoNm ?? '', hoName) && Number(row.pblntfPc) > 0);
  const dongName = parts.dongName;
  let pool = sameHo;
  if (dongName) {
    const sameDong = sameHo.filter((row) => unitLabelMatches(row.dongNm ?? '', dongName));
    pool = sameDong.length ? sameDong : sameHo.filter((row) => !row.dongNm?.trim());
  }
  return new Set(pool.map((row) => row.pblntfPc)).size === 1 ? pool[0]! : null;
}

/** VWorld 공동주택가격(필지+호). null = 키 없음·실패·못 좁힘 — realtyprice.kr 경로로 넘긴다. 공시 전(1~4월)이면 전년도를 본다. */
async function vworldApartmentPrice(pnu: string, parts: AuctionAddressParts): Promise<{ priceWon: number; year: number; label: string; source: string } | null> {
  const key = process.env.VWORLD_KEY;
  if (!key || !parts.hoName) return null;
  const thisYear = new Date().getFullYear();
  try {
    for (const year of [thisYear, thisYear - 1]) {
      const res = await fetch(
        `${VWORLD_PRICE_URL}?key=${encodeURIComponent(key)}&format=json&numOfRows=100&pageNo=1&pnu=${pnu}&stdrYear=${year}&hoNm=${encodeURIComponent(parts.hoName)}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { apartHousingPrices?: { field?: VworldPriceRow[] } };
      const rows = json.apartHousingPrices?.field ?? [];
      if (!rows.length) continue;
      const picked = pickVworldPrice(rows, parts);
      if (!picked) return null;
      return { priceWon: Number(picked.pblntfPc), year, label: [picked.aphusNm, picked.dongNm?.trim() ? `${picked.dongNm}동` : '', `${picked.hoNm}호`].filter(Boolean).join(' '), source: 'VWorld' };
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchApartment(parts: AuctionAddressParts): Promise<{ priceWon: number; year: number; label: string } | null> {
  if (!parts.complexName) return null;
  const api = housing();
  const found = await api.searchApartmentCandidates({ complexName: parts.complexName }, { timeoutMs: TIMEOUT_MS });
  if (found.status !== 'ok') return null;
  const candidate = chooseApartmentCandidate(found.candidates ?? [], parts);
  if (!candidate) return null;
  const dongs = await api.listApartmentDongs(candidate, { timeoutMs: TIMEOUT_MS });
  const dong = selectUniqueUnit(dongs.dongs ?? [], parts.dongName);
  if (!dong) return null;
  const hos = await api.listApartmentHos(candidate, dong, { timeoutMs: TIMEOUT_MS });
  const ho = selectUniqueUnit(hos.hos ?? [], parts.hoName);
  if (!ho) return null;
  const history = await api.lookupApartmentPriceHistory(candidate, dong, ho, { timeoutMs: TIMEOUT_MS });
  const latest = history.find((row) => row.price_won && row.price_won > 0);
  if (!latest?.price_won) return null;
  return { priceWon: latest.price_won, year: latest.year ?? new Date().getFullYear(), label: `${parts.complexName} ${dong.name} ${ho.name}` };
}

async function fetchHouse(pnu: string): Promise<{ priceWon: number; year: number } | null> {
  const result = await housing().lookupIndividualHousePriceByPnu(pnu, { timeoutMs: TIMEOUT_MS });
  if (result.status !== 'ok') return null;
  const latest = result.history?.find((row) => row.price_won && row.price_won > 0);
  if (!latest?.price_won) return null;
  return { priceWon: latest.price_won, year: latest.year ?? new Date().getFullYear() };
}

async function fetchLand(jibun: string): Promise<{ pricePerSqm: number; year: number } | null> {
  const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const result = await gongsijiga().lookupGongsijiga(jibun, timedFetch);
  const price = result.latest?.price_per_sqm;
  if (!price || price <= 0) return null;
  return { pricePerSqm: price, year: result.latest?.year ?? new Date().getFullYear() };
}

function sourceError(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err) || typeof err.code !== 'string') return undefined;
  return err.code;
}

export function defaultPublicRecordSources(): PublicRecordSources {
  return {
    geocode: (address) => cachedLookup('geocode', address, async () => {
      try {
        const value = await geocodeParcel(address);
        return { value, cacheable: true };
      } catch (err) {
        if (!cacheableCode(sourceError(err))) throw err;
        return { value: null, cacheable: true };
      }
    }, 'geo'),
    building: (pnu) => cachedLookup('building', pnu, async () => {
      try {
        return { value: await fetchBuilding(pnu), cacheable: true };
      } catch (err) {
        if (!cacheableCode(sourceError(err))) throw err;
        return { value: null, cacheable: true };
      }
    }, 'record'),
    apartment: (parts, pnu) => cachedLookup('apartment', [parts.complexName, parts.dongName, parts.hoName, parts.bun, parts.ji, pnu].join('|'), async () => {
      try {
        return { value: (pnu ? await vworldApartmentPrice(pnu, parts) : null) ?? (await fetchApartment(parts)), cacheable: true };
      } catch (err) {
        if (!cacheableCode(sourceError(err))) throw err;
        return { value: null, cacheable: true };
      }
    }, 'record'),
    house: (pnu) => cachedLookup('house', pnu, async () => {
      try {
        return { value: await fetchHouse(pnu), cacheable: true };
      } catch (err) {
        if (!cacheableCode(sourceError(err))) throw err;
        return { value: null, cacheable: true };
      }
    }, 'record'),
    land: (jibun) => cachedLookup('gongsijiga', jibun, async () => {
      try {
        return { value: await fetchLand(jibun), cacheable: true };
      } catch (err) {
        if (!cacheableCode(sourceError(err))) throw err;
        return { value: null, cacheable: true };
      }
    }, 'record'),
  };
}

let defaultSources: PublicRecordSources | null = null;

/** 분석 루프용. KSKILL_ENRICH=off 면 네트워크를 치지 않는다. */
/**
 * 주소→필지 변환 결과에서 읽은 시군구 코드와 법정동.
 * '화성시 떡전골로 84-17'처럼 동이 없는 도로명 주소는 주소 표(lawd-codes)로 구·동을 고를 수 없다.
 */
export async function parcelLocality(address: string): Promise<{ lawdCd: string; dong?: string } | null> {
  if (process.env.KSKILL_ENRICH === 'off') return null;
  defaultSources ??= defaultPublicRecordSources();
  const parts = parseAuctionAddress(address);
  const geo = await defaultSources.geocode(parts.isJibun ? parts.jibun : stripToJibun(address));
  if (!geo) return null;
  return { lawdCd: geo.pnu.slice(0, 5), dong: geo.jibun ? extractDong(geo.jibun) : undefined };
}

export async function enrichListingRecords(
  listing: { address: string; propertyType: PropertyType },
  existing: { gongPrice?: number; building?: BuildingInfo },
): Promise<PublicRecordEnrichment> {
  if (process.env.KSKILL_ENRICH === 'off') return { notes: [] };
  defaultSources ??= defaultPublicRecordSources();
  return enrichMissingRecords(listing, existing, defaultSources);
}
