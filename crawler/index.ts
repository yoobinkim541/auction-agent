/**
 * 크롤러 CLI 엔트리.
 *   npm run crawl                 # 기본 필터(수도권, 아파트/다세대·연립·오피스텔)로 수집
 *   npm run crawl -- --inspect    # 최초 셀렉터 작성용: 검색 페이지 HTML 덤프
 *   npm run crawl -- --max=30     # 최대 건수 제한
 *   CRAWL_HEADLESS=false npm run crawl -- --inspect   # 브라우저 띄워 로그인 점검
 */
import 'dotenv/config';
import type { PropertyType } from '../shared/types.ts';
import type { Adapter, CrawlFilter } from './adapters/types.ts';
import { DeonakchalAdapter, inspectAndDump } from './adapters/deonakchal.ts';
import { upsertListing, upsertListingDoc, deleteListingDocs, startCrawlRun, finishCrawlRun } from '../shared/db.ts';

const DEFAULT_FILTER: CrawlFilter = {
  regions: ['서울', '경기', '인천'],
  propertyTypes: ['apartment', 'villa', 'officetel'] as PropertyType[],
  maxItems: 1000,
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--inspect')) {
    const out = await inspectAndDump();
    console.log(`검색 페이지 HTML 저장: ${out}\n→ 이 HTML을 보고 deonakchal.ts의 SEL.* 셀렉터를 채우세요.`);
    return;
  }

  const maxArg = args.find((a) => a.startsWith('--max='));
  const filter: CrawlFilter = {
    ...DEFAULT_FILTER,
    maxItems: maxArg ? parseInt(maxArg.split('=')[1]!, 10) : DEFAULT_FILTER.maxItems,
  };

  const adapter: Adapter = new DeonakchalAdapter();
  const runId = await startCrawlRun(adapter.name, filter.regions.join(','));
  try {
    const scraped = await adapter.crawl(filter);
    let nNew = 0;
    for (const s of scraped) {
      const id = await upsertListing(s.listing);
      nNew++;
      if (s.docs?.length) {
        await deleteListingDocs(id); // 재크롤 시 문서 중복 방지
        for (const doc of s.docs) await upsertListingDoc(id, doc);
      }
    }
    await finishCrawlRun(runId, { nFound: scraped.length, nNew, status: 'ok' });
    console.log(`수집 완료: ${scraped.length}건 (저장 ${nNew})`);
  } catch (e) {
    await finishCrawlRun(runId, { status: 'error', error: String(e) });
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
