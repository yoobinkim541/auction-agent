/**
 * 국토부(MOLIT) 실거래 원자료의 DB 영구 캐시 — 법정동·월 단위.
 *
 * 왜: 개발계정 일일 호출쿼터(보통 1만)가 작아, 1100여 건 전체 재분석이 매번 같은 법정동/월을
 *   반복 조회해 쿼터를 소진(429)했다. 과거 월의 매매·전월세 신고는 사실상 불변이므로,
 *   한 번 받은 (엔드포인트·LAWD_CD·년월) 원자료를 gm_molit_cache 에 영구 저장하고 재사용한다.
 *   → 두 번째 실행부터는 API 호출이 거의 0 → 쿼터 안전 + 차단/타임아웃 중에도 캐시로 분석 가능.
 *
 *   - 429가 간격을 띄운 재시도 뒤에도 이어지면(쿼터초과) → 이후 자체 API 호출 중단. k-skill 프록시가 있으면 그쪽으로 폴백 후 같은 캐시에 적재.
 *   - 연속 타임아웃/5xx N회 → 스로틀/장애로 보고 자체 API 중단(전월세 엔드포인트가 429 대신 행에 빠지는 현상 대비).
 *   - 단독·상업(SH/Nrg 엔드포인트)은 개발키 활용신청이 없는 경우가 많아 자체 호출 없이 프록시만 쓴다.
 */
import { fetchKskillDeals, resetKskillProxyCircuit, skipOwnMolit } from './kskill-real-estate.ts';
import { query } from './db.ts';

const MOLIT_BASE = 'https://apis.data.go.kr/1613000';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const RECENT_MONTHS = 3; // 최근 3개월은 신고지연(30일+)으로 갱신 대상
const RECENT_TTL_MS = 7 * 86_400_000; // 최근 월 캐시는 7일 후 갱신
const FAIL_CIRCUIT = 5; // 연속 실패 임계 — 초과 시 API 호출 중단
const REQ_TIMEOUT_MS = 15_000;
// 게이트웨이는 초당 수십 건을 넘기면 429로 막고 1초쯤 뒤 풀린다(2026-11 재현: 4.5초에 300건 → 265건 429).
// 일일 쿼터 소진과 응답 코드가 같아, 간격을 띄우고 몇 번 다시 보낸 뒤에도 429일 때만 쿼터로 본다.
const MIN_INTERVAL_MS = 50;
const RATE_RETRIES = 3;
const RATE_BACKOFF_MS = 1_000;

let _quotaHit = false; // 429 또는 회로차단 시 true
let _consecFail = 0;
let _ensured = false;
let _nextSlot = 0;
const _blockedEps = new Set<string>(); // 활용신청이 안 된 엔드포인트(401/403) — 이번 실행에선 다시 부르지 않는다
const _mem = new Map<string, Promise<unknown[] | null>>(); // 프로세스 내 중복 호출 dedup

export function molitQuotaHit(): boolean {
  return _quotaHit;
}
/** 새 프로세스/테스트에서 회로 상태 초기화 */
export function resetMolitCircuit(): void {
  _quotaHit = false;
  _consecFail = 0;
  _nextSlot = 0;
  _blockedEps.clear();
  _mem.clear();
  resetKskillProxyCircuit();
}

async function ensureTable(): Promise<void> {
  if (_ensured) return;
  await query(
    `create table if not exists gm_molit_cache (
       ep        text        not null,
       lawd_cd   text        not null,
       ym        text        not null,
       items     jsonb       not null default '[]'::jsonb,
       n         int         not null default 0,
       fetched_at timestamptz not null default now(),
       primary key (ep, lawd_cd, ym)
     )`,
  );
  _ensured = true;
}

function currentYmNum(): number {
  const d = new Date();
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}
/** ym(YYYYMM)이 최근 RECENT_MONTHS 개월(현재월 포함) 이내인가 — 신고지연 갱신 판단 */
function isRecentMonth(ym: string): boolean {
  const y = parseInt(ym.slice(0, 4), 10);
  const m = parseInt(ym.slice(4, 6), 10);
  const cur = currentYmNum();
  const dist = (Math.floor(cur / 100) - y) * 12 + (cur % 100) - m;
  return dist >= 0 && dist < RECENT_MONTHS;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 요청 간격을 띄워 보내고, 429는 잠깐 쉬었다 다시 보낸다. 끝까지 429면 그 응답을 돌려준다. */
async function requestMolit(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const slot = Math.max(now, _nextSlot);
    _nextSlot = slot + MIN_INTERVAL_MS;
    if (slot > now) await sleep(slot - now);
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
    if (res.status !== 429 || attempt >= RATE_RETRIES) return res;
    await sleep(RATE_BACKOFF_MS * (attempt + 1));
  }
}

interface CacheRow {
  items: unknown[] | null;
  fetched_at: string;
}

async function readCache(ep: string, lawdCd: string, ym: string): Promise<CacheRow | null> {
  const r = await query<CacheRow>(
    'select items, fetched_at from gm_molit_cache where ep=$1 and lawd_cd=$2 and ym=$3',
    [ep, lawdCd, ym],
  );
  return r[0] ?? null;
}

/**
 * 법정동·월 MOLIT 원자료(items 배열)를 반환. DB 영구 캐시 우선, 없거나 만료 시 API 조회 후 적재.
 * 반환 null = 캐시도 없고 API도 사용불가(쿼터/장애). 빈 배열 = 해당 월 거래 없음(유효).
 */
export async function fetchMolitRaw(ep: string, lawdCd: string, ym: string): Promise<unknown[] | null> {
  const k = `${ep}:${lawdCd}:${ym}`;
  const memo = _mem.get(k);
  if (memo) return memo;
  const p = _fetch(ep, lawdCd, ym);
  _mem.set(k, p);
  return p;
}

async function writeCache(ep: string, lawdCd: string, ym: string, items: unknown[]): Promise<void> {
  await query(
    `insert into gm_molit_cache (ep, lawd_cd, ym, items, n, fetched_at)
     values ($1,$2,$3,$4::jsonb,$5,now())
     on conflict (ep, lawd_cd, ym) do update set items=excluded.items, n=excluded.n, fetched_at=now()`,
    [ep, lawdCd, ym, JSON.stringify(items), items.length],
  );
}

/** 한 쪽 1000행. 강남·송파 전월세는 한 달에 1000건을 넘어 쪽을 넘겨야 다 온다(2026-10 강남 아파트 전월세 1,314건). */
const OWN_PAGE_ROWS = 1000;
const OWN_MAX_PAGES = 10;

async function fetchOwn(ep: string, lawdCd: string, ym: string, key: string): Promise<unknown[] | null> {
  const items: unknown[] = [];
  for (let pageNo = 1; pageNo <= OWN_MAX_PAGES; pageNo++) {
    const page = await fetchOwnPage(ep, lawdCd, ym, key, pageNo);
    if (!page) return null; // 일부 쪽만 받은 결과는 저장하지 않는다
    items.push(...page.items);
    if (page.items.length < OWN_PAGE_ROWS || items.length >= page.totalCount) break;
  }
  _consecFail = 0;
  await writeCache(ep, lawdCd, ym, items);
  return items;
}

async function fetchOwnPage(ep: string, lawdCd: string, ym: string, key: string, pageNo: number): Promise<{ items: unknown[]; totalCount: number } | null> {
  const url = `${MOLIT_BASE}/${ep}/get${ep}?serviceKey=${encodeURIComponent(key)}&LAWD_CD=${lawdCd}&DEAL_YMD=${ym}&numOfRows=${OWN_PAGE_ROWS}&pageNo=${pageNo}&_type=json`;
  try {
    const res = await requestMolit(url);
    if (res.status === 429) {
      _quotaHit = true;
      console.warn('[molit] 일일 쿼터 초과(429) — k-skill 프록시/캐시 폴백');
      return null;
    }
    if (!res.ok) {
      if (res.status >= 500) bumpFail();
      if ((res.status === 401 || res.status === 403) && !_blockedEps.has(ep)) {
        // 미승인 엔드포인트를 매물마다 다시 부르면 그 실패 호출이 초당 제한을 넘겨 다른 엔드포인트까지 429로 막힌다
        _blockedEps.add(ep);
        console.warn(`[molit] ${ep} 미승인(${res.status}) — 이번 실행은 호출 생략`);
      }
      return null;
    }
    const json = (await res.json()) as { response?: { body?: { totalCount?: number; items?: { item?: unknown } } } };
    const raw = json?.response?.body?.items?.item;
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return { items, totalCount: Number(json?.response?.body?.totalCount ?? items.length) };
  } catch {
    bumpFail(); // 타임아웃 등 — 전월세 엔드포인트가 429 대신 행에 빠지는 경우 회로 차단
    return null;
  }
}

async function _fetch(ep: string, lawdCd: string, ym: string): Promise<unknown[] | null> {
  const key = process.env.MOLIT_SERVICE_KEY;
  await ensureTable();
  const cached = await readCache(ep, lawdCd, ym);
  if (cached) {
    const fresh = !isRecentMonth(ym) || Date.now() - new Date(cached.fetched_at).getTime() < RECENT_TTL_MS;
    if (fresh) return cached.items ?? [];
  }
  if (!skipOwnMolit(ep, !!key, _quotaHit) && key && !_blockedEps.has(ep)) {
    const own = await fetchOwn(ep, lawdCd, ym, key);
    if (own) return own;
  }
  const proxied = await fetchKskillDeals(ep, lawdCd, ym);
  if (proxied) {
    await writeCache(ep, lawdCd, ym, proxied);
    return proxied;
  }
  return cached ? (cached.items ?? []) : null;
}

function bumpFail(): void {
  _consecFail += 1;
  if (_consecFail >= FAIL_CIRCUIT && !_quotaHit) {
    _quotaHit = true;
    console.warn(`[molit] 연속 실패 ${_consecFail}회 — API 호출 중단(스로틀/장애 추정), DB 캐시만 사용`);
  }
}
