/**
 * 크롤러 CLI 엔트리.
 *   npm run crawl                              # 기본 (더낙찰옥션, 수도권)
 *   npm run crawl -- --source=courtauction     # 법원경매 어댑터
 *   npm run crawl -- --max=30                  # 건수 제한
 *   npm run crawl -- --inspect                 # 셀렉터 점검용 HTML 덤프
 *   CRAWL_HEADLESS=false npm run crawl         # 브라우저 띄워 디버깅
 *
 * ─ 멀티프록시 폴백 ───────────────────────────────────────────────────
 *   CRAWL_PROXIES=socks5://home:1080,socks5://rpi:1081  (쉼표 구분)
 *   차단 감지 시 다음 프록시로 자동 전환. 모두 소진되면 courtauction 폴백.
 *
 *   단일 프록시: CRAWL_PROXY=socks5://home:1080
 *   (CRAWL_PROXIES가 우선. CRAWL_PROXY는 CRAWL_PROXIES가 없을 때만 적용)
 */
import 'dotenv/config';
import type { PropertyType } from '../shared/types.ts';
import type { Adapter, CrawlFilter } from './adapters/types.ts';
import { DeonakchalAdapter, SiteBlockedError, inspectAndDump } from './adapters/deonakchal.ts';
import { CourtAuctionAdapter, CourtAuctionBlockedError } from './adapters/courtauction.ts';
import { upsertListing, upsertListingDoc, deleteListingDocs, startCrawlRun, finishCrawlRun, fetchListingDocs, recordDocChange } from '../shared/db.ts';
import { changedDocTypes } from '../shared/doc-fingerprint.ts';

const DEFAULT_FILTER: CrawlFilter = {
  regions: ['서울', '경기', '인천'],
  propertyTypes: ['apartment', 'villa', 'officetel'] as PropertyType[],
  maxItems: 1000,
};

/** CRAWL_PROXIES 파싱 → 우선순위 목록 (없으면 CRAWL_PROXY 단일, 그것도 없으면 직접) */
function resolveProxies(): (string | undefined)[] {
  const multi = process.env.CRAWL_PROXIES;
  if (multi) return multi.split(',').map((p) => p.trim()).filter(Boolean);
  const single = process.env.CRAWL_PROXY;
  if (single) return [single];
  return [undefined]; // 프록시 없이 직접 연결
}

async function runAdapter(adapter: Adapter, filter: CrawlFilter) {
  const scraped = await adapter.crawl(filter);
  let nNew = 0;
  for (const s of scraped) {
    const id = await upsertListing(s.listing);
    nNew++;
    if (s.docs?.length) {
      // 문서 내용 변경 감지(발품절감 ⑤) — 기존 문서가 있고 내용이 달라졌으면 이력 기록(★알림용).
      try {
        const prev = (await fetchListingDocs(id)).map((d) => ({ docType: d.doc_type, parsedJson: d.parsed_json }));
        const changed = prev.length ? changedDocTypes(prev, s.docs.map((d) => ({ docType: d.docType, parsedJson: d.parsedJson }))) : [];
        if (changed.length) await recordDocChange(id, s.listing.caseNo, changed);
      } catch (e) {
        console.warn(`[docs] 변경 감지 실패(무시) ${s.listing.caseNo}:`, e instanceof Error ? e.message : e);
      }
      await deleteListingDocs(id);
      for (const doc of s.docs) await upsertListingDoc(id, doc);
    }
  }
  return { nFound: scraped.length, nNew };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--inspect')) {
    const out = await inspectAndDump();
    console.log(`검색 페이지 HTML 저장: ${out}\n→ 이 HTML을 보고 deonakchal.ts의 SEL.* 셀렉터를 채우세요.`);
    return;
  }

  const maxArg = args.find((a) => a.startsWith('--max='));
  const perCourtArg = args.find((a) => a.startsWith('--per-court='));
  const filter: CrawlFilter = {
    ...DEFAULT_FILTER,
    maxItems: maxArg ? parseInt(maxArg.split('=')[1]!, 10) : DEFAULT_FILTER.maxItems,
    ...(perCourtArg ? { perCourt: parseInt(perCourtArg.split('=')[1]!, 10) } : {}),
  };

  const forcedSource = args.find((a) => a.startsWith('--source='))?.split('=')[1];

  // ── 법원경매 어댑터 직접 지정 ───────────────────────────────────────
  if (forcedSource === 'courtauction') {
    const runId = await startCrawlRun('courtauction', filter.regions.join(','));
    try {
      const { nFound, nNew } = await runAdapter(new CourtAuctionAdapter(), filter);
      await finishCrawlRun(runId, { nFound, nNew, status: 'ok' });
      if (nFound === 0) console.warn('[courtauction] ⚠️ 0건 — VM IP 차단 의심. 집 IP 프록시 필요: docs/crawl-proxy.md');
      else console.log(`[courtauction] 수집 완료: ${nFound}건 (저장 ${nNew})`);
    } catch (e) {
      await finishCrawlRun(runId, { status: 'error', error: String(e) });
      throw e;
    }
    return;
  }

  // ── 더낙찰옥션 + 멀티프록시 폴백 ────────────────────────────────────
  const proxies = resolveProxies();
  let lastBlockError: Error | null = null;

  for (let pi = 0; pi < proxies.length; pi++) {
    const proxy = proxies[pi];
    if (proxy) {
      process.env.CRAWL_PROXY = proxy;
      console.log(`[crawl] 프록시 사용: ${proxy} (${pi + 1}/${proxies.length})`);
    } else {
      delete process.env.CRAWL_PROXY;
      console.log(`[crawl] 직접 연결 시도`);
    }

    const runId = await startCrawlRun('deonakchal', filter.regions.join(','));
    try {
      const { nFound, nNew } = await runAdapter(new DeonakchalAdapter(), filter);
      await finishCrawlRun(runId, { nFound, nNew, status: 'ok' });
      if (nFound === 0) console.warn('[crawl] ⚠️ 더낙찰 0건 수집 — status=ok지만 실제 빈손(차단/세션/필터 의심). `npm run crawl:health` 로 확인.');
      else console.log(`수집 완료: ${nFound}건 (저장 ${nNew})`);
      return; // 성공 → 종료
    } catch (e) {
      if (e instanceof SiteBlockedError) {
        lastBlockError = e;
        await finishCrawlRun(runId, { status: 'blocked', error: `차단 (프록시: ${proxy ?? '직접'})` });
        console.error(`[crawl] ⛔ 차단 감지 (프록시: ${proxy ?? '직접'})`);
        if (pi < proxies.length - 1) {
          console.log(`[crawl] → 다음 프록시로 전환 (${pi + 2}/${proxies.length})`);
          await new Promise((r) => setTimeout(r, 3000)); // 잠깐 대기 후 전환
          continue;
        }
        // 모든 프록시 소진 → 법원경매 폴백
        console.error('[crawl] 모든 프록시 차단 — 법원경매 폴백 크롤 시도');
        await runCourtAuctionFallback(filter);
        return;
      }
      await finishCrawlRun(runId, { status: 'error', error: String(e) });
      throw e;
    }
  }

  // 여기까지 오면 proxies.length === 0 (이론상 불가)
  throw lastBlockError ?? new Error('알 수 없는 오류');
}

/** 더낙찰옥션 전체 차단 시 법원경매로 기본 메타데이터만 수집 */
async function runCourtAuctionFallback(filter: CrawlFilter) {
  console.log('[crawl] 법원경매 폴백: 기본 메타만 수집 (등기/임차인 없음)');
  const runId = await startCrawlRun('courtauction', filter.regions.join(','));
  try {
    const { nFound, nNew } = await runAdapter(new CourtAuctionAdapter(), { ...filter, maxItems: 200 });
    await finishCrawlRun(runId, { nFound, nNew, status: 'ok' });
    if (nFound === 0) console.warn('[법원경매 폴백] ⚠️ 0건 — VM IP 차단 의심(status=ok지만 빈손). 집 IP 프록시 필요: docs/crawl-proxy.md');
    else console.log(`[법원경매 폴백] ${nFound}건 (저장 ${nNew}) — 더낙찰옥션 차단 해제 후 재크롤 권장`);
  } catch (e) {
    if (e instanceof CourtAuctionBlockedError) {
      await finishCrawlRun(runId, { status: 'blocked', error: '법원경매도 차단' });
      console.error('[법원경매 폴백] IP 차단 — 두 소스 모두 차단. 프록시 IP 변경 필요.');
    } else {
      await finishCrawlRun(runId, { status: 'error', error: String(e) });
    }
  }
}

main().catch((e) => {
  if (e instanceof SiteBlockedError || /SITE_BLOCKED|비정상접속/.test(String(e))) {
    console.error('⛔ 더낙찰옥션 차단 — 프록시 IP를 변경하거나 내일 재시도.');
    process.exitCode = 0;
    return;
  }
  if (e instanceof CourtAuctionBlockedError || /COURT_BLOCKED/.test(String(e))) {
    console.error('⛔ 법원경매 IP 차단 — 로컬 PC 또는 Raspberry Pi에서 실행 필요.');
    process.exitCode = 0;
    return;
  }
  console.error(e);
  process.exitCode = 1;
});
