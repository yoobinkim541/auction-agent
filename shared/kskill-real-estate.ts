/**
 * k-skill `real-estate-search` 공개 프록시 → 기존 MOLIT 파서 필드.
 * 사용자 API 키 없음. 자체 MOLIT 키가 없거나 쿼터/장애일 때의 폴백이고,
 * 단독·상업은 개발키에 활용신청이 없는 경우가 많아 자체 호출 없이 프록시만 쓴다.
 */
const PROXY_BASE = (process.env.KSKILL_PROXY_BASE_URL ?? 'https://k-skill-proxy.nomadamas.org').replace(/\/$/, '');
const UA = 'gyeongmae-agent/0.1 (personal auction research; k-skill real-estate fallback)';
const FAIL_CIRCUIT = 3;
// 프록시는 IP 기준 1분 창으로 요청 수를 세고, 넘으면 429와 retry_after_ms 를 준다(2026-11 실측: 약 180건/분).
// 동시 요청이 몰리면 상위 API 가 502 를 낸다. 요청 시작 간격을 띄우고, 429·5xx 는 쉬었다 다시 보낸다.
const MIN_INTERVAL_MS = Number(process.env.KSKILL_PROXY_INTERVAL_MS ?? 400);
const RATE_RETRIES = 2;
const RATE_WAIT_MAX_MS = 65_000;
const SERVER_RETRY_MS = 2_000;

const ENDPOINT_PATH: Record<string, string> = {
  RTMSDataSvcAptTrade: 'apartment/trade',
  RTMSDataSvcAptRent: 'apartment/rent',
  RTMSDataSvcRHTrade: 'villa/trade',
  RTMSDataSvcRHRent: 'villa/rent',
  RTMSDataSvcOffiTrade: 'officetel/trade',
  RTMSDataSvcOffiRent: 'officetel/rent',
  RTMSDataSvcSHTrade: 'single-house/trade',
  RTMSDataSvcSHRent: 'single-house/rent',
  RTMSDataSvcNrgTrade: 'commercial/trade',
};

const PROXY_ONLY_ENDPOINTS: Record<string, true> = {
  RTMSDataSvcSHTrade: true,
  RTMSDataSvcSHRent: true,
  RTMSDataSvcNrgTrade: true,
};

let proxyDown = false;
let proxyFail = 0;
let nextSlot = 0;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function retryAfterMs(res: Response): Promise<number> {
  const body: unknown = await res.json().catch(() => null);
  const wait = body && typeof body === 'object' && 'retry_after_ms' in body ? Number(body.retry_after_ms) : NaN;
  return Math.min(Number.isFinite(wait) && wait > 0 ? wait : RATE_WAIT_MAX_MS, RATE_WAIT_MAX_MS);
}

/**
 * 프록시 요청은 전부 이 문을 지난다(실거래·주소→필지·건축물대장이 같은 한도를 나눠 쓴다).
 * 끝까지 429·5xx 면 그 응답을 돌려준다.
 */
export async function requestKskillProxy(url: URL | string, timeoutMs: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + MIN_INTERVAL_MS;
    if (slot > now) await sleep(slot - now);
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (attempt >= RATE_RETRIES || (res.status !== 429 && res.status < 500)) return res;
    // 429 는 창이 풀릴 때까지 모든 요청을 세운다.
    nextSlot = Math.max(nextSlot, Date.now() + (res.status === 429 ? await retryAfterMs(res) : SERVER_RETRY_MS));
  }
}

export function resetKskillProxyCircuit(): void {
  proxyDown = false;
  proxyFail = 0;
}

export function proxyPathForEndpoint(ep: string): string | null {
  return ENDPOINT_PATH[ep] ?? null;
}

/** 자체 MOLIT 호출을 건너뛸지. 키 없음·쿼터·단독/상업. */
export function skipOwnMolit(ep: string, hasKey: boolean, quotaHit: boolean): boolean {
  return !hasKey || quotaHit || ep in PROXY_ONLY_ENDPOINTS;
}

export function molitFallbackEnabled(): boolean {
  return process.env.KSKILL_MOLIT_FALLBACK !== 'off';
}

export interface ProxyDealItem {
  name?: string;
  district?: string;
  area_m2?: number;
  floor?: number;
  price_10k?: number;
  deposit_10k?: number;
  monthly_rent_10k?: number;
  deal_date?: string;
  build_year?: number;
  deal_type?: string;
}

function isProxyDealItem(value: unknown): value is ProxyDealItem {
  return !!value && typeof value === 'object';
}

/** 프록시 1건 → MOLIT item. 날짜·금액이 없으면 null(캐시에 오염 행을 넣지 않음). */
export function proxyDealToMolitItem(item: ProxyDealItem, deal: 'trade' | 'rent'): Record<string, string | number> | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.deal_date ?? '');
  if (!date || !item.area_m2 || item.area_m2 <= 0) return null;
  const base: Record<string, string | number> = {
    aptNm: item.name?.trim() ?? '',
    umdNm: item.district?.trim() ?? '',
    excluUseAr: item.area_m2,
    dealYear: date[1]!,
    dealMonth: String(Number(date[2])),
    dealDay: String(Number(date[3])),
  };
  if (item.floor != null) base.floor = item.floor;
  if (item.build_year != null) base.buildYear = item.build_year;
  if (item.deal_type) base.dealingGbn = item.deal_type.trim();
  if (deal === 'rent') {
    if (!item.deposit_10k || item.deposit_10k <= 0) return null;
    base.deposit = String(item.deposit_10k);
    base.monthlyRent = String(item.monthly_rent_10k ?? 0);
    return base;
  }
  if (!item.price_10k || item.price_10k <= 0) return null;
  base.dealAmount = String(item.price_10k);
  return base;
}

/** 프록시 JSON → MOLIT items. 형식이 아니면 null(실패). 빈 배열은 해당 월 거래 없음. */
export function mapProxyPayload(payload: unknown, deal: 'trade' | 'rent'): Record<string, string | number>[] | null {
  if (!payload || typeof payload !== 'object' || !('items' in payload) || !Array.isArray(payload.items)) return null;
  if ('filtered_count' in payload && typeof payload.filtered_count === 'number' && payload.filtered_count > payload.items.length) {
    console.warn(`[kskill] 실거래 응답이 잘림 ${payload.items.length}/${payload.filtered_count} — 받은 건만 사용`);
  }
  const mapped: Record<string, string | number>[] = [];
  for (const item of payload.items) {
    if (!isProxyDealItem(item)) continue;
    const row = proxyDealToMolitItem(item, deal);
    if (row) mapped.push(row);
  }
  return mapped;
}

function bumpProxy(): void {
  proxyFail += 1;
  if (proxyFail >= FAIL_CIRCUIT && !proxyDown) {
    proxyDown = true;
    console.warn('[kskill] 실거래 프록시 연속 실패 — 이번 실행은 자체 MOLIT/캐시만 사용');
  }
}

/**
 * 법정동·월 실거래. null = 프록시 사용 불가(끄기·회로·네트워크).
 * 빈 배열 = 조회 성공, 거래 없음.
 */
export async function fetchKskillDeals(ep: string, lawdCd: string, ym: string): Promise<Record<string, string | number>[] | null> {
  const path = proxyPathForEndpoint(ep);
  if (!path || !molitFallbackEnabled() || proxyDown) return null;
  const deal = path.endsWith('/rent') ? 'rent' : 'trade';
  const url = new URL(`${PROXY_BASE}/v1/real-estate/${path}`);
  url.searchParams.set('lawd_cd', lawdCd);
  url.searchParams.set('deal_ymd', ym);
  url.searchParams.set('num_of_rows', '1000'); // 기본 100행에서 잘린다. 프록시 상한 1000, 쪽 넘김 없음(page_no 무시) — 1000건 넘는 달은 잘린다
  try {
    const res = await requestKskillProxy(url, 12_000);
    if (!res.ok) {
      bumpProxy();
      return null;
    }
    const mapped = mapProxyPayload(await res.json(), deal);
    if (!mapped) {
      bumpProxy();
      return null;
    }
    proxyFail = 0;
    return mapped;
  } catch {
    bumpProxy();
    return null;
  }
}
