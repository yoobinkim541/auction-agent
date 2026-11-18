/**
 * 크롤러 CLI 엔트리.
 *   npm run crawl                              # 기본 (더낙찰옥션, 수도권)
 *   npm run crawl -- --source=courtauction     # 법원경매 어댑터
 *   npm run crawl -- --max=30                  # 건수 제한
 *   npm run crawl -- --inspect                 # 셀렉터 점검용 HTML 덤프
 *   npm run crawl -- --source=courtauction --photos-only --photo-max=50  # 사진 없는 기존 물건만 bounded 보강
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
import type { Adapter, CrawlFilter, ScrapedListing } from './adapters/types.ts';
import { DeonakchalAdapter, SiteBlockedError, inspectAndDump } from './adapters/deonakchal.ts';
import { CourtAuctionAdapter, CourtAuctionBlockedError } from './adapters/courtauction.ts';
import { upsertListing, upsertListingDoc, deleteListingDocs, startCrawlRun, finishCrawlRun, fetchListingDocs, recordDocChange, recordCompetitionSnapshot, query } from '../shared/db.ts';
import { changedDocTypes } from '../shared/doc-fingerprint.ts';
import { cacheListingPhotos } from '../shared/listing-photos.ts';

const DEFAULT_FILTER: CrawlFilter = {
  regions: ['서울', '경기', '인천'],
  propertyTypes: [] as PropertyType[],
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

async function saveScrapedListing(s: ScrapedListing): Promise<void> {
  const id = await upsertListing(s.listing);
  // 경쟁 열기 시계열 — 일별 관심수/조회수 스냅샷(★급증 알림·추세 신호용). 실패는 치명 아님.
  await recordCompetitionSnapshot(s.listing).catch(() => {});
  const photoDoc = s.docs?.find((doc) => doc.docType === 'site_metrics');
  const photoValues = (photoDoc?.parsedJson as { photos?: unknown } | undefined)?.photos;
  if (Array.isArray(photoValues)) {
    const photoSources = photoValues.filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (photoSources.length) {
      try {
        await cacheListingPhotos(id, s.listing.caseNo, s.listing.itemNo ?? '1', photoSources);
      } catch (error) {
        console.warn(`[crawl] 사진 캐시 실패 ${s.listing.caseNo}/${s.listing.itemNo ?? '1'}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
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

async function runAdapter(adapter: Adapter, filter: CrawlFilter) {
  let streamed = false;
  let blocked = false;
  let nFound = 0;
  let nNew = 0;
  const scraped = await adapter.crawl(filter, {
    onBlocked: () => { blocked = true; },
    onListing: async (s) => {
      streamed = true;
      await saveScrapedListing(s);
      nFound++;
      nNew++;
      if (nFound % 100 === 0) console.log(`[crawl] 중간 저장 ${nFound}건`);
    },
  });
  if (!streamed) {
    for (const s of scraped) {
      await saveScrapedListing(s);
      nFound++;
      nNew++;
    }
  }
  return { nFound, nNew, blocked };
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
  const photosOnly = args.includes('--photos-only');
  const photoMaxArg = args.find((a) => a.startsWith('--photo-max='));
  const filter: CrawlFilter = {
    ...DEFAULT_FILTER,
    maxItems: maxArg ? parseInt(maxArg.split('=')[1]!, 10) : DEFAULT_FILTER.maxItems,
    ...(perCourtArg ? { perCourt: parseInt(perCourtArg.split('=')[1]!, 10) } : {}),
    ...(photosOnly ? { photosOnly: true, maxPhotoDetails: photoMaxArg ? parseInt(photoMaxArg.split('=')[1]!, 10) : 50 } : {}),
    // --all-types: 물건종류 필터 해제(토지·상가·단독·기타 포함) — 전 지역 "하나도 빠짐없이" 수집용
    ...(args.includes('--all-types') ? { propertyTypes: [] } : {}),
    // --all-types-courts=B000214,...: 지정 법원만 전종류(집 근처 남양주 일대=의정부만 완전 수집, 나머지는 주거용 유지)
    ...(() => { const a = args.find((x) => x.startsWith('--all-types-courts=')); return a ? { allTypesCourts: a.split('=')[1]!.split(',').filter(Boolean) } : {}; })(),
    // --region=의정부,수원: 특정 지역/법원만 크롤(타겟 캐치업용). 미지정 시 DEFAULT_FILTER(수도권 전역).
    ...(() => { const a = args.find((x) => x.startsWith('--region=')); return a ? { regions: a.split('=')[1]!.split(',').filter(Boolean) } : {}; })(),
  };

  const forcedSource = args.find((a) => a.startsWith('--source='))?.split('=')[1];

  // ── 법원경매 어댑터 직접 지정 ───────────────────────────────────────
  if (forcedSource === 'courtauction') {
    // 증분 모드: 이미 권리분석된 물건은 상세를 건너뛰고 메타만 갱신 → 신규만 풀 파싱(정기 배치용).
    if (args.includes('--incremental')) {
      // "이미 파싱됨" 기준은 문서(gm_listing_docs) 존재 — fetchDetail이 만드는 산출물 그 자체.
      // (권리분석 행 기준은 오답: analyze가 문서 없는 이월 물건에도 review_required 행을 만들어
      //  영영 상세를 못 받는 오염 발생 — 2026-07-11 1,243건 실측.)
      const known = await query<{ k: string }>(
        `select court || '|' || case_no || '|' || item_no as k from gm_listings l
          where exists (select 1 from gm_listing_docs d where d.listing_id = l.id)`,
      );
      filter.incremental = true;
      filter.knownKeys = new Set(known.map((r) => r.k));
      delete filter.perCourt; // 전 페이지 스윕(법원당 캡 없음) — maxItems만 안전상한
      // 신규 상세 예산: 배치 실행시간 유계화(systemd 타임아웃·차단 예방). 초과분은 메타만 저장 → 다음 실행에서 이어감.
      const maxNewArg = args.find((a) => a.startsWith('--max-new='));
      filter.maxNewDetails = maxNewArg ? parseInt(maxNewArg.split('=')[1]!, 10) : 200;
      // 임박(기본 14일) 기존 물건 상세 재수집 — 명세서 갱신 감지(recordDocChange)용. 일일 상한(기본 250)으로 시간 유계화.
      const refreshDaysArg = args.find((a) => a.startsWith('--refresh-days='));
      const maxRefreshArg = args.find((a) => a.startsWith('--max-refresh='));
      filter.refreshImminentDays = refreshDaysArg ? parseInt(refreshDaysArg.split('=')[1]!, 10) : 14;
      filter.maxRefreshDetails = maxRefreshArg ? parseInt(maxRefreshArg.split('=')[1]!, 10) : 250;
      // 명세서는 매각 임박해서야 공개된다 — 그 전에 받아 최선순위설정이 빈 물건은 공개 창에 들어온 뒤 다시 받아야 권리분석이 된다.
      // 재수집 예산은 그대로 두고(차단 예방) 그 예산을 이 물건들에 먼저 쓴다. 안전마진 큰 순 = 통과 후보가 될 가능성이 큰 순.
      // 공개 창 안에서 이미 다시 받은 물건(created_at 기준)은 또 받아도 같으므로 제외.
      if (filter.refreshImminentDays > 0 && filter.maxRefreshDetails > 0) {
        const pending = await query<{ k: string }>(
          `select l.court || '|' || l.case_no || '|' || l.item_no as k
             from gm_listings l
             join gm_listing_docs d on d.listing_id = l.id and d.doc_type = 'registry_summary'
             left join gm_location_analysis a on a.listing_id = l.id
            cross join (select (now() at time zone 'Asia/Seoul')::date as today) kst
            where l.source = 'courtauction'
              and l.sale_date between kst.today and kst.today + $1::int
              and jsonb_array_length(coalesce(d.parsed_json->'registry', '[]'::jsonb)) = 0
              and l.sale_date - (d.created_at at time zone 'Asia/Seoul')::date > $1::int
            order by a.safety_margin desc nulls last, l.sale_date, l.id
            limit $2`,
          [filter.refreshImminentDays, filter.maxRefreshDetails],
        );
        filter.refreshKeys = new Set(pending.map((r) => r.k));
      }
      console.log(`[courtauction] 증분 모드: 기존 문서보유 ${filter.knownKeys.size}건 → 상세 skip(임박 ${filter.refreshImminentDays}일 내는 재수집 — 명세서 공개 전 수집분 ${filter.refreshKeys?.size ?? 0}건 우선), 신규 파싱 예산 ${filter.maxNewDetails}건/회`);
    }
    if (photosOnly) {
      const photos = await query<{ k: string }>(
        `select distinct l.court || '|' || l.case_no || '|' || l.item_no as k
           from gm_listing_photos p
           join gm_listings l on l.id = p.listing_id
          where p.status='active'`,
      );
      filter.photosOnly = true;
      filter.photoKeys = new Set(photos.map((row) => row.k));
      filter.incremental = true;
      console.log(`[courtauction] 사진 보강 모드: 활성 사진 보유 ${filter.photoKeys.size}건, 상세 예산 ${filter.maxPhotoDetails ?? 50}건`);
    }
    const runId = await startCrawlRun('courtauction', filter.regions.join(','));
    try {
      const { nFound, nNew, blocked } = await runAdapter(new CourtAuctionAdapter(), filter);
      // 도중 차단은 남은 법원을 못 돈 것 — ok 로 남기면 대시보드·알림이 정상으로 본다. 저장분은 유효하니 건수는 남긴다.
      await finishCrawlRun(runId, blocked
        ? { nFound, nNew, status: 'blocked', error: `IP 차단으로 중단 — ${nFound}건까지 저장` }
        : { nFound, nNew, status: 'ok' });
      if (blocked) process.exitCode = 1; // daily-parse.sh 의 당일 크롤 실패 알림으로 이어진다
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
