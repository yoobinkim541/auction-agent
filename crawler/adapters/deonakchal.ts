/**
 * 더낙찰옥션(더낙찰옥션.com) 어댑터 — 메인 데이터 소스.
 *
 * 전제: 본인 구독 계정으로 로그인하여 '개인 이용' 목적으로만 수집한다.
 * 폴라이트 정책: 직렬 요청 + CRAWL_DELAY_MS 지연 + 세션 재사용 + 정직한 User-Agent.
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
  parseKoreanMoney, parseKoreanDate, mapPropertyType, mapRightKind,
  normalizeCaseNo, parseAreaToM2,
} from '../normalize.ts';

const BASE = 'https://www.xn--b20bu5cuwtpue8ui.com'; // 더낙찰옥션.com (punycode)
const AUTH_DIR = '.auth';
const STORAGE = path.join(AUTH_DIR, 'deonakchal.json');
const UA = 'gyeongmae-agent/0.1 (personal research; contact: owner)';

/** 로그인 폼은 /members/login.html 의 #frmLogin (id/pw, action=javascript:tryLogin()) — 실제 확인됨.
 *  검색 결과 행/페이지 셀렉터는 로그인 후 search HTML 덤프로 확정 필요(TODO). */
const SEL = {
  loginPath: '/members/login.html',
  loginId: '#id',
  loginPw: '#pw',
  loginSubmit: '#frmLogin input[type=submit]',
  loggedInMarker: 'text=로그아웃', // 로그인 성공 판별
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
// 종결/취하 등 입찰 불가 상태(건너뜀)
const TERMINAL = /(배당종결|취하|기각|각하|낙찰|대금납부|^배당|취소)/;
// 특수권리 플래그(목록의 [..] 표기) — 엔진 레드플래그 스캐너가 인식
const FLAG_TOKENS = ['유치권', '법정지상권', '분묘', '대지권미등기', '토지별도등기', '임금채권', '대항력있는임차인', '선순위', '지분', '농지', '제시외'];

// ── 휴먼 페이싱: 사람이 매물을 '보는' 것처럼 수집(차단 임계치 회피용 폴라이트 정책) ──
//   가변 지연 + 페이지 스크롤(읽기) + 중간 휴식 + 기본 직렬(1건씩). IP/UA 위장·봇탐지 우회 없음.
const rnd = (min: number, max: number) => min + Math.random() * (max - min);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.round(ms)));
/** 한 매물을 '읽는' 시간: 보통 4~10초, 가끔(12%)은 15~28초(딴짓하듯) */
const humanDwellMs = () => (Math.random() < 0.12 ? rnd(15000, 28000) : rnd(4000, 10000));
// 전역 최소 요청 간격(하드코딩 백스톱) — CRAWL_CONCURRENCY를 높여도 사이트 부하가
//   이 이하로 절대 못 내려가게 보장(분석 결과: 차단은 IP·세션당 요청 '속도/양' 기반).
const MIN_REQ_INTERVAL_MS = 2500;
let _nextReqAt = 0;
async function rateGate(): Promise<void> {
  const now = Date.now();
  const w = Math.max(0, _nextReqAt - now);
  _nextReqAt = Math.max(now, _nextReqAt) + MIN_REQ_INTERVAL_MS;
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

async function ensureLogin(page: Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // 차단 상태면 로그인 시도 자체가 무의미 → 즉시 중단(타임아웃 대신 명확한 에러)
  const blocked = await page.evaluate(() => /비정상접속|접속을\s*차단/.test(document.documentElement.innerHTML)).catch(() => false);
  if (blocked) throw new SiteBlockedError();
  if (await page.locator(SEL.loggedInMarker).count()) return; // 세션 유효
  const id = process.env.DEONAKCHAL_ID;
  const pw = process.env.DEONAKCHAL_PW;
  if (!id || !pw) throw new Error('DEONAKCHAL_ID / DEONAKCHAL_PW 환경변수가 필요합니다');
  await page.goto(BASE + SEL.loginPath, { waitUntil: 'domcontentloaded' });
  // 로그인 폼이 안 뜨면(차단 페이지 등) page.fill 이 30s 행에 빠진 뒤 raw TimeoutError → 깔끔히 차단 감지로 대체.
  const formReady = await page.locator(SEL.loginId).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!formReady) {
    const blockedNow = await page.evaluate(() => /비정상접속|접속을\s*차단|차단되었습니다/.test(document.documentElement.innerHTML)).catch(() => false);
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
    throw new Error('로그인 실패 — 계정/셀렉터 확인 필요 (CRAWL_HEADLESS=false로 점검)');
  }
}

/** 최초 셀렉터 작성을 돕는 진단: 검색 페이지 HTML을 tmp에 저장 */
export async function inspectAndDump(): Promise<string> {
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await ensureLogin(page);
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
  return chromium.launch({ headless: process.env.CRAWL_HEADLESS !== 'false' });
}
async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    userAgent: UA,
    storageState: fs.existsSync(STORAGE) ? STORAGE : undefined,
  });
  return ctx.newPage();
}

interface ParsedRow { listing: Listing; notes: string[]; productId?: string }

/** 결과 행 텍스트를 정규식으로 파싱. 종결/취하 등 입찰불가 상태는 제외. */
async function parseListPage(page: Page): Promise<ParsedRow[]> {
  const rows = page.locator(SEL.resultRow);
  const n = await rows.count();
  const out: ParsedRow[] = [];
  for (let i = 0; i < n; i++) {
    const rid = (await rows.nth(i).getAttribute('id').catch(() => '')) ?? '';
    const productId = rid.startsWith('tr_') ? rid.slice(3) : undefined;
    const text = (await rows.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const head = text.match(/(\S+계)\s+(20\d\d-\d{3,6}(?:-\d+)?)\s+\[([^\]]+)\]/);
    if (!head) continue;
    const [, court, caseNo, typeLabel] = head;

    const status = text.match(/(신건|유찰|진행|배당종결|취하|기각|각하|낙찰|변경|재진행|재매각|미진행|대금납부|배당)\s*\((\d+)%\)/);
    if (status && TERMINAL.test(status[1]!)) continue; // 진행 매물만 수집

    const am = text.match(/감정가\s*([\d,]+)\s*최저가\s*([\d,]+)/);
    const addrM = text.match(/((?:서울특별시|인천광역시|경기도)[^[]*?)\s*(?:건물|토지|감정가)/);
    const bldM = text.match(/건물\s*([\d.]+)\s*㎡/);
    const dates = text.match(/20\d\d-\d\d-\d\d/g) ?? [];
    const notes = FLAG_TOKENS
      .filter((t) => new RegExp(`\\[[^\\]]*${t}[^\\]]*\\]`).test(text))
      .map((t) => `목록 특수권리 표기: ${t}`);

    out.push({
      listing: {
        caseNo: normalizeCaseNo(caseNo),
        court: court!,
        address: addrM ? addrM[1]!.trim() : '(소재지 미상)',
        propertyType: mapPropertyType(typeLabel),
        appraisalValue: parseKoreanMoney(am?.[1]) ?? 0,
        minBidPrice: parseKoreanMoney(am?.[2]) ?? 0,
        minBidRatio: status ? parseInt(status[2]!, 10) : undefined,
        failCount: 0,
        saleDate: dates.length ? dates[dates.length - 1] : undefined,
        areaM2: bldM ? parseFloat(bldM[1]!) : parseAreaToM2(text),
        isCollectiveBuilding: /아파트|오피스텔|다세대|연립|도시형생활/.test(typeLabel!),
        source: 'deonakchal',
        sourceUrl: BASE + SEL.listPath,
        rawJson: { rowText: text, status: status?.[1] },
        crawledAt: new Date().toISOString(),
      },
      notes,
      productId,
    });
  }
  return out;
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
    try {
      const d = await parseDetail(page, c.productId);
      const allNotes = [...c.notes, ...d.notes];
      listing = { ...listing, sourceUrl: `${BASE}/auction/view.html?product_id=${c.productId}` };
      docs.push({
        caseNo: listing.caseNo, docType: 'registry_summary',
        parsedJson: { registry: d.registry, siteAssumedAmount: d.siteAssumedAmount, statementSeniorDate: extractSeniorDate(allNotes) },
      });
      docs.push({ caseNo: listing.caseNo, docType: 'sale_statement', parsedJson: { tenants: d.tenants, notes: allNotes } });
      if (d.appraisal) docs.push({ caseNo: listing.caseNo, docType: 'appraisal_report', parsedJson: d.appraisal });
      if (d.siteMetrics && Object.keys(d.siteMetrics).length) docs.push({ caseNo: listing.caseNo, docType: 'site_metrics', parsedJson: d.siteMetrics });
    } catch (e) {
      if (e instanceof SiteBlockedError) throw e; // 차단은 상위로 전파해 전체 중단
      console.warn(`[deonakchal] 상세 파싱 실패 ${c.listing.caseNo}: ${e}`);
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
    const delay = parseInt(process.env.CRAWL_DELAY_MS ?? '2500', 10);
    const maxItems = filter.maxItems ?? 50;
    const maxPagesPerTheme = parseInt(process.env.CRAWL_MAX_PAGES ?? '80', 10);

    const browser = await launch();
    const collected: ParsedRow[] = [];
    const seen = new Set<string>();
    try {
      const page = await newPage(browser);
      await ensureLogin(page);
      await page.context().storageState({ path: STORAGE }); // 세션 저장

      // Phase 1: 테마 페이지네이션 → 지역/종류 필터 → 목록 수집 (사람처럼 페이지마다 쉬며)
      for (const opt of THEME_OPTS) {
        for (let p = 1; p <= maxPagesPerTheme && collected.length < maxItems; p++) {
          const url = `${BASE}${SEL.themePath}?opt=${opt}&page=${p}`;
          await rateGate(); // 전역 속도 상한
          await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
          await wait(rnd(1200, 2600));
          const blk = await page.evaluate(() => /비정상접속|접속을\s*차단/.test(document.documentElement.innerHTML)).catch(() => false);
          if (blk) throw new SiteBlockedError();
          await humanScroll(page);
          const rows = await parseListPage(page);
          if (rows.length === 0) break;
          let newOnPage = 0;
          for (const r of rows) {
            if (seen.has(r.listing.caseNo)) continue;
            seen.add(r.listing.caseNo);
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
      void delay;

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
              console.error(`[deonakchal] ⛔ 사이트 접속 차단 감지 — 크롤 중단(${done}/${collected.length} 수집). 사람처럼 더 천천히/내일 재시도 권장.`);
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
      amount: parseKoreanMoney(ln),
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
  building.mainUse = body.match(/주용도\s*([가-힣,·]+)/)?.[1];
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
  constructor() { super('SITE_BLOCKED: 더낙찰옥션 비정상접속 차단'); this.name = 'SiteBlockedError'; }
}

export async function parseDetail(page: Page, productId: string): Promise<DetailData> {
  // 사람처럼: 페이지를 열고 → 잠시 보고 → 천천히 스크롤(읽기). 빈 페이지면 1회 새로고침 재시도.
  let loaded = false;
  for (let attempt = 1; attempt <= 2 && !loaded; attempt++) {
    await rateGate(); // 전역 속도 상한(설정 무관 백스톱)
    await page.goto(`${BASE}/auction/view.html?product_id=${productId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await wait(rnd(900, 1900)); // 페이지 훑어보는 텀
    const probe = await page.evaluate(() => ({ html: document.documentElement.innerHTML.slice(0, 600), tables: document.querySelectorAll('table').length })).catch(() => ({ html: '', tables: 0 }));
    if (/비정상접속|접속을\s*차단|abuse|blocked/i.test(probe.html)) throw new SiteBlockedError();
    if (probe.tables > 0) { loaded = true; break; }
    // 표 미로딩: 사람처럼 잠깐 더 기다렸다 확인(최대 ~6초)
    for (let i = 0; i < 12 && !loaded; i++) {
      await wait(500);
      const r2 = await page.evaluate(() => ({ blk: /비정상접속|접속을\s*차단/.test(document.documentElement.innerHTML), n: document.querySelectorAll('table').length })).catch(() => ({ blk: false, n: 0 }));
      if (r2.blk) throw new SiteBlockedError();
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
      deposit: parseKoreanMoney(joined.match(/보증금\s*:?\s*([\d,]+)/)?.[1]) ?? 0,
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
