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
import type { Listing } from '../../shared/types.ts';
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
// 아파트(2,3) + 혼합형(26 오늘공고신건, 27 역세권물건, 25 특수물건)을 모아 클라이언트에서 종류 필터.
//  - 27(역세권): 다세대(빌라)·도시형생활주택 포함 / 26·25: 오피스텔·상가 등 혼합
//  혼합/빌라 테마를 앞에 두어 maxItems가 아파트로만 채워지지 않게 함.
const THEME_OPTS = ['27', '26', '25', '2', '3'];
// 종결/취하 등 입찰 불가 상태(건너뜀)
const TERMINAL = /(배당종결|취하|기각|각하|낙찰|대금납부|^배당|취소)/;
// 특수권리 플래그(목록의 [..] 표기) — 엔진 레드플래그 스캐너가 인식
const FLAG_TOKENS = ['유치권', '법정지상권', '분묘', '대지권미등기', '토지별도등기', '임금채권', '대항력있는임차인', '선순위', '지분', '농지', '제시외'];

async function ensureLogin(page: Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  if (await page.locator(SEL.loggedInMarker).count()) return; // 세션 유효
  const id = process.env.DEONAKCHAL_ID;
  const pw = process.env.DEONAKCHAL_PW;
  if (!id || !pw) throw new Error('DEONAKCHAL_ID / DEONAKCHAL_PW 환경변수가 필요합니다');
  await page.goto(BASE + SEL.loginPath, { waitUntil: 'domcontentloaded' });
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

interface ParsedRow { listing: Listing; notes: string[] }

/** 결과 행 텍스트를 정규식으로 파싱. 종결/취하 등 입찰불가 상태는 제외. */
async function parseListPage(page: Page): Promise<ParsedRow[]> {
  const rows = page.locator(SEL.resultRow);
  const n = await rows.count();
  const out: ParsedRow[] = [];
  for (let i = 0; i < n; i++) {
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
    });
  }
  return out;
}

export class DeonakchalAdapter implements Adapter {
  name = 'deonakchal' as const;

  async crawl(filter: CrawlFilter): Promise<ScrapedListing[]> {
    const delay = parseInt(process.env.CRAWL_DELAY_MS ?? '2500', 10);
    const maxItems = filter.maxItems ?? 50;
    const maxPagesPerTheme = 30;

    const browser = await launch();
    const results: ScrapedListing[] = [];
    const seen = new Set<string>();
    try {
      const page = await newPage(browser);
      await ensureLogin(page);
      await page.context().storageState({ path: STORAGE }); // 세션 저장

      // 진행 아파트 테마를 페이지네이션 → 지역/종류 클라이언트 필터
      for (const opt of THEME_OPTS) {
        for (let p = 1; p <= maxPagesPerTheme && results.length < maxItems; p++) {
          const url = `${BASE}${SEL.themePath}?opt=${opt}&page=${p}`;
          await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
          await page.waitForTimeout(800);
          const rows = await parseListPage(page);
          if (rows.length === 0) break;
          let newOnPage = 0;
          for (const { listing, notes } of rows) {
            if (seen.has(listing.caseNo)) continue;
            seen.add(listing.caseNo);
            newOnPage++;
            if (filter.propertyTypes.length && !filter.propertyTypes.includes(listing.propertyType)) continue;
            if (filter.regions.length && !filter.regions.some((r) => listing.address.includes(r))) continue;
            const docs = notes.length
              ? [{ caseNo: listing.caseNo, docType: 'rights_summary' as const, parsedJson: { notes } }]
              : undefined;
            results.push({ listing, docs });
            if (results.length >= maxItems) break;
          }
          if (newOnPage === 0) break; // 동일 페이지 반복 → 종료
          await sleep(delay); // 폴라이트
        }
      }
    } finally {
      await browser.close();
    }
    return results;
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
