/**
 * 입지분석: 지오코딩(카카오) → 실거래가(국토부) 기반 안전마진 + 주변 POI.
 * 외부 키가 없으면 해당 신호는 null로 비우고 진행(graceful degradation).
 */
import type { Listing, LocationAnalysis, Comparable, PropertyType } from '../../shared/types.ts';
import { addressToLawdCd } from './lawd-codes.ts';
import { fetchMolitRaw, molitQuotaHit } from '../../shared/molit-cache.ts';

const KAKAO = 'https://dapi.kakao.com/v2/local';
// 국토부 실거래가 — 물건종류별 base 엔드포인트(DB 캐시는 shared/molit-cache 가 담당)
const MOLIT_ENDPOINT: Partial<Record<PropertyType, string>> = {
  apartment: 'RTMSDataSvcAptTrade',   // 아파트 매매
  villa: 'RTMSDataSvcRHTrade',        // 연립다세대 매매
  officetel: 'RTMSDataSvcOffiTrade',  // 오피스텔 매매(승인 시)
};

interface GeocodeResult {
  lat: number;
  lng: number;
  roadAddress?: string;
  lawdCd?: string; // 법정동코드 앞 5자리(LAWD_CD)
  bCode?: string;
}

async function kakaoGeocode(address: string): Promise<GeocodeResult | null> {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return null;
  const res = await fetch(`${KAKAO}/search/address.json?query=${encodeURIComponent(address)}`, {
    headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    documents: { x: string; y: string; address?: { b_code?: string }; road_address?: { address_name?: string } }[];
  };
  const d = j.documents?.[0];
  if (!d) return null;
  const bCode = d.address?.b_code;
  return {
    lat: parseFloat(d.y),
    lng: parseFloat(d.x),
    roadAddress: d.road_address?.address_name,
    bCode,
    lawdCd: bCode ? bCode.slice(0, 5) : undefined,
  };
}

/** 국토부 매매 실거래가(최근 N개월) — DB 영구 캐시(shared/molit-cache) 경유로 쿼터 절약. */
async function molitTrades(propertyType: PropertyType, lawdCd: string, months: number): Promise<Comparable[]> {
  const ep = MOLIT_ENDPOINT[propertyType];
  if (!ep) return [];
  const out: Comparable[] = [];
  for (const ym of recentYearMonths(months)) {
    const items = await fetchMolitRaw(ep, lawdCd, ym);
    if (items === null) { if (molitQuotaHit()) break; else continue; } // 쿼터/장애 → 중단
    out.push(...parseMolitJson(items as MolitItem[]));
  }
  return out;
}

interface MolitItem {
  dealAmount?: string; excluUseAr?: number | string;
  dealYear?: number | string; dealMonth?: number | string; dealDay?: number | string;
  floor?: number | string; buildYear?: number | string; umdNm?: string;
  aptNm?: string; mhouseNm?: string; offiNm?: string;
}
interface MolitResponse { response?: { body?: { items?: { item?: MolitItem | MolitItem[] } } } }

function parseMolitJson(item: MolitItem | MolitItem[] | undefined): Comparable[] {
  const items = Array.isArray(item) ? item : item ? [item] : [];
  const comps: Comparable[] = [];
  for (const it of items) {
    const dealAmount = parseInt(String(it.dealAmount ?? '').replace(/[^0-9]/g, ''), 10) * 10_000; // 만원→원
    const areaM2 = parseFloat(String(it.excluUseAr ?? ''));
    if (!dealAmount || !areaM2) continue;
    const name = it.aptNm || it.mhouseNm || it.offiNm;
    comps.push({
      apartmentName: name?.trim() || undefined,
      dong: it.umdNm?.trim() || undefined,
      areaM2,
      dealAmount,
      dealDate: `${it.dealYear}-${String(it.dealMonth ?? 1).padStart(2, '0')}-${String(it.dealDay ?? 1).padStart(2, '0')}`,
      floor: it.floor != null ? parseInt(String(it.floor), 10) : undefined,
      buildYear: it.buildYear != null ? parseInt(String(it.buildYear), 10) : undefined,
    });
  }
  return comps;
}

/** 주소에서 법정동(예: 천호동) 추출 */
function extractDong(addr: string): string | undefined {
  const parts = addr.replace(/[,()]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (/[구군]$/.test(parts[i]!) && /[동읍면리가]$/.test(parts[i + 1]!)) return parts[i + 1];
  }
  return parts.find((p) => /[동읍면]$/.test(p) && p.length >= 2 && !/[구군시]$/.test(p));
}

/** 주소의 "(동,단지명)" 패턴에서 건물명 추출 */
function extractBuildingName(addr: string): string | undefined {
  const m = addr.match(/\([^,)]*,\s*([^)]+)\)/);
  return m ? m[1]!.trim() : undefined;
}

function recentYearMonths(months: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

interface Estimate { marketPrice: number | null; used: Comparable[]; confidence: 'high' | 'medium' | 'low' | null; basis: string }

/**
 * 비교군을 동일건물 → 법정동+면적 → 법정동 → 구+면적 순으로 좁혀 시세 추정.
 * 빌라(연립다세대)는 단지가 이질적이라 '구 전체 중위값'은 부정확 → 법정동·면적 매칭을 우선하고
 * 매칭 수준을 confidence로 표기. 최근 거래 우선.
 */
function estimateMarketPrice(
  comps: Comparable[],
  opts: { areaM2?: number; dong?: string; buildingName?: string },
): Estimate {
  const recent = [...comps].sort((a, b) => (a.dealDate < b.dealDate ? 1 : -1)); // 최근 우선
  const areaOk = (c: Comparable) => !opts.areaM2 || Math.abs(c.areaM2 - opts.areaM2) <= opts.areaM2 * 0.15;
  const dongOk = (c: Comparable) => !!opts.dong && !!c.dong && c.dong.includes(opts.dong);
  const nameOk = (c: Comparable) =>
    !!opts.buildingName && !!c.apartmentName && c.apartmentName.replace(/\s/g, '').includes(opts.buildingName.replace(/\s/g, ''));

  const tiers: { basis: string; conf: 'high' | 'medium' | 'low'; sel: Comparable[]; need: number }[] = [];
  if (opts.buildingName) tiers.push({ basis: `'${opts.buildingName}' 동일건물·면적`, conf: 'high', need: 2, sel: recent.filter((c) => nameOk(c) && areaOk(c)) });
  if (opts.dong) tiers.push({ basis: `${opts.dong}·면적`, conf: 'high', need: 3, sel: recent.filter((c) => dongOk(c) && areaOk(c)) });
  if (opts.dong) tiers.push({ basis: `${opts.dong} 전체`, conf: 'medium', need: 3, sel: recent.filter((c) => dongOk(c)) });
  tiers.push({ basis: '구 전체·면적', conf: 'low', need: 3, sel: recent.filter((c) => areaOk(c)) });

  for (const t of tiers) {
    if (t.sel.length >= t.need) {
      const used = t.sel.slice(0, 20);
      return { marketPrice: median(used.map((c) => c.dealAmount)), used, confidence: t.conf, basis: `${t.basis} ${used.length}건` };
    }
  }
  return { marketPrice: null, used: [], confidence: null, basis: '비교군 부족' };
}

async function kakaoCategoryCount(code: string, lat: number, lng: number, radius: number): Promise<number> {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return 0;
  const res = await fetch(
    `${KAKAO}/search/category.json?category_group_code=${code}&x=${lng}&y=${lat}&radius=${radius}&size=15`,
    { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(12000) },
  );
  if (!res.ok) return 0;
  const j = (await res.json()) as { meta?: { total_count?: number } };
  return j.meta?.total_count ?? 0;
}

async function nearestStation(lat: number, lng: number): Promise<{ name?: string; distanceM?: number } | null> {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return null;
  const res = await fetch(
    `${KAKAO}/search/category.json?category_group_code=SW8&x=${lng}&y=${lat}&radius=1500&sort=distance&size=1`,
    { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(12000) },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as { documents: { place_name: string; distance: string }[] };
  const d = j.documents?.[0];
  return d ? { name: d.place_name, distanceM: parseInt(d.distance, 10) } : null;
}

export interface LocationOptions {
  buildingName?: string;
  tradeMonths?: number; // 실거래 조회 기간(개월)
}

export async function analyzeLocation(listing: Listing, opts: LocationOptions = {}): Promise<LocationAnalysis> {
  const geo = listing.lat && listing.lng
    ? { lat: listing.lat, lng: listing.lng, lawdCd: addressToLawdCd(listing.address) }
    : await kakaoGeocode(listing.roadAddress || listing.address);

  // 카카오 지오코딩이 없어도 주소→법정동코드 테이블로 LAWD_CD 확보(안전마진용)
  const lawdCd = geo?.lawdCd ?? addressToLawdCd(listing.address);

  let comps: Comparable[] = [];
  let marketPrice: number | null = null;
  let marketConfidence: LocationAnalysis['marketConfidence'] = null;
  let compBasis: string | undefined;
  if (lawdCd && MOLIT_ENDPOINT[listing.propertyType]) {
    const all = await molitTrades(listing.propertyType, lawdCd, opts.tradeMonths ?? 12);
    const dong = extractDong(listing.address);
    const buildingName = opts.buildingName ?? extractBuildingName(listing.address);
    const est = estimateMarketPrice(all, { areaM2: listing.areaM2, dong, buildingName });
    comps = est.used;
    marketPrice = est.marketPrice;
    marketConfidence = est.confidence;
    compBasis = est.basis;
  }

  const safetyMargin =
    marketPrice && marketPrice > 0 && listing.minBidPrice
      ? (marketPrice - listing.minBidPrice) / marketPrice
      : null;

  let transit, schools, amenities;
  if (geo) {
    const station = await nearestStation(geo.lat, geo.lng);
    transit = station ? { nearestStation: station.name, walkMinutes: station.distanceM ? Math.round(station.distanceM / 80) : undefined } : undefined;
    const [mart, conv, hosp, pharm, cafe, academy, school] = await Promise.all([
      kakaoCategoryCount('MT1', geo.lat, geo.lng, 1000),
      kakaoCategoryCount('CS2', geo.lat, geo.lng, 500),
      kakaoCategoryCount('HP8', geo.lat, geo.lng, 1000),
      kakaoCategoryCount('PM9', geo.lat, geo.lng, 500),
      kakaoCategoryCount('CE7', geo.lat, geo.lng, 500),
      kakaoCategoryCount('AC5', geo.lat, geo.lng, 1000),
      kakaoCategoryCount('SC4', geo.lat, geo.lng, 1000),
    ]);
    amenities = { mart, convenience: conv, hospital: hosp, pharmacy: pharm, cafe };
    schools = { academyCount: academy, schoolCount: school };
  }

  return {
    caseNo: listing.caseNo,
    marketPrice,
    comps,
    marketConfidence,
    compBasis,
    safetyMargin,
    transit,
    schools,
    amenities,
  };
}
