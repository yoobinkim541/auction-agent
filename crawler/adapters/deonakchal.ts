/**
 * 더낙찰옥션(더낙찰옥션.com) 어댑터 — 메인 데이터 소스.
 *
 * 전제: 본인 구독 계정으로 로그인하여 '개인 이용' 목적으로만 수집한다.
 * 폴라이트 정책: 직렬 요청 + 전역 rateGate·휴먼페이싱 지연 + 세션 재사용 + 정직한 User-Agent.
 *   ※ IP 우회/VPN 금지, 수집 데이터 재배포 금지.
 *
 * ⚠️ 셀렉터(SEL.*)는 로그인 후 실제 DOM을 봐야 정확히 채울 수 있다.
 *   최초 1회 CRAWL_HEADLESS=false 로 실행 → inspectAndDump()로 검색/상세 HTML을 저장하고
 *   아래 SEL 상수를 실제 클래스/구조에 맞게 수정한 뒤 본격 수집한다.
 */
import { chromium, type Browser, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Listing, RegistryEntry, Tenant, ListingDoc,
  SiteMetrics, TransitStation, SaleRound, SiteComparable, BuildingInfo,
} from '../../shared/types.ts';
import type { Adapter, CrawlFilter, ScrapedListing } from './types.ts';
import { sleep } from './types.ts';
import {
  parseKoreanMoney, parseKoreanDate, mapPropertyType, mapRightKind, extractLabeledKoreanMoney,
  normalizeCaseNo, extractAmountFromText,
} from '../normalize.ts';
import { parseResultRowText, normalizeItemNo, type ParsedRow } from './parse-row.ts';
import { classifyEgress } from '../egress.ts';
import { crawlFetch } from '../proxy.ts';

const BASE = 'https://www.xn--b20bu5cuwtpue8ui.com'; // 더낙찰옥션.com (punycode)
export const DEONAKCHAL_BASE_URL = BASE;
const AUTH_DIR = '.auth';
const STORAGE = path.join(AUTH_DIR, 'deonakchal.json');
const UA = 'gyeongmae-agent/0.1 (personal research; contact: owner)';

// ── 차단/계정 플래그 서킷브레이커 ──────────────────────────────────────────────
// 진단: 이 사이트의 차단은 IP가 아니라 '로그인 계정' 단위로 걸리는 경우가 많다(집·서버 IP가
//   둘 다 멀쩡한데 양쪽 다 막힘 = 공통분모인 계정이 플래그됨). 자동 cron이 플래그된 계정으로
//   매번 재로그인하면 플래그가 갱신·연장돼 영구정지로 간다 → 차단 감지 후 일정시간 로그인 자체를 멈춘다.
/** 환경변수 정수 파싱 — 미설정/비정수(NaN)면 기본값, 그 뒤 min으로 하한 클램프. 잘못된 env가 안전장치를 무력화하지 않게. */
function intEnv(name: string, dflt: number, min: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Math.max(min, Number.isFinite(v) ? v : dflt);
}
const BLOCK_MARKER = path.join(AUTH_DIR, 'deonakchal-blocked.json');
const BLOCK_COOLDOWN_MS = intEnv('CRAWL_BLOCK_COOLDOWN_MIN', 360, 0) * 60_000; // 기본 6h
export function recordBlock(reason: string): void {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const tmp = `${BLOCK_MARKER}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), reason }));
    fs.renameSync(tmp, BLOCK_MARKER); // 원자적 교체 — 동시 read가 부분 JSON을 보지 않게(쿨다운 우회 방지)
  } catch { /* best-effort */ }
}
function clearBlock(): void {
  try { fs.rmSync(BLOCK_MARKER, { force: true }); } catch { /* ignore */ }
}
/** 활성 쿨다운 남은 ms(없으면 0). CRAWL_IGNORE_COOLDOWN=true 또는 쿨다운=0 이면 항상 0. */
function blockCooldownRemainingMs(): number {
  if (process.env.CRAWL_IGNORE_COOLDOWN === 'true' || BLOCK_COOLDOWN_MS === 0) return 0;
  try {
    const at = Date.parse((JSON.parse(fs.readFileSync(BLOCK_MARKER, 'utf8')) as { at?: string }).at ?? '');
    return at ? Math.max(0, at + BLOCK_COOLDOWN_MS - Date.now()) : 0;
  } catch { return 0; }
}

/** 로그인 브라우저를 열기 전에 등록 IP와 주거 ISP 증거를 모두 확인한다. */
let _egressChecked = false;
async function requireHomeEgress(): Promise<void> {
  if (_egressChecked) return;
  try {
    const res = await crawlFetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { ip?: string; org?: string };
    const kind = classifyEgress(j);
    if (kind !== 'home') {
      throw new Error(`안전한 집 회선이 아닙니다(${kind}, ${j.ip ?? '?'}, ${j.org ?? 'org unknown'})`);
    }
    _egressChecked = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('안전한 집 회선이 아닙니다')) throw error;
    throw new Error(`회선 검증 실패 — 로그인 중단: ${message}`);
  }
}

/** 로그인 폼은 /members/login.html 의 #frmLogin (id/pw, action=javascript:tryLogin()) — 실제 확인됨.
 *  검색 결과 행/페이지 셀렉터는 로그인 후 search HTML 덤프로 확정 필요(TODO). */
const SEL = {
  loginPath: '/members/login.html',
  loginId: '#id',
  loginPw: '#pw',
  loginSubmit: '#frmLogin input[type=submit]',
  loggedInMarker: 'text=마이페이지', // 로그인 성공 판별 (2026-07 사이트 개편으로 '로그아웃'→'마이페이지'. 로그인 시 헤더에 노출)
  searchPath: '/auction/search.html',
  listPath: '/auction/list.html',     // 전체 결과(종결 우선 정렬)
  themePath: '/auction/thema.html',   // 테마 = 진행 매물 (실시간, 권장 소스)
  resultRow: 'table.tbl_act_list_wins tr[id^="tr_"]', // 결과 행 (확인됨)
} as const;

// 진행 매물 테마 opt (전부 미래 매각기일=활성). 테마는 물건종류가 아니라 큐레이션이라,
// 수도권 아파트/빌라/오피스텔/다가구가 담길 만한 테마를 폭넓게 모아 클라이언트에서 종류 필터.
//  opt 의미: 2 수도권APT, 3 임대수익50선, 5 반값아파트, 6 역세권아파트(3~5억), 7 서울3억미만,
//            9 임대수익다가구, 12 반값빌라, 25 특수물건, 26 오늘공고신건, 27 역세권물건, 11 유치권
//  혼합/빌라 테마를 앞에 두어 maxItems가 아파트로만 채워지지 않게 함. (전원주택1·고가4·토지8/10 제외)
const THEME_OPTS = ['12', '3', '9', '27', '26', '25', '5', '6', '7', '2', '11'];

// ── 휴먼 페이싱: 사람이 매물을 '보는' 것처럼 수집(차단 임계치 회피용 폴라이트 정책) ──
//   가변 지연 + 페이지 스크롤(읽기) + 중간 휴식 + 기본 직렬(1건씩). IP/UA 위장·봇탐지 우회 없음.
const rnd = (min: number, max: number) => min + Math.random() * (max - min);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.round(ms)));
/** 한 매물을 '읽는' 시간: 보통 4~10초, 가끔(12%)은 15~28초(딴짓하듯) */
const humanDwellMs = () => (Math.random() < 0.12 ? rnd(15000, 28000) : rnd(4000, 10000));
// 전역 최소 요청 간격(하드코딩 백스톱) — CRAWL_CONCURRENCY를 높여도 사이트 부하가
//   이 이하로 절대 못 내려가게 보장(분석 결과: 차단은 IP·세션당 요청 '속도/양' 기반).
const MIN_REQ_INTERVAL_MS = intEnv('CRAWL_MIN_REQ_MS', 2500, 1000);
const REQ_JITTER_MS = intEnv('CRAWL_REQ_JITTER_MS', 1500, 0);
let _nextReqAt = 0;
async function rateGate(): Promise<void> {
  const now = Date.now();
  const gap = MIN_REQ_INTERVAL_MS + Math.random() * REQ_JITTER_MS; // 고정 하한 + 지터(요청 간격 패턴 약화)
  const w = Math.max(0, _nextReqAt - now);
  _nextReqAt = Math.max(now, _nextReqAt) + gap;
  if (w > 0) await wait(w);
}

/** 사람처럼 페이지를 천천히 스크롤(지연 로드 콘텐츠도 함께 뜸) */
async function humanScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const h = Math.max(document.body.scrollHeight, 1500);
    for (let y = 0; y < h; y += 250 + Math.random() * 450) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 350));
    }
    window.scrollTo(0, Math.random() * 300);
  }).catch(() => {});
}

/** 사이트 차단/이상접속 페이지 감지 정규식(단일 정의 — 이전엔 5곳에 미묘하게 다른 변종). */
const BLOCK_RE = /비정상접속|접속을\s*차단|차단되었습니다|abuse|blocked/i;
/** 현재 페이지가 차단 페이지인지(throw-safe). */
async function detectBlocked(page: Page): Promise<boolean> {
  return page
    .evaluate((src) => new RegExp(src, 'i').test(document.documentElement.innerHTML), BLOCK_RE.source)
    .catch(() => false);
}

async function ensureLogin(page: Page): Promise<void> {
  try {
    await loginInner(page);
    // 주의: clearBlock()은 여기서 호출하지 않는다. 크롤 도중 세션만료 재로그인(scrapeOne)도 이 함수를
    //   타므로, 여기서 지우면 같은 실행에서 막 기록한 쿨다운을 덮어쓸 수 있다. 쿨다운 해제는
    //   '새 크롤/점검의 최초 로그인 성공' 한 지점에서만(아래 crawl()/inspectAndDump).
  } catch (e) {
    if (e instanceof SiteBlockedError) recordBlock(`login: ${e.message}`);
    throw e;
  }
}
async function loginInner(page: Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // 차단 상태면 로그인 시도 자체가 무의미 → 즉시 중단(타임아웃 대신 명확한 에러)
  const blocked = await detectBlocked(page);
  if (blocked) throw new SiteBlockedError();
  if (await page.locator(SEL.loggedInMarker).count()) return; // 세션 유효
  const id = process.env.DEONAKCHAL_ID;
  const pw = process.env.DEONAKCHAL_PW;
  if (!id || !pw) throw new Error('DEONAKCHAL_ID / DEONAKCHAL_PW 환경변수가 필요합니다');
  await page.goto(BASE + SEL.loginPath, { waitUntil: 'domcontentloaded' });
  // 로그인 폼이 안 뜨면(차단 페이지 등) page.fill 이 30s 행에 빠진 뒤 raw TimeoutError → 깔끔히 차단 감지로 대체.
  const formReady = await page.locator(SEL.loginId).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!formReady) {
    const blockedNow = await detectBlocked(page);
    if (blockedNow) throw new SiteBlockedError();
    throw new Error('로그인 폼(#id) 로드 실패 — 사이트 구조 변경 또는 접속 차단 의심 (CRAWL_HEADLESS=false로 점검)');
  }
  await page.fill(SEL.loginId, id);
  await page.fill(SEL.loginPw, pw);
  await page.click(SEL.loginSubmit).catch(() => {});
  // tryLogin()은 AJAX → 네트워크 안정화 대기 후 마커 확인
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  if (!(await page.locator(SEL.loggedInMarker).count())) {
    const blockedAfter = await detectBlocked(page);
    if (blockedAfter) throw new SiteBlockedError();
    const formStillThere = await page.locator(SEL.loginId).first().isVisible().catch(() => false);
    if (!formStillThere) throw new SiteBlockedError(); // 로그인 폼도 없고 마커도 없음 = 차단 리다이렉트
    // 로그인 폼이 다시 표시 = 계정 오류 또는 IP 차단 후 로그인 폼 재표시(이 사이트는 IP 차단 시 별도 차단 안내 없이 로그인 폼으로 되돌림).
    // → BLOCKED 에러로 처리해 상위에서 프록시 폴백·courtauction 폴백을 가동시킴.
    // 진짜 계정 오류(PW 변경 등)는 CRAWL_HEADLESS=false 후 scripts/blockcheck.ts로 구분.
    throw new SiteBlockedError();
  }
}

/** 최초 셀렉터 작성을 돕는 진단: 검색 페이지 HTML을 tmp에 저장 */
export async function inspectAndDump(): Promise<string> {
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await ensureLogin(page);
    clearBlock(); // 수동 점검에서 로그인 성공 = 계정 정상 → 쿨다운 해제
    await page.context().storageState({ path: STORAGE });
    await page.goto(BASE + SEL.searchPath, { waitUntil: 'networkidle' }).catch(() => {});
    const html = await page.content();
    fs.mkdirSync('tmp', { recursive: true });
    const out = path.join('tmp', 'deonakchal-search.html');
    fs.writeFileSync(out, html);
    return out;
  } finally {
    await browser.close();
  }
}

async function launch(): Promise<Browser> {
  await requireHomeEgress();
  const proxy = process.env.CRAWL_PROXY; // e.g. socks5://192.168.0.2:1080
  return chromium.launch({
    headless: process.env.CRAWL_HEADLESS !== 'false',
    proxy: proxy ? { server: proxy } : undefined,
  });
}
async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    userAgent: UA,
    storageState: fs.existsSync(STORAGE) ? STORAGE : undefined,
  });
  return ctx.newPage();
}

/** 결과 행 텍스트를 정규식으로 파싱. 종결/취하 등 입찰불가 상태는 제외. (파싱은 parse-row.ts 순수함수) */
async function parseListPage(page: Page, rowSelector: string = SEL.resultRow): Promise<ParsedRow[]> {
  const rows = page.locator(rowSelector);
  const n = await rows.count();
  const out: ParsedRow[] = [];
  for (let i = 0; i < n; i++) {
    const rid = (await rows.nth(i).getAttribute('id').catch(() => '')) ?? '';
    const productId = rid.startsWith('tr_') ? rid.slice(3) : undefined;
    const text = (await rows.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const parsed = parseResultRowText(text, { productId, sourceUrl: BASE + SEL.listPath });
    if (parsed) out.push(parsed);
  }
  return out;
}

/** deonakchal 검색결과에서 사건번호와 물건번호가 모두 같은 행만 선택한다. */
export function chooseDeonakListRow<T extends { productId?: string; listing: { caseNo: string; itemNo?: string | null } }>(rows: T[], caseNo: string, itemNo: string | null | undefined): T | undefined {
  const wantCase = normalizeCaseNo(caseNo);
  const wantItem = normalizeItemNo(itemNo);
  return rows.find((row) =>
    !!row.productId && normalizeCaseNo(row.listing.caseNo) === wantCase && normalizeItemNo(row.listing.itemNo) === wantItem,
  );
}

/** 명세서 notes에서 "최선순위설정: 2023.09.06" → ISO 추출 */
function extractSeniorDate(notes: string[]): string | undefined {
  for (const n of notes) {
    const m = n.match(/최선순위[^0-9]*(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  return undefined;
}

/** 목록 1건 → 상세(view.html) 파싱 → ScrapedListing. 워커 풀에서 페이지별로 병렬 호출. */
async function scrapeOne(page: Page, c: ParsedRow): Promise<ScrapedListing> {
  const docs: ListingDoc[] = [];
  let listing = c.listing;
  if (c.productId) {
    // 상세 데이터를 docs·listing에 적용하는 헬퍼 — 세션만료 재시도 시 중복 방지
    const applyDetail = (d: DetailData) => {
      listing = { ...listing, sourceUrl: `${BASE}/auction/view.html?product_id=${c.productId}` };
      docs.push(...docsFromDetail(listing.caseNo, listing.itemNo, d, c.notes, listing.sourceUrl));
    };
    try {
      applyDetail(await parseDetail(page, c.productId));
    } catch (e) {
      if (e instanceof SiteBlockedError) throw e; // 차단은 상위로 전파해 전체 중단
      if (e instanceof SessionExpiredError) {
        // 세션 만료: 재로그인 후 1회 재시도(동일 컨텍스트라 재로그인하면 모든 워커에 반영됨)
        console.warn(`[deonakchal] 세션 만료 감지 — 재로그인 후 재시도 ${c.listing.caseNo}`);
        try {
          await ensureLogin(page); // SiteBlockedError는 그대로 상위 전파
          applyDetail(await parseDetail(page, c.productId));
          return { listing, docs: docs.length ? docs : undefined };
        } catch (retryErr) {
          if (retryErr instanceof SiteBlockedError) throw retryErr;
          console.warn(`[deonakchal] 재로그인 후 재시도 실패 ${c.listing.caseNo}: ${retryErr}`);
        }
      } else {
        console.warn(`[deonakchal] 상세 파싱 실패 ${c.listing.caseNo}: ${e}`);
      }
      if (c.notes.length) docs.push({ caseNo: listing.caseNo, docType: 'rights_summary', parsedJson: { notes: c.notes } });
    }
  } else if (c.notes.length) {
    docs.push({ caseNo: listing.caseNo, docType: 'rights_summary', parsedJson: { notes: c.notes } });
  }
  return { listing, docs: docs.length ? docs : undefined };
}

export class DeonakchalAdapter implements Adapter {
  name = 'deonakchal' as const;

  async crawl(filter: CrawlFilter): Promise<ScrapedListing[]> {
    const maxItems = filter.maxItems ?? 50;
    const maxPagesPerTheme = intEnv('CRAWL_MAX_PAGES', 80, 1);

    // 차단 쿨다운 중이면 로그인 시도 자체를 건너뛴다(플래그된 계정 재두드림 → 영구정지 방지).
    const cd = blockCooldownRemainingMs();
    if (cd > 0) {
      throw new SiteBlockedError(
        `BLOCK_COOLDOWN: 차단/계정 플래그 감지 후 쿨다운 약 ${Math.ceil(cd / 60000)}분 남음 — 로그인 시도 생략. ` +
        `계정이 풀렸다고 확신하면 CRAWL_IGNORE_COOLDOWN=true 로 재시도하거나 ${BLOCK_MARKER} 삭제.`,
      );
    }
    const browser = await launch();
    const collected: ParsedRow[] = [];
    const seen = new Set<string>();
    try {
      const page = await newPage(browser);
      await ensureLogin(page);
      clearBlock(); // 새 크롤의 최초 로그인 성공 = 계정/세션 정상 → 쿨다운 해제(자동 회복)
      await page.context().storageState({ path: STORAGE }); // 세션 저장

      // Phase 1: 테마 페이지네이션 → 지역/종류 필터 → 목록 수집 (사람처럼 페이지마다 쉬며)
      for (const opt of THEME_OPTS) {
        for (let p = 1; p <= maxPagesPerTheme && collected.length < maxItems; p++) {
          const url = `${BASE}${SEL.themePath}?opt=${opt}&page=${p}`;
          await rateGate(); // 전역 속도 상한
          await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
          await wait(rnd(1200, 2600));
          const blk = await detectBlocked(page);
          if (blk) throw new SiteBlockedError();
          await humanScroll(page);
          const rows = await parseListPage(page);
          if (rows.length === 0) break;
          let newOnPage = 0;
          for (const r of rows) {
            const rowKey = `${r.listing.caseNo}|${r.listing.itemNo ?? '1'}`;
            if (seen.has(rowKey)) continue;
            seen.add(rowKey);
            newOnPage++;
            if (filter.propertyTypes.length && !filter.propertyTypes.includes(r.listing.propertyType)) continue;
            if (filter.regions.length && !filter.regions.some((rg) => r.listing.address.includes(rg))) continue;
            collected.push(r);
            if (collected.length >= maxItems) break;
          }
          if (newOnPage === 0) break;
          await wait(rnd(3000, 7000)); // 다음 목록 페이지로 넘어가기 전 사람처럼 텀
        }
      }

      // Phase 2: 매물별 상세 — 기본 1건씩(사람처럼) 순차. CRAWL_CONCURRENCY>1 설정 시에만 소수 동시.
      const concurrency = Math.max(1, parseInt(process.env.CRAWL_CONCURRENCY ?? '1', 10));
      console.log(`[deonakchal] 목록 ${collected.length}건 수집, 상세 파싱 시작 (사람처럼 ${concurrency === 1 ? '1건씩 순차' : `동시 ${concurrency}`}, 읽기지연·중간휴식)...`);

      const ctx = page.context();
      const results: ScrapedListing[] = new Array(collected.length);
      const workerCount = Math.min(concurrency, collected.length) || 1;
      const pages: Page[] = [page];
      for (let i = 1; i < workerCount; i++) pages.push(await ctx.newPage());

      let cursor = 0;
      let done = 0;
      let blocked = false;
      let nextBreakAt = Math.round(rnd(30, 45)); // ~30~45건마다 1~2.5분 휴식(사람처럼)
      const runWorker = async (wp: Page): Promise<void> => {
        for (;;) {
          if (blocked) break;
          const i = cursor++;
          if (i >= collected.length) break;
          try {
            results[i] = await scrapeOne(wp, collected[i]!);
          } catch (e) {
            if (e instanceof SiteBlockedError) {
              blocked = true;
              recordBlock(`crawl: ${e.message}`); // 쿨다운 시작 → 자동 cron의 재두드림 차단
              console.error(`[deonakchal] ⛔ 접속 차단/계정 플래그 감지 — 크롤 중단(${done}/${collected.length} 수집).`);
              console.error(`[deonakchal] ⏳ 향후 약 ${Math.round(BLOCK_COOLDOWN_MS / 60000)}분간 로그인 시도를 멈춥니다(계정 영구정지 방지). 수동 로그인으로 계정 상태 확인 권장.`);
              break;
            }
            throw e;
          }
          done++;
          if (done % 10 === 0 || done === collected.length) console.log(`[deonakchal] 상세 ${done}/${collected.length}`);
          if (done >= nextBreakAt && done < collected.length) {
            const br = rnd(60000, 150000);
            console.log(`[deonakchal] ☕ 잠시 휴식 ${Math.round(br / 1000)}s (사람처럼)...`);
            await wait(br);
            nextBreakAt = done + Math.round(rnd(30, 45));
          } else {
            await wait(humanDwellMs()); // 다음 매물 '읽기' 전 지연
          }
        }
      };
      await Promise.all(pages.map((wp) => runWorker(wp)));
      const out = results.filter(Boolean); // 차단으로 미수집된 뒤쪽 인덱스 제거
      for (let i = 1; i < pages.length; i++) await pages[i]!.close().catch(() => {});
      if (!blocked) await ctx.storageState({ path: STORAGE }).catch(() => {}); // 갱신된 세션 쿠키 보존 → 다음 실행 재로그인 최소화
      return out;
    } finally {
      await browser.close();
    }
  }
}

/** 상세 페이지 텍스트에서 등기 권리 행을 best-effort 추출(상세 파서 작성 시 활용) */
export function extractRegistryRowsFromText(lines: string[]): { kind: ReturnType<typeof mapRightKind>; receiptDate?: string; amount: number | null }[] {
  return lines
    .map((ln) => ({
      kind: mapRightKind(ln),
      receiptDate: parseKoreanDate(ln),
      // 줄 전체를 parseKoreanMoney 에 넣으면 날짜·순위번호까지 합쳐져 오값 → 금액 토큰만 추출
      amount: extractAmountFromText(ln),
    }))
    .filter((r) => r.kind !== 'other' && r.receiptDate);
}

export interface DetailData {
  registry: RegistryEntry[];
  tenants: Tenant[];
  notes: string[];
  siteAssumedAmount: number | null; // 사이트 예상배당의 '낙찰자인수' 합계(미배당금액)
  appraisal: { text: string; highlights: string[]; zoning?: string; gongPrice?: number; landPrice?: number } | null; // 감정평가요항 + 공시가격
  siteMetrics: SiteMetrics; // 역세권·매각기일·동일건물 실거래·매각가율·표제부·명도비·토지규제·행정기관
}

export function docsFromDetail(caseNo: string, itemNo: string | undefined, detail: DetailData, extraNotes: string[] = [], sourceUrl?: string): ListingDoc[] {
  const allNotes = [...extraNotes, ...detail.notes];
  const sourceMeta = sourceUrl ? { sourceUrl } : {};
  const docs: ListingDoc[] = [
    {
      caseNo, itemNo, docType: 'registry_summary',
      parsedJson: { source: 'deonakchal', ...sourceMeta, registry: detail.registry, siteAssumedAmount: detail.siteAssumedAmount, statementSeniorDate: extractSeniorDate(allNotes) },
    },
    { caseNo, itemNo, docType: 'sale_statement', parsedJson: { source: 'deonakchal', ...sourceMeta, tenants: detail.tenants, notes: allNotes } },
  ];
  if (detail.appraisal) docs.push({ caseNo, itemNo, docType: 'appraisal_report', parsedJson: { source: 'deonakchal', ...sourceMeta, ...detail.appraisal } });
  if (detail.siteMetrics && Object.keys(detail.siteMetrics).length) docs.push({ caseNo, itemNo, docType: 'site_metrics', parsedJson: { source: 'deonakchal', ...sourceMeta, ...detail.siteMetrics } });
  return docs;
}

const KMONEY = (s?: string | null): number | undefined => parseKoreanMoney(s ?? undefined) ?? undefined;

/**
 * 상세 본문 텍스트(공백 정규화본 + 줄바꿈 보존본)에서 부가 요소를 추출.
 * 모두 사이트 view.html 한 페이지에 인라인으로 존재한다(팝업/외부링크 불필요).
 */
export function extractSiteMetrics(body: string, raw: string, subjectName?: string): SiteMetrics {
  const m: SiteMetrics = {};
  const slice = (from: string, to: string): string => {
    const i = body.indexOf(from);
    if (i < 0) return '';
    const j = to ? body.indexOf(to, i + from.length) : -1;
    return body.slice(i + from.length, j < 0 ? i + 4000 : j);
  };

  // 1) 역세권 (주변환경/이슈 → 역세권 … 개발계획)
  const transitZone = slice('역세권', '개발계획') || slice('역세권', '행정기관');
  const transit: TransitStation[] = [];
  const trRe = /([0-9]+호선|[가-힣]+선)\s+([가-힣A-Za-z0-9]+)\s+([\d,]+)\s*m/g;
  let tm: RegExpExecArray | null;
  while ((tm = trRe.exec(transitZone))) {
    transit.push({ line: tm[1]!, station: tm[2]!, distanceM: parseInt(tm[3]!.replace(/,/g, ''), 10) });
  }
  if (transit.length) m.transit = transit;

  // 2) 매각기일 차수표: "1차 2026-06-16 231,000,000 (20%↓)"
  const rounds: SaleRound[] = [];
  const rdRe = /([0-9]+)차\s+(\d{4}-\d{2}-\d{2})\s+([\d,]{6,})(?:\s*\((\d+)%[↓↑]?\))?/g;
  let rm: RegExpExecArray | null;
  while ((rm = rdRe.exec(body))) {
    const minPrice = parseInt(rm[3]!.replace(/,/g, ''), 10);
    if (minPrice < 1_000_000) continue;
    rounds.push({ round: parseInt(rm[1]!, 10), date: rm[2]!, minPrice, ratioPct: rm[4] ? parseInt(rm[4], 10) : undefined });
  }
  if (rounds.length) m.saleRounds = rounds.slice(0, 12);

  // 3) 동일건물 실거래 (최근 거래내역 표): "에스아이팰리스장안센텀 26.537 (8.03평) 2026.04 25 16 1,413 37,500"
  const tradeZone = slice('최근 거래내역', '인근 경') || slice('최근 거래내역', '인근');
  const comps: SiteComparable[] = [];
  const cpRe = /([가-힣A-Za-z0-9·().]+?)\s+(\d{1,3}\.\d{1,3})\s*\(([\d.]+)평\)\s+(\d{4})\.(\d{2})\s+\d{1,2}\s+(\d{1,3})\s+([\d,]+)\s+([\d,]+)/g;
  let cm: RegExpExecArray | null;
  while ((cm = cpRe.exec(tradeZone))) {
    comps.push({
      name: cm[1]!.trim(), areaM2: parseFloat(cm[2]!), pyeong: parseFloat(cm[3]!),
      dealYm: `${cm[4]}-${cm[5]}`, floor: parseInt(cm[6]!, 10),
      perPyeongManwon: parseInt(cm[7]!.replace(/,/g, ''), 10),
      dealManwon: parseInt(cm[8]!.replace(/,/g, ''), 10),
    });
  }
  if (comps.length) m.siteComps = comps.slice(0, 20);

  // 4) 인근/동일건물 매각가율: "751,230,000(104%)" (금액에 % 가 붙은 형태 = 낙찰가율)
  const saleZone = slice('인근 매각 사례', '주변환경') || slice('인근 매각', '주변환경');
  const nearby: number[] = [];
  const sameBld: number[] = [];
  const srRe = /([\d,]{7,})\((\d{2,3})%\)/g;
  let sr: RegExpExecArray | null;
  while ((sr = srRe.exec(saleZone))) {
    const pct = parseInt(sr[2]!, 10);
    if (pct < 30 || pct > 200) continue;
    nearby.push(pct);
  }
  if (nearby.length) m.nearbySaleRatios = nearby;
  // 동일 건물명이 포함된 매각 행만 추려 별도 율 집계
  if (subjectName) {
    const esc = subjectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rowRe = new RegExp(`${esc}[^]{0,160}?([\\d,]{7,})\\((\\d{2,3})%\\)`, 'g');
    let bm: RegExpExecArray | null;
    while ((bm = rowRe.exec(saleZone))) {
      const pct = parseInt(bm[2]!, 10);
      if (pct >= 30 && pct <= 200) sameBld.push(pct);
    }
    if (sameBld.length) m.sameBuildingSaleRatios = sameBld;
  }

  // 5) 건축물 표제부
  const building: BuildingInfo = {};
  const mainUse = body.match(/주용도\s*([가-힣,·]+)/)?.[1]; if (mainUse) building.mainUse = mainUse;
  const hh = body.match(/세대\/가구\/호\s*(\d+)\/(\d+)\/(\d+)/);
  if (hh) building.households = parseInt(hh[1]!, 10);
  const appr = body.match(/사용승인일?\s*(\d{8})/);
  if (appr) building.approvalDate = `${appr[1]!.slice(0, 4)}-${appr[1]!.slice(4, 6)}-${appr[1]!.slice(6, 8)}`;
  const fa = body.match(/지상_?층_?수\s*(\d+)/); if (fa) building.floorsAbove = parseInt(fa[1]!, 10);
  const fb = body.match(/지하층수\s*(\d+)/); if (fb) building.floorsBelow = parseInt(fb[1]!, 10);
  const far = body.match(/용적율\s*([\d.]+)\s*%/); if (far) building.far = parseFloat(far[1]!);
  const bcr = body.match(/건폐율\s*([\d.]+)\s*%/); if (bcr) building.bcr = parseFloat(bcr[1]!);
  if (Object.keys(building).length) m.building = building;

  // 6) 명도비 / 취득세율 (낙찰시 추가비용 표)
  const moveOut = KMONEY(body.match(/명도비\s*([\d,]{4,})\s*원/)?.[1]) ?? KMONEY(body.match(/명도비용[^0-9]{0,8}([\d,]{4,})\s*원/)?.[1]);
  if (moveOut) m.moveOutCost = moveOut;
  const taxPct = body.match(/취[등독]록세\s*매각가의\s*([\d.]+)\s*%/)?.[1];
  if (taxPct) m.pageAcqTaxPct = parseFloat(taxPct);

  // 7) 토지이용계획 원문 (감정평가요항 8항)
  const landUse = raw.match(/토지이용계획\s*및\s*제한상태\s*([\s\S]{0,800}?)(?:\n\s*\d+\)\s*공부|공부와의\s*차이|기타참고|매각효력)/)?.[1]
    ?? body.match(/토지이용계획[^)]*\)?\s*(.+?)(?=\d\)\s*공부|공부와의\s*차이|기타참고|매각효력|$)/)?.[1];
  if (landUse) m.landUseText = landUse.replace(/\s+/g, ' ').trim().slice(0, 800);

  // 8) 관할 행정기관 (법원/등기소/세무서/주민센터) — '행정기관' 섹션으로 한정(상단 내비 제외)
  const admin: Record<string, string> = {};
  const adminZone = body.indexOf('행정기관') >= 0 ? body.slice(body.indexOf('행정기관'), body.indexOf('행정기관') + 1200) : body;
  const court = adminZone.match(/법원\s*(\S+지방법원)/)?.[1] ?? body.match(/(\S+지방법원)\s*경매\s*\d+계/)?.[1];
  if (court) admin['법원'] = court;
  const jusin = adminZone.match(/([가-힣\d]+동?\s*주민센터)/)?.[1]; if (jusin) admin['주민센터'] = jusin.replace(/\s+/g, '');
  const deunggi = adminZone.match(/(\S+지방법원\s*등기소)/)?.[1]; if (deunggi) admin['등기소'] = deunggi.replace(/\s+/g, ' ');
  const semu = adminZone.match(/([가-힣\d]+세무서)/)?.[1]; if (semu) admin['세무서'] = semu;
  if (Object.keys(admin).length) m.adminOffices = admin;

  return m;
}

/** 상세 페이지(view.html?product_id=) → 등기·임차인·명세서·예상배당 추출. 헤더 키워드로 테이블 탐색. */
/** 사이트 이상접속 차단 감지 시 던지는 에러 — 크롤 전체 중단 신호 */
export class SiteBlockedError extends Error {
  constructor(msg = 'SITE_BLOCKED: 더낙찰옥션 비정상접속 차단') { super(msg); this.name = 'SiteBlockedError'; }
}
/** 세션 만료(로그인 폼 리다이렉트) — scrapeOne 에서 ensureLogin 후 1회 재시도 */
export class SessionExpiredError extends Error {
  constructor() { super('SESSION_EXPIRED: 세션 만료 — 재로그인 필요'); this.name = 'SessionExpiredError'; }
}

export async function parseDetail(page: Page, productId: string): Promise<DetailData> {
  // 사람처럼: 페이지를 열고 → 잠시 보고 → 천천히 스크롤(읽기). 빈 페이지면 1회 새로고침 재시도.
  let loaded = false;
  for (let attempt = 1; attempt <= 2 && !loaded; attempt++) {
    await rateGate(); // 전역 속도 상한(설정 무관 백스톱)
    await page.goto(`${BASE}/auction/view.html?product_id=${productId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await wait(rnd(900, 1900)); // 페이지 훑어보는 텀
    const probe = await page.evaluate((blkSrc) => {
      const html = document.documentElement.innerHTML;
      return { blocked: new RegExp(blkSrc, 'i').test(html), tables: document.querySelectorAll('table').length, logged: html.includes('마이페이지') };
    }, BLOCK_RE.source).catch(() => ({ blocked: false, tables: 0, logged: true }));
    if (probe.blocked) throw new SiteBlockedError();
    // 로그인 마커(마이페이지) 없음 = 세션 만료(로그인 폼 리다이렉트) — 더 기다려도 의미 없음
    if (!probe.logged) throw new SessionExpiredError();
    if (probe.tables > 0) { loaded = true; break; }
    // 표 미로딩: 사람처럼 잠깐 더 기다렸다 확인(최대 ~6초)
    for (let i = 0; i < 12 && !loaded; i++) {
      await wait(500);
      const r2 = await page.evaluate((src) => {
        const html = document.documentElement.innerHTML;
        return { blk: new RegExp(src, 'i').test(html), n: document.querySelectorAll('table').length, logged: html.includes('마이페이지') };
      }, BLOCK_RE.source).catch(() => ({ blk: false, n: 0, logged: true }));
      if (r2.blk) throw new SiteBlockedError();
      if (!r2.logged) throw new SessionExpiredError(); // 초기 probe와 일치: 테이블 유무 무관
      if (r2.n > 0) loaded = true;
    }
    if (!loaded && attempt === 1) await wait(rnd(4000, 8000)); // 새로고침 전 사람처럼 텀
  }
  await humanScroll(page); // 읽듯이 스크롤(지연 콘텐츠 로드 + 자연스러운 패턴)
  // 감정평가요항 등 '더보기'로 접힌 영역 펼치기(토지이용계획·용도지역 노출)
  await page.evaluate(() => {
    document.querySelectorAll('a, button, span').forEach((e) => {
      if ((e.textContent || '').trim() === '더보기') (e as HTMLElement).click();
    });
  }).catch(() => {});
  await wait(rnd(600, 1200));
  // 주의: page.evaluate 내부에 '명명된' 화살표함수(const f = () =>)를 두면 tsx/esbuild가
  // __name 래퍼를 삽입해 브라우저에서 ReferenceError가 난다. 익명 인라인 콜백만 사용한다.
  const raw = (await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const wants: Record<string, string[]> = {
      deunggi: ['접수일', '권리종류'], imcha: ['임차인', '대항력'], baedang: ['낙찰자인수'],
      myungse: ['매각효력'], gamjeong: ['감정평가요항'],
    };
    const out: Record<string, string[][]> = { deunggi: [], imcha: [], baedang: [], myungse: [], gamjeong: [] };
    for (const key of Object.keys(wants)) {
      for (const t of tables) {
        const h = (t as HTMLElement).innerText.replace(/\s+/g, ' ');
        if (wants[key]!.every((k) => h.includes(k))) {
          out[key] = Array.from(t.querySelectorAll('tr')).map((tr) =>
            Array.from(tr.querySelectorAll('th,td')).map((c) => (c as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
          break;
        }
      }
    }
    return out;
  })) as { deunggi: string[][]; imcha: string[][]; baedang: string[][]; myungse: string[][]; gamjeong: string[][] };

  // 페이지 전체 텍스트를 한 번만 fetch — 등기표 폴백 + 공시가격/입지 추출에 공용
  const rawBody = (await page.evaluate(() => document.body.innerText).catch(() => '')) as string;

  const registry: RegistryEntry[] = [];
  for (const row of raw.deunggi) {
    const joined = row.join(' ');
    const date = parseKoreanDate(row[1] ?? '');
    const kind = mapRightKind(row[2] ?? '');
    if (!date || kind === 'other') continue; // 헤더/소유권/무효 행 제외
    registry.push({
      kind, receiptDate: date,
      amount: parseKoreanMoney(row[4] ?? '') ?? undefined,
      demandedDistribution: /배당요구/.test(joined),
      raw: joined,
    });
  }
  // 등기표 키워드('접수일'/'권리종류')가 없는 빌라 등에서 테이블 검출 실패 시 텍스트 폴백
  if (registry.length === 0) {
    const bodyLines = rawBody.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const r of extractRegistryRowsFromText(bodyLines)) {
      if (r.receiptDate) {
        registry.push({ kind: r.kind, receiptDate: r.receiptDate, amount: r.amount ?? undefined, raw: '(텍스트추출)' });
      }
    }
  }

  const tenants: Tenant[] = [];
  for (const row of raw.imcha) {
    if (!/^\d+$/.test(row[0] ?? '')) continue; // 데이터 행(번호 시작)만
    const joined = row.join(' ');
    const moveIn = joined.match(/전입일자\s*:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
    const fixed = joined.match(/확정일자\s*:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
    const demand = joined.match(/배당요구\s*:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
    tenants.push({
      name: row[1],
      moveInDate: moveIn, occupancyDate: moveIn, fixedDate: fixed,
      deposit: extractLabeledKoreanMoney(joined, '보증금', ['월차임', '차임', '전입일자', '확정일자', '배당요구', '점유', '대항력']) ?? 0,
      demandedDistribution: !!demand, demandDate: demand, occupied: true,
      raw: joined,
    });
  }

  const notes: string[] = [];
  for (const row of raw.myungse) {
    const j = row.join(': ');
    if (j && !/해당\s*사항\s*없음|해당없음/.test(j)) notes.push(j);
  }

  let siteAssumedAmount: number | null = null;
  const header = raw.baedang.find((r) => r.includes('미배당금액'));
  const unrecIdx = header ? header.findIndex((c) => c.includes('미배당금액')) : -1;
  for (const row of raw.baedang) {
    if (row === header || row[0] === '순위') continue;
    if (!row.some((c) => /낙찰자인수/.test(c))) continue;
    const amt = unrecIdx >= 0 ? parseKoreanMoney(row[unrecIdx] ?? '') : null;
    if (amt) siteAssumedAmount = (siteAssumedAmount ?? 0) + amt;
  }

  // 공시가격(공동주택공시가격 / 개별공시지가) — 상세 본문에서 직접 추출
  const bodyText = rawBody.replace(/\s+/g, ' ');
  const gongPrice = parseKoreanMoney(bodyText.match(/공동주택공시가격[^:]*:?\s*([\d,]{6,})/)?.[1]) ?? undefined;
  const landPrice = parseKoreanMoney(bodyText.match(/개별공시지가[^\d]{0,15}([\d,]{6,})/)?.[1]) ?? undefined;

  // 감정평가요항: 교통·이용상태·토지이용계획(용도지역/규제) 추출
  let appraisal: DetailData['appraisal'] = null;
  const apprText = raw.gamjeong.map((r) => r.join(' ')).join(' ').replace(/\s+/g, ' ').trim();
  if (apprText || gongPrice || landPrice) {
    const grab = (re: RegExp) => apprText.match(re)?.[1]?.trim();
    const traffic = grab(/교통상황\s*(.+?)(?=\s*\d\)\s*건물|건물의\s*구조|$)/);
    const useState = grab(/이용상태\s*(.+?)(?=\s*\d\)\s*설비|설비내역|$)/);
    const landPlan = grab(/토지이용계획[^)]*\)?\s*(.+?)(?=\s*\d\)\s*공부|공부와의\s*차이|기타참고|$)/);
    void landPlan;
    const zoning = apprText.match(
      /(중심상업지역|일반상업지역|근린상업지역|유통상업지역|준주거지역|제3종일반주거지역|제[12]종일반주거지역|제[12]종전용주거지역|전용주거지역|일반공업지역|준공업지역|전용공업지역|자연녹지지역|생산녹지지역|보전녹지지역)/,
    )?.[1];
    const highlights: string[] = [];
    if (zoning) highlights.push(`용도지역: ${zoning}`);
    if (useState) highlights.push(`이용상태: ${useState.slice(0, 40)}`);
    if (traffic) highlights.push(`교통: ${traffic.slice(0, 70)}`);
    for (const kw of ['지구단위계획', '재개발', '재건축', '정비구역', '역세권', '개발제한', '과밀억제권역']) {
      if (apprText.includes(kw)) highlights.push(kw);
    }
    if (gongPrice) highlights.push(`공동주택공시가격: ${(gongPrice / 1e8).toFixed(2)}억`);
    if (landPrice) highlights.push(`개별공시지가: ${landPrice.toLocaleString('ko-KR')}원/㎡`);
    appraisal = { text: apprText.slice(0, 4000), highlights, zoning, gongPrice, landPrice };
  }

  // 부가 요소(역세권·매각기일·동일건물 실거래·매각가율·표제부·명도비·토지규제·행정기관)
  const subjectName = bodyText.match(/동명\s*([가-힣A-Za-z0-9·()]+)/)?.[1]
    ?? bodyText.match(/[가-힣]+(?:팰리스|아파트|빌라|타워|캐슬|자이|푸르지오|힐스테이트|더샵|e편한세상|센트럴|센텀)\S*/)?.[0];
  const siteMetrics = extractSiteMetrics(bodyText, rawBody, subjectName);

  // 매물 사진 URL 추출(감정평가 현황 사진 등) — 로고/아이콘/배너 제외, 일정 크기 이상만.
  const photos = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('img').forEach((im) => {
      const el = im as HTMLImageElement;
      const s = el.currentSrc || el.src || '';
      if (!s || /^data:/.test(s)) return;
      if (/logo|icon|btn|button|blank|spacer|bg[_-]|banner|sprite|\.svg(\?|$)/i.test(s)) return;
      const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
      if (w < 150 || h < 100) return;
      out.push(s.startsWith('//') ? 'https:' + s : s);
    });
    return [...new Set(out)].slice(0, 15);
  }).catch(() => [] as string[]);
  if (photos.length) siteMetrics.photos = photos;

  return { registry, tenants, notes, siteAssumedAmount, appraisal, siteMetrics };
}

// ── 교차 보강: courtauction 사건 → deonakchal 임차인 상세 (courtauction은 임차인 표 미파싱) ──
/** 수도권 법원명 → deonakchal search.html court1 값 (2026-07 확인). courtauction METRO_COURTS 이름과 동일. */
export const DEONAK_COURT1: Record<string, string> = {
  '서울중앙지방법원': 'A1', '서울동부지방법원': 'A2', '서울남부지방법원': 'A4', '서울북부지방법원': 'A5', '서울서부지방법원': 'A3',
  '의정부지방법원': 'D1', '고양지원': 'D2', '남양주지원': 'D3',
  '인천지방법원': 'C1', '부천지원': 'C2',
  '수원지방법원': 'E1', '성남지원': 'E2', '여주지원': 'E3', '평택지원': 'E4', '안산지원': 'E5', '안양지원': 'E6',
};

/** courtauction 사건번호 "2023타경111644" → deonakchal mngno "2023-111644". 실패 시 null. (순수함수, 테스트) */
export function caseNoToMngno(caseNo: string): string | null {
  const m = String(caseNo).replace(/\s/g, '').match(/(\d{4})타경(\d+)/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * [교차 보강] courtauction 물건을 deonakchal에서 사건번호로 찾아 상세(임차인 등) 조회.
 *   page는 **로그인된 상태**여야 함(오케스트레이터가 ensureLogin 후 재사용). 조회 1건 = 검색 GET + 상세.
 *   못 찾으면 null(그 사건이 deonakchal에 없거나 매칭 실패). 차단 시 SiteBlockedError 전파.
 */
export async function lookupCaseDetail(
  page: Page, courtName: string, caseNo: string, itemNo: string,
): Promise<{ productId: string; detail: DetailData } | null> {
  const m = String(caseNo).replace(/\s/g, '').match(/(\d{4})타경(\d+)/);
  const court1 = DEONAK_COURT1[courtName];
  if (!m || !court1) return null; // 파싱 실패 or 수도권 외 법원(매핑 없음) → 스킵
  const [, year, num] = m;
  await rateGate();
  // 경매(법원) 검색: frmSimple GET — list.html?court1=<법원>&syear=<연도>&sno=<사건번호>. (frm_top3 mngno는 공매라 오답.)
  await page.goto(`${BASE}${SEL.listPath}?court1=${court1}&syear=${year}&sno=${num}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  // 검색결과 행은 테마 목록과 다른 테이블에 있어 SEL.resultRow(테마 스코프)로 안 잡힘 → 넓은 셀렉터 사용.
  // AJAX 렌더라 첫 결과행이 뜰 때까지 대기(최대 8s). 0건이면 타임아웃 후 진행(빈 배열).
  const searchRowSel = 'tr[id^="tr_"]';
  await page.locator(searchRowSel).first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  await wait(rnd(900, 1900));
  if (await detectBlocked(page)) throw new SiteBlockedError();
  const rows = await parseListPage(page, searchRowSel);
  // deonakchal 행 사건번호는 "연도-번호"(예: 2025-103018) — courtauction "2025타경103018"과 형식이 달라
  // normalizeCaseNo(공백제거만)로는 안 맞음. court1으로 이미 법원 필터되므로 연도-번호 일치 행을 고른다.
  const wantDash = `${year}-${num}`;
  const chosen = chooseDeonakListRow(rows, wantDash, itemNo);
  if (!chosen) return null;
  try {
    return { productId: chosen.productId!, detail: await parseDetail(page, chosen.productId!) };
  } catch (e) {
    if (e instanceof SiteBlockedError) throw e; // 차단은 상위로 전파(즉시 중단·쿨다운)
    if (e instanceof SessionExpiredError) {
      // 밤샘 배치 중 세션 TTL 만료 대비: 재로그인 1회 후 재시도(scrapeOne과 동일 패턴). 없으면 배치 전체가 만료로 실패.
      console.warn(`[deonakchal] lookup 세션 만료 — 재로그인 후 재시도 ${caseNo}`);
      await ensureLogin(page); // SiteBlockedError는 그대로 전파
      return { productId: chosen.productId!, detail: await parseDetail(page, chosen.productId!) };
    }
    throw e;
  }
}

/**
 * [교차 보강용] 로그인된 페이지 1개 열기(세션 재사용 — 재로그인 최소화). 오케스트레이터가 이걸로 **직렬** lookup 후 close().
 *   서킷브레이커 쿨다운 중이면 null 반환(그날 건너뜀). 로그인 성공 시 쿨다운 해제.
 *   로그인 브라우저 실행 전에 launch()가 egress를 fail-closed로 검증한다.
 */
export async function openLoggedInPage(): Promise<{ page: Page; close: () => Promise<void> } | null> {
  const cd = blockCooldownRemainingMs();
  if (cd > 0) { console.warn(`[deonakchal] 서킷브레이커 쿨다운 ${Math.round(cd / 60000)}분 남음 — 이번 실행 건너뜀`); return null; }
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await ensureLogin(page);        // 세션 있으면 재로그인 안 함
    clearBlock();                   // 로그인 성공 = 계정 정상
    await page.context().storageState({ path: STORAGE }).catch(() => {}); // 갱신 세션 저장
    return { page, close: async () => { await browser.close().catch(() => {}); } };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}
