/**
 * 국토부(MOLIT) 실거래 원자료의 DB 영구 캐시 — 법정동·월 단위.
 *
 * 왜: 개발계정 일일 호출쿼터(보통 1만)가 작아, 1100여 건 전체 재분석이 매번 같은 법정동/월을
 *   반복 조회해 쿼터를 소진(429)했다. 과거 월의 매매·전월세 신고는 사실상 불변이므로,
 *   한 번 받은 (엔드포인트·LAWD_CD·년월) 원자료를 gm_molit_cache 에 영구 저장하고 재사용한다.
 *   → 두 번째 실행부터는 API 호출이 거의 0 → 쿼터 안전 + 차단/타임아웃 중에도 캐시로 분석 가능.
 *
 * 회로차단(circuit breaker):
 *   - 429(쿼터초과) 1회 → 이후 API 호출 중단, DB 캐시만 사용.
 *   - 연속 타임아웃/5xx N회 → 스로틀/장애로 보고 중단(전월세 엔드포인트가 429 대신 행에 빠지는 현상 대비).
 */
import { query } from './db.ts';

const MOLIT_BASE = 'https://apis.data.go.kr/1613000';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const RECENT_MONTHS = 3; // 최근 3개월은 신고지연(30일+)으로 갱신 대상
const RECENT_TTL_MS = 7 * 86_400_000; // 최근 월 캐시는 7일 후 갱신
const FAIL_CIRCUIT = 5; // 연속 실패 임계 — 초과 시 API 호출 중단
const REQ_TIMEOUT_MS = 15_000;

let _quotaHit = false; // 429 또는 회로차단 시 true
let _consecFail = 0;
let _ensured = false;
const _mem = new Map<string, Promise<unknown[] | null>>(); // 프로세스 내 중복 호출 dedup

export function molitQuotaHit(): boolean {
  return _quotaHit;
}
/** 새 프로세스/테스트에서 회로 상태 초기화 */
export function resetMolitCircuit(): void {
  _quotaHit = false;
  _consecFail = 0;
  _mem.clear();
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

async function _fetch(ep: string, lawdCd: string, ym: string): Promise<unknown[] | null> {
  const key = process.env.MOLIT_SERVICE_KEY;
  await ensureTable();
  const cached = await readCache(ep, lawdCd, ym);
  if (cached) {
    const fresh = !isRecentMonth(ym) || Date.now() - new Date(cached.fetched_at).getTime() < RECENT_TTL_MS;
    if (fresh) return cached.items ?? [];
  }
  // 캐시 없음/만료 → API. 쿼터차단·키없음이면 (만료라도) 있던 캐시 폴백.
  if (!key || _quotaHit) return cached ? (cached.items ?? []) : null;

  const url = `${MOLIT_BASE}/${ep}/get${ep}?serviceKey=${encodeURIComponent(key)}&LAWD_CD=${lawdCd}&DEAL_YMD=${ym}&numOfRows=1000&pageNo=1&_type=json`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
    if (res.status === 429) {
      _quotaHit = true;
      console.warn('[molit] 일일 쿼터 초과(429) — 이후 DB 캐시만 사용');
      return cached ? (cached.items ?? []) : null;
    }
    if (!res.ok) {
      if (res.status >= 500) bumpFail();
      return cached ? (cached.items ?? []) : null;
    }
    const json = (await res.json()) as { response?: { body?: { items?: { item?: unknown } } } };
    const raw = json?.response?.body?.items?.item;
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    _consecFail = 0;
    await query(
      `insert into gm_molit_cache (ep, lawd_cd, ym, items, n, fetched_at)
       values ($1,$2,$3,$4::jsonb,$5,now())
       on conflict (ep, lawd_cd, ym) do update set items=excluded.items, n=excluded.n, fetched_at=now()`,
      [ep, lawdCd, ym, JSON.stringify(items), items.length],
    );
    return items;
  } catch {
    bumpFail(); // 타임아웃 등 — 전월세 엔드포인트가 429 대신 행에 빠지는 경우 회로 차단
    return cached ? (cached.items ?? []) : null;
  }
}

function bumpFail(): void {
  _consecFail += 1;
  if (_consecFail >= FAIL_CIRCUIT && !_quotaHit) {
    _quotaHit = true;
    console.warn(`[molit] 연속 실패 ${_consecFail}회 — API 호출 중단(스로틀/장애 추정), DB 캐시만 사용`);
  }
}
