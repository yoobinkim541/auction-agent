/**
 * 대법원 법원경매정보(courtauction.go.kr) 어댑터.
 *
 * ─ API 구조 (역공학으로 확인) ──────────────────────────────────────────────
 *  메인: GET  /pgj/index.on                          → 세션 쿠키 취득
 *  목록: POST /pgj/pgjsearch/searchControllerMain.on → [{pageInfo},{srchInfo}]
 *  상세: POST /pgj/pgj15B/selectAuctnCsSrchRslt.on  → {csNo,cortOfcCd,...}
 *
 * ─ IP 차단 탐지 ──────────────────────────────────────────────────────────
 *  응답 JSON.data.ipcheck === false  →  CourtAuctionBlockedError
 *
 * ─ 폴라이트 정책 ──────────────────────────────────────────────────────────
 *  최소 2500ms 전역 간격 (rateGate) · 매물마다 4-10s 읽기 지연 · 중간 휴식.
 *  Playwright 없이 node fetch로 동작(세션 쿠키 수동 관리).
 *
 * ⚠️  Oracle VM IP는 차단됨 → 로컬 PC / Raspberry Pi / SSH 프록시에서 실행 필요.
 *     npm run crawl 실행 전 `ssh -D 1080 pi@home` 등으로 SOCKS5 터널 세팅 권장.
 *
 * ─ 제공 데이터 ────────────────────────────────────────────────────────────
 *  사건번호, 법원, 소재지, 용도, 감정가, 최저가, 유찰횟수, 매각기일 (기본 메타)
 *  면적, 건물 표제부 (상세 호출 시)
 *  등기·임차인·매각효력·실거래 없음 (deonakchal만 제공)
 */
import type { Adapter, CrawlFilter, CrawlSink, ScrapedListing } from './types.ts';
import type { Listing, RegistryEntry, Tenant, ListingDoc } from '../../shared/types.ts';
import { parseKoreanDate, normalizeCaseNo, mapRightKind } from '../normalize.ts';
import { courtAuctionFetch } from '../proxy.ts'; // COURTAUCTION_PROXY 전용 egress — 더낙찰 CRAWL_PROXY와 분리

const BASE = 'https://www.courtauction.go.kr';
const UA = 'gyeongmae-agent/0.1 (personal research; contact: owner)';
// 검색 입찰기일 범위(오늘~+N일, KST). 30일은 서울·경기 진행 물건을 크게 누락해 기본 180일로 넓힌다.
const COURT_BID_START_OFFSET_DAYS = parseInt(process.env.COURT_BID_START_OFFSET_DAYS ?? '0', 10) || 0;
const COURT_BID_DAYS = Math.max(1, parseInt(process.env.COURT_BID_DAYS ?? '180', 10) || 180);
const COURT_PAGE_SIZE = Math.max(1, parseInt(process.env.COURT_PAGE_SIZE ?? '40', 10) || 40);
const MIN_REQ_INTERVAL_MS = Math.max(250, parseInt(process.env.COURT_MIN_REQ_INTERVAL_MS ?? '2500', 10) || 2500);
const REQ_TIMEOUT_MS = Math.max(1000, parseInt(process.env.COURT_REQ_TIMEOUT_MS ?? '20000', 10) || 20000);
const PAGE_DWELL_MIN_MS = Math.max(0, parseInt(process.env.COURT_PAGE_DWELL_MIN_MS ?? '3000', 10) || 3000);
const PAGE_DWELL_MAX_MS = Math.max(PAGE_DWELL_MIN_MS, parseInt(process.env.COURT_PAGE_DWELL_MAX_MS ?? '7000', 10) || 7000);
const DETAIL_DWELL_MIN_MS = Math.max(0, parseInt(process.env.COURT_DETAIL_DWELL_MIN_MS ?? '4000', 10) || 4000);
const DETAIL_DWELL_MAX_MS = Math.max(DETAIL_DWELL_MIN_MS, parseInt(process.env.COURT_DETAIL_DWELL_MAX_MS ?? '10000', 10) || 10000);
const DETAIL_LONG_DWELL_CHANCE = Math.max(0, Math.min(1, Number(process.env.COURT_DETAIL_LONG_DWELL_CHANCE ?? '0.12')));
const DETAIL_LONG_DWELL_MIN_MS = Math.max(DETAIL_DWELL_MAX_MS, parseInt(process.env.COURT_DETAIL_LONG_DWELL_MIN_MS ?? '15000', 10) || 15000);
const DETAIL_LONG_DWELL_MAX_MS = Math.max(DETAIL_LONG_DWELL_MIN_MS, parseInt(process.env.COURT_DETAIL_LONG_DWELL_MAX_MS ?? '28000', 10) || 28000);
const BREAK_EVERY_MIN = Math.max(1, parseInt(process.env.COURT_BREAK_EVERY_MIN ?? '40', 10) || 40);
const BREAK_EVERY_MAX = Math.max(BREAK_EVERY_MIN, parseInt(process.env.COURT_BREAK_EVERY_MAX ?? '60', 10) || 60);
const BREAK_DWELL_MIN_MS = Math.max(0, parseInt(process.env.COURT_BREAK_DWELL_MIN_MS ?? '60000', 10) || 60000);
const BREAK_DWELL_MAX_MS = Math.max(BREAK_DWELL_MIN_MS, parseInt(process.env.COURT_BREAK_DWELL_MAX_MS ?? '150000', 10) || 150000);
/** KST 기준 오늘+offset일 → YYYYMMDD */
function ymdKST(offsetDays: number): string {
  return new Date(Date.now() + 9 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
}

// ── 수도권 법원 코드 (selectCortOfcLst.on 응답 확인 완료) ──────────────
// 검증된 수도권 법원 코드(cortOfcCd) — 본원 + 경기 지원 16곳. courtauction.go.kr 라이브로 확인된 것만.
//    그 외 지원 코드는 사이트에서 검증 후 COURT_EXTRA(.env)로 추가한다(추측 코드 하드코딩 금지).
//    검증 도구: npm run discover:courts  (VM에서 집-IP 프록시 경유로 실제 코드→지역 확인).
const BASE_METRO_COURTS: { code: string; name: string }[] = [
  { code: 'B000210', name: '서울중앙지방법원' },
  { code: 'B000211', name: '서울동부지방법원' },
  { code: 'B000212', name: '서울남부지방법원' },
  { code: 'B000213', name: '서울북부지방법원' },
  { code: 'B000215', name: '서울서부지방법원' },
  { code: 'B000214', name: '의정부지방법원' }, // 경기북부(의정부·양주·포천·동두천·연천·가평 일부)
  { code: 'B214804', name: '남양주지원' },      // 남양주·구리·가평 (집 근처 — 코드가 부모 214 기반이라 별도)
  { code: 'B214807', name: '고양지원' },        // 고양·파주
  { code: 'B000240', name: '인천지방법원' },
  { code: 'B000241', name: '부천지원' },        // 인천 관할(부천·김포)
  { code: 'B000250', name: '수원지방법원' },   // 경기남부
  { code: 'B000251', name: '성남지원' },        // 성남·광주·하남
  { code: 'B000252', name: '여주지원' },        // 여주·이천·양평
  { code: 'B000253', name: '평택지원' },        // 평택·안성
  { code: 'B250826', name: '안산지원' },        // 안산·광명·시흥 (코드가 부모 250 기반)
  { code: 'B000254', name: '안양지원' },        // 안양·과천·의왕·군포
];

/** COURT_EXTRA 파싱 — "B000252:여주지원,B000253:평택지원" → [{code,name}]. 잘못된 형식은 무시(순수·테스트 대상). */
export function parseCourtExtra(raw: string | undefined): { code: string; name: string }[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((pair) => {
      const idx = pair.indexOf(':');
      if (idx < 0) return null;
      const code = pair.slice(0, idx).trim();
      const name = pair.slice(idx + 1).trim();
      return /^B\d{6}$/.test(code) && name ? { code, name } : null;
    })
    .filter((c): c is { code: string; name: string } => c != null);
}

/** 검증된 수도권 법원 16곳 + COURT_EXTRA로 추가된 지원(중복 코드 제거). 매 호출 env 반영(운영 중 추가 가능). */
export function allCourts(): { code: string; name: string }[] {
  const seen = new Set(BASE_METRO_COURTS.map((c) => c.code));
  const extra = parseCourtExtra(process.env.COURT_EXTRA).filter((c) => !seen.has(c.code));
  return [...BASE_METRO_COURTS, ...extra];
}

// '경기' → '의정부'+'수원'+'성남' 처럼 광역 지역명 → 세부 매칭 키워드 확장
const REGION_EXPAND: Record<string, string[]> = {
  경기: ['의정부', '남양주', '고양', '수원', '성남', '부천', '여주', '평택', '안산', '안양'],
  수도권: ['서울', '의정부', '남양주', '고양', '인천', '수원', '성남', '부천', '여주', '평택', '안산', '안양'],
};

/** 필터 regions 키워드로 대상 법원 추린다.
 *  '서울' → 서울 5개, '경기' → 경기 본원·지원(+COURT_EXTRA 지원 전부), '인천' → 인천.
 *  DEFAULT_FILTER의 ['서울','경기','인천'] → 수도권 16곳(+COURT_EXTRA 지원) 전부 포함. */
export function filterCourts(regions: string[], courts: { code: string; name: string }[] = allCourts()): { code: string; name: string }[] {
  if (!regions.length) return [...courts];
  const baseCodes = new Set(BASE_METRO_COURTS.map((c) => c.code));
  const wantGyeonggi = regions.some((r) => r === '경기' || r === '수도권');
  const expanded = regions.flatMap((r) => [r, ...(REGION_EXPAND[r] ?? [])]);
  return courts.filter(
    (c) => expanded.some((r) => c.name.includes(r) || c.code === r) || (wantGyeonggi && !baseCodes.has(c.code)),
  );
}

/** 증분 크롤에서 이 물건이 "이미 파싱됨"(상세 fetchDetail skip 대상)인지. incremental이 아니면 항상 false(전량 상세). */
export function isKnownForIncremental(filter: Pick<CrawlFilter, 'incremental' | 'knownKeys'>, key: string): boolean {
  return filter.incremental === true && filter.knownKeys?.has(key) === true;
}

export function shouldFetchPhotoDetail(
  filter: Pick<CrawlFilter, 'photosOnly' | 'photoKeys' | 'maxPhotoDetails'>,
  key: string,
  fetched: number,
): boolean {
  return filter.photosOnly === true
    && filter.photoKeys?.has(key) !== true
    && (filter.maxPhotoDetails == null || fetched < filter.maxPhotoDetails);
}

/** 이번 실행에서 이 신규 물건의 상세를 지금 받을지 — 신규 상세 예산(maxNewDetails) 내에서만.
 *  예산 소진 시 메타만 저장(권리분석 없음 → 다음 실행에서 다시 신규로 잡혀 이어짐). 미설정이면 무제한. */
export function shouldFetchDetailNow(known: boolean, nNewDetail: number, maxNewDetails?: number): boolean {
  return !known && (maxNewDetails == null || nNewDetail < maxNewDetails);
}

/** 증분 모드 상세 수집 판정:
 *   'new'     — 신규 물건(문서 없음), 신규 예산 내 → 풀 파싱
 *   'refresh' — 기존 물건이지만 매각 임박(오늘~thresholdDate) → 명세서 변경감지 위해 재수집(재수집 예산 내)
 *   'skip'    — 그 외(기존·비임박, 또는 예산 소진) → 메타만
 * 순수 함수(테스트 가능). saleDate/today/thresholdDate는 'YYYY-MM-DD'. */
export function detailDecision(
  known: boolean,
  saleDate: string | null,
  today: string,
  thresholdDate: string,
  counts: { nNew: number; nRefresh: number },
  caps: { maxNew?: number; maxRefresh: number; refreshDays: number },
): 'new' | 'refresh' | 'skip' {
  if (!known) return caps.maxNew == null || counts.nNew < caps.maxNew ? 'new' : 'skip';
  if (caps.refreshDays <= 0) return 'skip';
  const imminent = saleDate != null && saleDate >= today && saleDate <= thresholdDate;
  if (imminent && counts.nRefresh < caps.maxRefresh) return 'refresh';
  return 'skip';
}

// ── 휴먼 페이싱 ─────────────────────────────────────────────────────────
const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.round(ms)));
const humanDwellMs = () => (Math.random() < DETAIL_LONG_DWELL_CHANCE ? rnd(DETAIL_LONG_DWELL_MIN_MS, DETAIL_LONG_DWELL_MAX_MS) : rnd(DETAIL_DWELL_MIN_MS, DETAIL_DWELL_MAX_MS));
let _nextReqAt = 0;
async function rateGate(): Promise<void> {
  const now = Date.now();
  const w = Math.max(0, _nextReqAt - now);
  _nextReqAt = Math.max(now, _nextReqAt) + MIN_REQ_INTERVAL_MS;
  if (w > 0) await wait(w);
}

/** 일시적 네트워크 오류(TypeError: fetch failed / ECONNRESET / timeout)에 한해 백오프 재시도.
 *  이 VM 네트워크가 간헐적으로 끊겨(예: run 47 "fetch failed") 장시간 크롤이 통째로 실패하는 것을 방지.
 *  HTTP 상태·차단(ipcheck) 오류는 여기까지 오지 않음(호출부에서 처리) → 재시도 대상 아님. */
async function crawlFetchRetry(
  url: string,
  init: Parameters<typeof courtAuctionFetch>[1],
  tries = 3,
): Promise<Awaited<ReturnType<typeof courtAuctionFetch>>> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await courtAuctionFetch(url, { ...init, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        const backoff = 2_000 * (i + 1) + rnd(0, 1_000);
        console.warn(`[courtauction] fetch 재시도 ${i + 1}/${tries - 1}: ${e instanceof Error ? e.message : e} — ${Math.round(backoff / 1000)}s 후`);
        await wait(backoff);
      }
    }
  }
  throw lastErr;
}

// ── 쿠키 관리 ─────────────────────────────────────────────────────────
class CookieJar {
  private store = new Map<string, string>();

  ingest(setCookie: string | null): void {
    if (!setCookie) return;
    for (const part of setCookie.split(/,(?=\s*\w+=)/)) {
      const kv = part.trim().split(';')[0]?.trim();
      if (!kv) continue;
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      this.store.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export class CourtAuctionBlockedError extends Error {
  constructor() {
    super('COURT_BLOCKED: 법원경매 IP 차단 — 다른 IP(로컬 PC/RPi)에서 실행 필요');
    this.name = 'CourtAuctionBlockedError';
  }
}

// ── HTTP 헬퍼 ─────────────────────────────────────────────────────────
interface FetchOpts {
  body?: unknown;
  cookies: CookieJar;
  referer?: string;
  headers?: Record<string, string>; // WebSquare 필수 헤더(submissionid·sc-userid 등) 주입용
}

async function post(path: string, { body, cookies, referer, headers: extra }: FetchOpts): Promise<unknown> {
  await rateGate();
  const res = await crawlFetchRetry(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      Referer: referer ?? BASE + '/pgj/index.on',
      Origin: BASE,
      Cookie: cookies.header(),
      ...extra,
    },
    body: JSON.stringify(body),
  });
  cookies.ingest(res.headers.get('set-cookie'));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

/** 세션 초기화 (JSESSIONID + WMONID 취득) */
async function initSession(cookies: CookieJar): Promise<void> {
  await rateGate();
  const res = await crawlFetchRetry(BASE + '/pgj/index.on', {
    headers: {
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'User-Agent': UA,
    },
  });
  cookies.ingest(res.headers.get('set-cookie'));
  await wait(rnd(2_000, 4_000)); // 사람처럼 페이지를 잠시 봄
}

// ── 데이터 정규화 ─────────────────────────────────────────────────────
/** 용도코드 → PropertyType (법원경매 고유 코드 체계) */
export function mapUsgCd(cd: string | undefined, bigo: string | undefined): Listing['propertyType'] {
  const s = `${cd ?? ''} ${bigo ?? ''}`;
  if (/아파트|APT/.test(s)) return 'apartment';
  if (/오피스텔/.test(s)) return 'officetel';
  if (/다세대|연립|다가구|빌라/.test(s)) return 'villa';
  if (/단독/.test(s)) return 'house';
  if (/상가|근린|점포|오피스|업무|공장|창고/.test(s)) return 'commercial';
  if (/토지|임야|농지|전|답/.test(s)) return 'land';
  return 'other';
}

/** 법원경매 날짜 문자열 (YYYYMMDD or YYYY.MM.DD) → ISO YYYY-MM-DD */
export function parseCourtDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const clean = s.replace(/\./g, '');
  if (/^\d{8}$/.test(clean)) {
    // YYYYMMDD → YYYY.MM.DD을 parseKoreanDate로 위임하여 불가능한 날짜 거부
    return parseKoreanDate(`${clean.slice(0, 4)}.${clean.slice(4, 6)}.${clean.slice(6, 8)}`);
  }
  return parseKoreanDate(s);
}

/** 금액 문자열("1,234,567,000") → 숫자 */
export function parseMoney(s: string | undefined): number {
  if (!s) return 0;
  const n = parseInt(s.replace(/,/g, '').trim(), 10);
  return isNaN(n) ? 0 : n;
}


const PHOTO_KEY_RE = /(url|src|path|file|photo|image|img|thumb|thum)/i;
const PHOTO_URL_RE = /\.(?:jpe?g|png|webp|gif)(?:\?|#|$)|(?:photo|image|img|thumb|thum|atch|file|down|download)/i;
const NON_LISTING_IMAGE_RE = /logo|icon|btn|button|blank|spacer|bg[_-]|banner|sprite|\.svg(?:\?|#|$)/i;
// 법원 상세는 사진을 접두사 없는 base64로 주기도 한다. 매직 바이트의 base64 표기로 형식을 판별한다.
const INLINE_PHOTO_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
  ['iVBORw0KGgo', 'image/png'],
  ['UklGR', 'image/webp'],
];
// URL로 보이지 않는 긴 base64 덩어리 — 사이트 경로로 붙여 요청하면 매번 타임아웃까지 기다린다.
const LONG_BASE64_RE = /^[A-Za-z0-9+/=]{80,}$/;

function normalizeInlineCourtPhoto(raw: string): string | null {
  const compact = raw.replace(/\s+/g, '');
  if (!LONG_BASE64_RE.test(compact)) return null;
  const match = INLINE_PHOTO_PREFIXES.find(([prefix]) => compact.startsWith(prefix));
  return match ? `data:${match[1]};base64,${compact}` : null;
}

function normalizeCourtPhotoUrl(raw: string, baseUrl: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /^data:/i.test(trimmed) || NON_LISTING_IMAGE_RE.test(trimmed)) return null;
  const inlinePhoto = normalizeInlineCourtPhoto(trimmed);
  if (inlinePhoto) return inlinePhoto;
  if (LONG_BASE64_RE.test(trimmed.replace(/\s+/g, ''))) return null;
  if (!PHOTO_URL_RE.test(trimmed)) return null;
  try {
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

export function extractCourtPhotoUrls(detail: unknown, baseUrl = BASE): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<object>();

  function pushCandidate(value: string): void {
    const normalized = normalizeCourtPhotoUrl(value, baseUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  }

  function walk(value: unknown, keyHint = ''): void {
    if (out.length >= 15 || value == null) return;
    if (typeof value === 'string') {
      if (PHOTO_KEY_RE.test(keyHint) || PHOTO_URL_RE.test(value)) pushCandidate(value);
      return;
    }
    if (typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, keyHint);
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      walk(nested, key);
      if (out.length >= 15) return;
    }
  }

  walk(detail);
  return out.slice(0, 15);
}

/** 법원코드 → 법원명 */
function courtName(code: string): string {
  return allCourts().find((c) => c.code === code)?.name ?? code;
}

// ── 검색 결과 행 → ScrapedListing ───────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToScraped(row: any, courtCode: string): ScrapedListing | null {
  // srnSaNo = "2008타경25092"(표시 포맷, deonakchal과 일치) 우선, 없으면 saNo(숫자)
  const rawCsNo: string = row.srnSaNo ?? row.saNo ?? '';
  if (!rawCsNo) return null;

  // 진행 중인 물건만 (mulJinYn="Y", 종결/취하 제외)
  if (row.mulJinYn === 'N') return null;

  const appraisal = parseMoney(row.gamevalAmt);
  const minBid = parseMoney(row.minmaePrice || row.notifyMinmaePrice1);
  if (!appraisal && !minBid) return null;

  const address = (row.realSt ?? row.printSt ?? '').replace(/\s+/g, ' ').trim();
  if (!address) return null;

  const failCount = parseInt(row.yuchalCnt ?? '0', 10) || 0;
  const saleDate = parseCourtDate(row.maeGiil ?? row.maeHh1);
  const propertyType = mapUsgCd(row.dspslUsgNm, row.mulBigo); // 용도명 텍스트("아파트"…). maemulUtilCd는 숫자코드라 안 됨
  const itemNo = row.maemulSer ?? row.mokmulSer ?? '1';
  // 경쟁 신호(검색행에 이미 옴): 조회수 inqCnt · 관심물건수 gwansMulRegCnt. 낮을수록 저경쟁.
  // 참고: 법원경매 검색 응답의 inqCnt는 현재 항상 "0"(목록 단계 미노출) → 실질 신호는 관심수(gwansMulRegCnt).
  const inq = parseInt(row.inqCnt ?? '', 10);
  const interest = parseInt(row.gwansMulRegCnt ?? '', 10);

  const listing: Listing = {
    caseNo: normalizeCaseNo(rawCsNo),
    itemNo: String(itemNo),
    court: courtName(row.boCd ?? courtCode),
    address,
    propertyType,
    appraisalValue: appraisal,
    minBidPrice: minBid || Math.round(appraisal * 0.8),
    minBidRatio: appraisal ? Math.round((minBid / appraisal) * 100) : undefined,
    failCount,
    saleDate,
    inquiryCount: Number.isFinite(inq) ? inq : undefined,
    interestCount: Number.isFinite(interest) ? interest : undefined,
    source: 'courtauction',
    // 법원경매 신규 사이트(WebSquare SPA)는 사건별 딥링크 미지원 — 상세화면(PGJ15BM01) URL 직접 진입은
    // 부모 화면 컨텍스트가 없어 '부모 객체' 오류로 빈 화면이 된다. 단독으로 열리는 메인만 걸고 사건번호로 검색.
    sourceUrl: `${BASE}/pgj/index.on`,
    rawJson: row,
    crawledAt: new Date().toISOString(),
  };

  return { listing };
}

// ── 상세 검색 공용 srchInfo (WebSquare dma 맵) — 검색은 dma_srchGdsDtlSrchInfo로, 상세는 srchInfo로 감싼다 ──
function buildSrchInfo(courtCode: string): Record<string, unknown> {
  return {
    rletDspslSpcCondCd: '', bidDvsCd: '000331', mvprpRletDvsCd: '00031R', cortAuctnSrchCondCd: '0004601',
    rprsAdongSdCd: '', rprsAdongSggCd: '', rprsAdongEmdCd: '', rdnmSdCd: '', rdnmSggCd: '', rdnmNo: '',
    mvprpDspslPlcAdongSdCd: '', mvprpDspslPlcAdongSggCd: '', mvprpDspslPlcAdongEmdCd: '',
    rdDspslPlcAdongSdCd: '', rdDspslPlcAdongSggCd: '', rdDspslPlcAdongEmdCd: '',
    cortOfcCd: courtCode, jdbnCd: '', execrOfcDvsCd: '',
    lclDspslGdsLstUsgCd: '', mclDspslGdsLstUsgCd: '', sclDspslGdsLstUsgCd: '', cortAuctnMbrsId: '',
    aeeEvlAmtMin: '', aeeEvlAmtMax: '', lwsDspslPrcRateMin: '', lwsDspslPrcRateMax: '',
    flbdNcntMin: '', flbdNcntMax: '', objctArDtsMin: '', objctArDtsMax: '',
    mvprpArtclKndCd: '', mvprpArtclNm: '', mvprpAtchmPlcTypCd: '', notifyLoc: 'off', lafjOrderBy: '',
    pgmId: 'PGJ151F01', csNo: '', cortStDvs: '1', statNum: 1,
    bidBgngYmd: ymdKST(COURT_BID_START_OFFSET_DAYS), bidEndYmd: ymdKST(COURT_BID_START_OFFSET_DAYS + COURT_BID_DAYS),
    dspslDxdyYmd: '', fstDspslHm: '', scndDspslHm: '', thrdDspslHm: '', fothDspslHm: '',
    dspslPlcNm: '', lwsDspslPrcMin: '', lwsDspslPrcMax: '', grbxTypCd: '', gdsVendNm: '',
    fuelKndCd: '', carMdyrMax: '', carMdyrMin: '', carMdlNm: '', sideDvsCd: '',
  };
}

/** 법원 코드 발견/검증(discover:courts용) — 코드 하나로 1페이지 검색 후 결과 건수·주소 시군구 요약 반환.
 *  차단이면 CourtAuctionBlockedError. 실제 사이트가 응답해야 하므로 VM(집-IP 프록시)에서만 유효. */
export interface CourtProbe { code: string; count: number; regions: string[]; sampleAddress: string | null }
export async function probeCourt(cortOfcCd: string): Promise<CourtProbe> {
  const cookies = new CookieJar();
  await initSession(cookies);
  const body = {
    dma_pageInfo: { pageNo: 1, pageSize: COURT_PAGE_SIZE, bfPageNo: '', startRowNo: '', totalCnt: '', totalYn: 'Y', groupTotalCount: '' },
    dma_srchGdsDtlSrchInfo: buildSrchInfo(cortOfcCd),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = (await post('/pgj/pgjsearch/searchControllerMain.on', {
    body, cookies,
    referer: `${BASE}/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml`,
    headers: { submissionid: 'mf_wfm_mainFrame_sbm_selectGdsDtlSrch', 'sc-userid': 'SYSTEM' },
  })) as any;
  const data = resp?.data;
  if (data?.ipcheck === false) throw new CourtAuctionBlockedError();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = Array.isArray(data?.dlt_srchResult) ? data.dlt_srchResult : [];
  const addrs = rows.map((r) => String(r.realSt ?? r.printSt ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const cnt = new Map<string, number>();
  for (const a of addrs) {
    const k = a.split(/\s+/).slice(0, 2).join(' ');
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  const regions = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}(${n})`);
  return { code: cortOfcCd, count: rows.length, regions, sampleAddress: addrs[0] ?? null };
}

// ── 상세 API: 매각물건명세서 기반 권리 데이터(최선순위설정·비고·배당종기) ──
/** 상세 조회 — selectAuctnCsSrchRslt.on (dma_srchGdsDtlSrch 본문 + submissionid 헤더). dma_result 반환(라이브 캡처로 확정). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDetail(csNo: string, cortOfcCd: string, dspslGdsSeq: string, srchInfo: Record<string, unknown>, cookies: CookieJar): Promise<any | null> {
  const body = { dma_srchGdsDtlSrch: { csNo, cortOfcCd, dspslGdsSeq, pgmId: 'PGJ151F01', srchInfo } };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await post('/pgj/pgj15B/selectAuctnCsSrchRslt.on', {
      body, cookies,
      referer: `${BASE}/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml`,
      headers: { submissionid: 'mf_wfm_mainFrame_sbm_selectGdsDtlSrchDtlInfo', 'sc-userid': 'SYSTEM' },
    })) as any;
    if (res?.data?.ipcheck === false) throw new CourtAuctionBlockedError();
    return res?.data?.dma_result ?? null;
  } catch (e) {
    if (e instanceof CourtAuctionBlockedError) throw e;
    return null;
  }
}

// ── 결과 수집(Phase 1): 상세의 gdsDspslDxdyLst(매각기일 내역)에서 회차별 결과·낙찰가 추출 ──
export interface SaleResultRound {
  date: string;            // 기일 ISO (YYYY-MM-DD)
  kindCd: string;          // auctnDxdyKndCd (01 매각기일 / 02 매각결정기일 …)
  resultCd: string | null; // auctnDxdyRsltCd 원본 코드 (002=유찰 등)
  minPrice: number | null; // tsLwsDspslPrc 해당 기일 최저매각가
  soldAmount: number | null; // dspslAmt 매각가(낙찰가) — 매각된 기일만
  sold: boolean;           // dspslAmt>0 이면 매각(낙찰)
}

/** 법원명 → 법원코드(cortOfcCd). 결과 폴러가 DB의 court명으로 상세 조회 시 필요. */
export function courtCodeByName(name: string): string | null {
  const courts = allCourts();
  const raw = name.trim();
  const exact = courts.find((c) => c.name === raw);
  if (exact) return exact.code;
  const key = raw
    .replace(/\s+/g, '')
    .replace(/(지방법원|지원)/g, '')
    .replace(/\d+계.*$/, '');
  if (!key) return null;
  return courts.find((c) => c.name.replace(/\s+/g, '').includes(key))?.code ?? null;
}

/** 상세 조회 가능한(코드 매핑 보유) 법원명 목록 — 결과 폴러 SQL 필터용(미매핑 법원에 슬롯 낭비 방지). */
export function queryableCourtNames(): string[] {
  return allCourts().map((c) => c.name);
}

/** 상세 dma_result → 회차별 기일결과. 응찰자수는 이 엔드포인트에 없음(추후 별도 캡처). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseSaleResults(dma: any): SaleResultRound[] {
  const out: SaleResultRound[] = [];
  for (const r of (dma?.gdsDspslDxdyLst ?? [])) {
    const ymd = String(r.dxdyYmd ?? '').trim();
    const date = /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : (parseCourtDate(ymd) ?? null);
    if (!date) continue;
    const amt = Number(r.dspslAmt) || 0;
    out.push({
      date, kindCd: String(r.auctnDxdyKndCd ?? ''), resultCd: r.auctnDxdyRsltCd != null ? String(r.auctnDxdyRsltCd) : null,
      minPrice: Number(r.tsLwsDspslPrc) || null, soldAmount: amt > 0 ? amt : null, sold: amt > 0,
    });
  }
  return out;
}

/**
 * 다음(예정) 매각기일 — 회차 목록에서 매각기일(kindCd '01') & 오늘 이후 & 미낙찰 중 가장 이른 것.
 * 유찰되면 법원이 다음 회차를 잡으므로, 이를 gm_listings.sale_date에 반영해 D+로 죽지 않게 한다.
 */
export function nextSaleDate(rounds: SaleResultRound[], today: string): { date: string; minPrice: number | null } | null {
  const upcoming = rounds
    .filter((r) => r.kindCd === '01' && !r.sold && r.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  return upcoming[0] ? { date: upcoming[0].date, minPrice: upcoming[0].minPrice } : null;
}

/** 과거 매각기일 중 미낙찰(유찰) 회차 수 — fail_count 갱신용. */
export function failedRoundCount(rounds: SaleResultRound[], today: string): number {
  return rounds.filter((r) => r.kindCd === '01' && !r.sold && r.date < today).length;
}

/**
 * 여러 사건의 기일결과를 세션 1회로 배치 조회(폴라이트 지연).
 * onResult 콜백을 주면 **사건별 즉시 콜백**(중단/타임아웃에도 부분 진행 보존). 반환 Map은 누적 결과.
 */
export async function collectSaleResults(
  cases: { caseNo: string; cortOfcCd: string; itemNo: string }[],
  onResult?: (key: string, rounds: SaleResultRound[]) => Promise<void> | void,
): Promise<Map<string, SaleResultRound[]>> {
  const cookies = new CookieJar();
  await initSession(cookies);
  const out = new Map<string, SaleResultRound[]>();
  for (const c of cases) {
    try {
      const dma = await fetchDetail(c.caseNo, c.cortOfcCd, c.itemNo, buildSrchInfo(c.cortOfcCd), cookies);
      if (dma) {
        const rounds = parseSaleResults(dma);
        const key = `${c.caseNo}|${c.itemNo}`;
        out.set(key, rounds);
        if (onResult && rounds.length) await onResult(key, rounds);
      }
    } catch (e) {
      if (e instanceof CourtAuctionBlockedError) throw e;
    }
    await new Promise((r) => setTimeout(r, 400)); // 폴라이트 간격
  }
  return out;
}

// ── 경매사건검색(pgj15A) — 과거/종결 사건의 낙찰가·결과 소급 수집 (S1 스펙: docs/courtauction-result-endpoint.md) ──
/** pgj15A 응답(res.data) → 해당 물건(itemNo)의 회차별 결과. 결과코드 001=매각/002=유찰, 낙찰가=물건 dspslAmt. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseCaseResult(data: any, itemNo = '1'): SaleResultRound[] {
  const objs: any[] = data?.dlt_dspslGdsDspslObjctLst ?? [];
  const obj = objs.find((o) => String(o.dspslGdsSeq) === String(itemNo)) ?? objs[0];
  const soldAmt = Number(obj?.dspslAmt) || 0;
  const mins = [obj?.fstPbancLwsDspslPrc, obj?.scndPbancLwsDspslPrc, obj?.thrdPbancLwsDspslPrc, obj?.fothPbancLwsDspslPrc].map((x) => Number(x) || null);
  const rows: any[] = (data?.dlt_rletCsGdsDtsDxdyInf ?? []).filter((r: any) => r.dspslGdsSeq == null || String(r.dspslGdsSeq) === String(itemNo));
  const out: SaleResultRound[] = [];
  let saleIdx = 0; // 매각기일(kind 01) 순번 → 차수별 최저가 매핑
  for (const r of rows) {
    const ymd = String(r.dxdyYmd ?? '').trim();
    const date = /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : (parseCourtDate(ymd) ?? null);
    if (!date) continue;
    const kindCd = String(r.auctnDxdyKndCd ?? '');
    const resultCd = r.auctnDxdyRsltCd != null ? String(r.auctnDxdyRsltCd) : null;
    const sold = resultCd === '001'; // 001=매각, 002=유찰
    const minPrice = kindCd === '01' ? (mins[saleIdx] ?? null) : null;
    if (kindCd === '01') saleIdx++;
    out.push({ date, kindCd, resultCd, minPrice, soldAmount: sold && soldAmt > 0 ? soldAmt : null, sold });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function postCaseResult(caseNo: string, cortOfcCd: string, cookies: CookieJar): Promise<any | null> {
  const body = { dma_srchCsDtlInf: { cortOfcCd, csNo: caseNo } };
  const res = (await post('/pgj/pgj15A/selectAuctnCsSrchRslt.on', {
    body, cookies,
    referer: `${BASE}/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ15AF01.xml`,
    headers: { submissionid: 'mf_wfm_mainFrame_sbm_selectCsDtlInf', 'sc-userid': 'SYSTEM' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
  if (res?.data?.ipcheck === false) throw new CourtAuctionBlockedError();
  return res?.data ?? null;
}

/** 여러 사건의 결과를 경매사건검색(pgj15A)으로 세션 1회 배치 조회. 과거/종결 사건 소급용. */
export async function collectCaseResults(
  cases: { caseNo: string; cortOfcCd: string; itemNo: string }[],
  onResult?: (key: string, rounds: SaleResultRound[]) => Promise<void> | void,
): Promise<Map<string, SaleResultRound[]>> {
  const cookies = new CookieJar();
  await initSession(cookies);
  const out = new Map<string, SaleResultRound[]>();
  for (const c of cases) {
    try {
      const data = await postCaseResult(c.caseNo, c.cortOfcCd, cookies);
      if (data) {
        const rounds = parseCaseResult(data, c.itemNo);
        const key = `${c.caseNo}|${c.itemNo}`;
        out.set(key, rounds);
        if (onResult && rounds.length) await onResult(key, rounds);
      }
    } catch (e) {
      if (e instanceof CourtAuctionBlockedError) throw e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

export interface CourtDetailParsed {
  registry: RegistryEntry[];
  tenants: Tenant[];
  notes: string[];
  siteAssumedAmount: number | null;
  statementSeniorDate?: string;
  demandDeadline?: string;
  areaM2?: number;
  isCollective: boolean;
}

/**
 * dma_result(법원 매각물건명세서 구조화본) → 권리 데이터.
 * 주의: 등기부등본 원본이 아니라 **법원 명세서 기반** — 최선순위설정(말소기준)·비고(유치권/토지별도등기 등)·배당종기를 추출.
 * 점유자(임차인) 표는 명세서 e-doc(PDF)에만 있어 baseline은 비고 notes로 처리(추후 PDF 파싱 보강 여지).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseCourtDetail(dma: any): CourtDetailParsed {
  const info = dma?.dspslGdsDxdyInfo ?? {};
  const notes: string[] = [];
  for (const ln of String(info.gdsSpcfcRmk ?? '').split(/\n+/)) { const s = ln.trim(); if (s) notes.push(s); }
  const addNote = (label: string, v: unknown) => { const s = String(v ?? '').trim(); if (s) notes.push(`${label}: ${s}`); };
  addNote('인수권리', info.ndstrcRghCtt);
  addNote('법정지상권', info.sprfcExstcDts);

  // 최선순위 설정(말소기준권리) — "… : YYYY.MM.DD. 근저당권" 류에서 날짜+종류 추출.
  // 구분자 뒤 공백 유무가 사건마다 다름("2022.7.5."/"2022. 7. 5.") — \s*로 둘 다 인식.
  const registry: RegistryEntry[] = [];
  const senior = String(info.tprtyRnkHypthcStngDts ?? '');
  const dre = /(\d{4})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})/g;
  let dm: RegExpExecArray | null;
  while ((dm = dre.exec(senior))) {
    const iso = parseKoreanDate(`${dm[1]}.${dm[2]}.${dm[3]}`);
    if (!iso) continue;
    const win = senior.slice(dm.index, dm.index + 24);
    const kind = mapRightKind(win);
    registry.push({ kind: kind === 'other' ? 'geunjeodang' : kind, receiptDate: iso, section: 'eulgu', raw: win.replace(/\s+/g, ' ').trim() });
  }
  if (senior.trim()) notes.push(`최선순위설정: ${senior.replace(/\s+/g, ' ').trim()}`);
  const statementSeniorDate = registry.length ? [...registry].map((r) => r.receiptDate).sort()[0] : undefined;

  const demandDeadline = parseCourtDate(String(dma?.dstrtDemnInfo?.[0]?.dstrtDemnLstprdYmd ?? '') || undefined);

  const objct = dma?.gdsDspslObjctLst?.[0] ?? {};
  let areaM2: number | undefined;
  const aM = String(objct.pjbBuldList ?? '').match(/([\d,]+\.\d+)\s*㎡/) ?? String(objct.objctArDts ?? '').match(/(\d+\.\d+)/);
  if (aM) { const n = parseFloat(aM[1]!.replace(/,/g, '')); if (n > 0) areaM2 = n; }
  const isCollective = /집합|전유/.test(`${objct.rletDvsDts ?? ''} ${objct.pjbBuldList ?? ''}`);

  return { registry, tenants: [], notes, siteAssumedAmount: null, statementSeniorDate, demandDeadline, areaM2, isCollective };
}

/** 상세(dma_result)로 listing 보강 + 권리 docs(registry_summary·sale_statement) emit → 권리엔진이 자동 소비. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyDetail(scraped: ScrapedListing, detail: any): void {
  if (!detail) return;
  const d = parseCourtDetail(detail);
  if (d.areaM2 && !scraped.listing.areaM2) scraped.listing.areaM2 = d.areaM2;
  if (d.isCollective) scraped.listing.isCollectiveBuilding = true;
  if (d.demandDeadline) scraped.listing.demandDeadline = d.demandDeadline;
  const docs: ListingDoc[] = scraped.docs ?? [];
  docs.push({
    caseNo: scraped.listing.caseNo, itemNo: scraped.listing.itemNo, docType: 'registry_summary',
    parsedJson: { registry: d.registry, siteAssumedAmount: d.siteAssumedAmount, statementSeniorDate: d.statementSeniorDate },
  });
  docs.push({
    caseNo: scraped.listing.caseNo, itemNo: scraped.listing.itemNo, docType: 'sale_statement',
    parsedJson: { tenants: d.tenants, notes: d.notes },
  });
  const photos = extractCourtPhotoUrls(detail);
  if (photos.length) {
    docs.push({
      caseNo: scraped.listing.caseNo, itemNo: scraped.listing.itemNo, docType: 'site_metrics',
      parsedJson: { source: 'courtauction', photos },
    });
  }
  scraped.docs = docs;
}

// ── 메인 크롤 로직 ────────────────────────────────────────────────────
export class CourtAuctionAdapter implements Adapter {
  name = 'courtauction' as const;

  async crawl(filter: CrawlFilter, sink?: CrawlSink): Promise<ScrapedListing[]> {
    const maxItems = filter.maxItems ?? 200;
    const perCourt = filter.perCourt ?? maxItems; // 법원당 상한 — 미설정 시 전역과 동일(기존 동작). 설정 시 서울·경기 균형 수집(서울중앙이 예산 독식 방지).
    const fetchDetail_ = process.env.COURT_FETCH_DETAIL !== 'false'; // 권리분석 위해 기본 ON(상세=명세서 권리데이터). 끄려면 false.
    const courts = filterCourts(filter.regions);

    if (!courts.length) {
      console.warn('[courtauction] 해당 지역 법원이 없음 — 수도권 전체로 확대');
      courts.push(...allCourts());
    }

    const cookies = new CookieJar();
    await initSession(cookies);

    const results: ScrapedListing[] = [];
    let nResults = 0;
    const seen = new Set<string>();
    let blocked = false;
    let nKnownSkip = 0;    // 증분: 기존 물건 상세 건너뛰고 메타만
    let nNewDetail = 0;    // 증분: 신규라 상세까지 받은 건수
    let nRefreshDetail = 0; // 증분: 임박 기존 물건 상세 재수집(명세서 변경감지용)
    let nPhotoDetail = 0; // 사진 보강: 활성 사진이 없는 물건 상세 재수집
    let nDeferred = 0;     // 신규지만 상세 예산(maxNewDetails) 소진 — 메타만 저장, 다음 실행에서 이어감

    // 임박 기존 물건 상세 재수집 창(명세서 변경감지). KST 기준 오늘 ~ 오늘+refreshDays.
    const refreshDays = filter.refreshImminentDays ?? 14;
    const maxRefresh = filter.maxRefreshDetails ?? 250;
    const nowKst = new Date(Date.now() + 9 * 3_600_000);
    const todayStr = nowKst.toISOString().slice(0, 10);
    const thresholdStr = new Date(nowKst.getTime() + refreshDays * 86_400_000).toISOString().slice(0, 10);

    let nextBreakAt = Math.round(rnd(BREAK_EVERY_MIN, BREAK_EVERY_MAX));

    for (const court of courts) {
      if (blocked || nResults >= maxItems) break;
      const courtStart = nResults; // 이 법원 수집량 = nResults - courtStart (perCourt 상한 판정용)
      console.log(`[courtauction] 검색: ${court.name} (${court.code})`);
      const srchInfo = buildSrchInfo(court.code); // 검색·상세 공용

      for (let page = 1; ; page++) {
        if (blocked || nResults >= maxItems || nResults - courtStart >= perCourt) break;

        // 실제 사이트(WebSquare) 검색 포맷 — dma_ 맵 본문 + submissionid 헤더. srchInfo는 상세 조회와 공용.
        const body = {
          dma_pageInfo: { pageNo: page, pageSize: COURT_PAGE_SIZE, bfPageNo: '', startRowNo: '', totalCnt: '', totalYn: page === 1 ? 'Y' : 'N', groupTotalCount: '' },
          dma_srchGdsDtlSrchInfo: srchInfo,
        };

        let resp: unknown;
        try {
          resp = await post('/pgj/pgjsearch/searchControllerMain.on', {
            body,
            cookies,
            referer: `${BASE}/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml`,
            headers: { submissionid: 'mf_wfm_mainFrame_sbm_selectGdsDtlSrch', 'sc-userid': 'SYSTEM' },
          });
        } catch (e) {
          console.error(`[courtauction] 검색 실패 ${court.name} p${page}:`, e);
          break;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (resp as any)?.data;
        if (data?.ipcheck === false) {
          blocked = true;
          console.error('[courtauction] ⛔ IP 차단 — 로컬 PC/RPi에서 재시도 필요');
          break;
        }
        if (!data || !Array.isArray(data.dlt_srchResult)) {
          console.warn(`[courtauction] ${court.name} p${page} 응답 구조 이상 — 다음 법원`);
          break;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows: any[] = data.dlt_srchResult;
        if (!rows.length) {
          console.log(`[courtauction] ${court.name} p${page} 결과 없음 — 다음 법원`);
          break;
        }

        let newOnPage = 0;
        for (const row of rows) {
          const scraped = rowToScraped(row, court.code);
          if (!scraped) continue;
          const key = `${scraped.listing.caseNo}|${scraped.listing.itemNo}`;
          if (seen.has(key)) continue;
          seen.add(key);
          newOnPage++;

          // 물건 종류 필터 (클라이언트 사이드). allTypesCourts에 속한 법원은 전종류 수집(집 근처 완전 수집용).
          const typeExempt = filter.allTypesCourts?.includes(court.code) ?? false;
          if (!typeExempt && filter.propertyTypes.length && !filter.propertyTypes.includes(scraped.listing.propertyType)) continue;
          // 지역 키워드 필터
          if (filter.regions.length && !filter.regions.some((rg) => scraped.listing.address.includes(rg) || court.name.includes(rg) || court.code === rg)) continue;

          // 상세 보강 판정. 증분: 신규=풀파싱(예산 내), 임박 기존=명세서 변경감지 위해 재수집(예산 내), 그 외=메타만.
          // 비증분: 전량 상세(기존 동작).
          const known = isKnownForIncremental(filter, key);
          const decision: 'new' | 'refresh' | 'skip' = !fetchDetail_
            ? 'skip'
            : filter.photosOnly
              ? (shouldFetchPhotoDetail(filter, key, nPhotoDetail) ? 'refresh' : 'skip')
              : !filter.incremental
                ? 'new'
                : detailDecision(known, scraped.listing.saleDate ?? null, todayStr, thresholdStr,
                    { nNew: nNewDetail, nRefresh: nRefreshDetail },
                    { maxNew: filter.maxNewDetails, maxRefresh, refreshDays });
          if (decision !== 'skip') {
            try {
              const detail = await fetchDetail(scraped.listing.caseNo, court.code, scraped.listing.itemNo ?? '1', srchInfo, cookies);
              applyDetail(scraped, detail); // scraped.docs 채움 → runAdapter가 이전 문서와 비교해 명세서 변경 감지
              if (filter.photosOnly) {
                nPhotoDetail++;
              } else if (decision === 'new') {
                nNewDetail++;
                if (filter.maxNewDetails != null && nNewDetail === filter.maxNewDetails) {
                  console.log(`[courtauction] 신규 상세 예산 ${filter.maxNewDetails}건 소진 — 이후 신규는 메타만(다음 실행에서 이어감)`);
                }
              } else {
                nRefreshDetail++;
              }
            } catch (e) {
              if (e instanceof CourtAuctionBlockedError) { blocked = true; break; }
            }
            await wait(humanDwellMs());
          } else if (known) {
            nKnownSkip++;
          } else if (fetchDetail_) {
            nDeferred++; // 신규인데 예산 소진 — 메타만
          }

          if (sink) await sink.onListing(scraped);
          else results.push(scraped);
          nResults++;
          if (nResults >= maxItems || nResults - courtStart >= perCourt) break;
        }

        if (newOnPage === 0) break; // 중복만 있으면 종료

        // 중간 휴식 (사람처럼) — 부하가 큰 상세(fetchDetail) 총 수집량(신규+임박재수집) 기준. 증분 스윕에서 대부분 메타만
        // 갱신(상세 skip)이면 잘 안 늘어 큰 휴식이 거의 안 뜸(불필요한 대기 방지). 비증분(전량 상세)에선 사실상 종전과 동일.
        const nDetail = nNewDetail + nRefreshDetail;
        if (nDetail >= nextBreakAt && nResults < maxItems) {
          const br = rnd(BREAK_DWELL_MIN_MS, BREAK_DWELL_MAX_MS);
          console.log(`[courtauction] ☕ 휴식 ${Math.round(br / 1000)}s...`);
          await wait(br);
          nextBreakAt = nDetail + Math.round(rnd(BREAK_EVERY_MIN, BREAK_EVERY_MAX));
        } else {
          await wait(rnd(PAGE_DWELL_MIN_MS, PAGE_DWELL_MAX_MS)); // 다음 페이지 전 텀
        }
      }
    }

    if (blocked) {
      console.error('[courtauction] IP 차단 — 수집 중단. 로컬 PC/RPi에서 재시도 필요.');
    }
    console.log(`[courtauction] 완료: ${nResults}건${filter.incremental ? ` (증분: 신규 상세 ${nNewDetail} · 임박 재수집 ${nRefreshDetail} · 기존 메타갱신 ${nKnownSkip}${nDeferred ? ` · 상세 이월 ${nDeferred}` : ''})` : ''}`);
    return results;
  }
}
