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

/** TODO(selectors): 최초 로그인 후 실제 DOM에 맞게 채울 것 */
const SEL = {
  loginId: '#login_id',         // 아이디 입력
  loginPw: '#login_pw',         // 비밀번호 입력
  loginSubmit: 'button[type=submit]',
  loggedInMarker: 'a:has-text("로그아웃")', // 로그인 성공 판별
  searchPath: '/auction/search.html',
  resultRow: 'table.list tbody tr',  // 검색 결과 행
  nextPage: 'a.next',
} as const;

async function ensureLogin(page: Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  if (await page.locator(SEL.loggedInMarker).count()) return; // 세션 유효
  const id = process.env.DEONAKCHAL_ID;
  const pw = process.env.DEONAKCHAL_PW;
  if (!id || !pw) throw new Error('DEONAKCHAL_ID / DEONAKCHAL_PW 환경변수가 필요합니다');
  // TODO(selectors): 로그인 폼 경로/셀렉터 확인 후 보정
  await page.fill(SEL.loginId, id).catch(() => {});
  await page.fill(SEL.loginPw, pw).catch(() => {});
  await page.click(SEL.loginSubmit).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  if (!(await page.locator(SEL.loggedInMarker).count())) {
    throw new Error('로그인 실패 — SEL.login* 셀렉터를 실제 DOM에 맞게 수정하세요 (CRAWL_HEADLESS=false로 점검)');
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

/**
 * 검색 결과 → 매물. SEL.resultRow 구조에 맞춰 cell 매핑을 채워야 함.
 * 여기서는 행 텍스트를 정규화 유틸로 best-effort 파싱한다.
 */
async function parseSearchPage(page: Page, source: 'deonakchal'): Promise<Listing[]> {
  const rows = page.locator(SEL.resultRow);
  const n = await rows.count();
  const out: Listing[] = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const cells = await row.locator('td').allInnerTexts();
    if (cells.length < 4) continue;
    // TODO(selectors): 컬럼 인덱스를 실제 테이블 헤더에 맞게 매핑
    const [caseRaw, typeRaw, addrRaw, apprRaw, minRaw] = cells;
    const caseNo = normalizeCaseNo(caseRaw);
    if (!/타경/.test(caseNo)) continue;
    out.push({
      caseNo,
      court: '',
      address: (addrRaw ?? '').trim(),
      propertyType: mapPropertyType(typeRaw),
      appraisalValue: parseKoreanMoney(apprRaw) ?? 0,
      minBidPrice: parseKoreanMoney(minRaw) ?? 0,
      failCount: 0,
      areaM2: parseAreaToM2(addrRaw),
      source,
      crawledAt: new Date().toISOString(),
    });
  }
  return out;
}

export class DeonakchalAdapter implements Adapter {
  name = 'deonakchal' as const;

  async crawl(filter: CrawlFilter): Promise<ScrapedListing[]> {
    const delay = parseInt(process.env.CRAWL_DELAY_MS ?? '2500', 10);
    const browser = await launch();
    const results: ScrapedListing[] = [];
    try {
      const page = await newPage(browser);
      await ensureLogin(page);
      await page.context().storageState({ path: STORAGE }); // 세션 저장

      // TODO(search): 지역/물건종류 필터를 검색 폼/쿼리스트링에 반영
      await page.goto(BASE + SEL.searchPath, { waitUntil: 'networkidle' }).catch(() => {});

      let pageNo = 1;
      while (results.length < (filter.maxItems ?? 100)) {
        const listings = await parseSearchPage(page, 'deonakchal');
        for (const l of listings) {
          if (filter.propertyTypes.length && !filter.propertyTypes.includes(l.propertyType)) continue;
          if (filter.regions.length && !filter.regions.some((r) => l.address.includes(r))) continue;
          // TODO(detail): 상세 페이지 진입 → 권리분석/임차인/등기요약/명세서 파싱하여 rightsInput·docs 채우기
          results.push({ listing: l });
          if (results.length >= (filter.maxItems ?? 100)) break;
        }
        const next = page.locator(SEL.nextPage);
        if (!(await next.count()) || pageNo >= 50) break;
        await sleep(delay); // 폴라이트
        await next.first().click().catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});
        pageNo++;
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
