/**
 * 분석 오케스트레이터.
 *   npm run analyze              # 미분석 매물에 대해 권리분석→입지분석→점수화 실행
 *   npm run analyze -- --verify  # 권리분석에 Claude 2차 검증 추가(ANTHROPIC_API_KEY 필요)
 *
 * 파이프라인: 매물 로드 → (등기/임차인 문서로) RightsInput 구성 → analyzeRights
 *   → analyzeLocation(실거래가/POI) → maxSafeBid 산정 → scoreListing → 저장.
 */
import 'dotenv/config';
import {
  saveRightsAnalysis, saveLocationAnalysis, saveScore,
  fetchListingsForAnalysis, fetchListingDocs, type ListingRow,
} from '../shared/db.ts';
import type { Listing, RightsInput, RegistryEntry, Tenant, SiteMetrics } from '../shared/types.ts';
import { analyzeRights } from './rights/engine.ts';
import { analyzeLocation } from './location/index.ts';
import { scoreListing, maxSafeBid, DEFAULT_SCORE_CONFIG } from './select/score.ts';
import { computeAcquisitionCost, expectedBid, marketFromSiteComps, classifyLandUseFlags } from './cost/acquisition.ts';
import { buildReport } from './report/build.ts';
import { attachGlossary } from './report/glossary.ts';
import { assessLegalRisk } from './legal/risk.ts';

/** 사용자 취득세 가정(개인 1주택 기본). 다주택/법인이면 여기 또는 향후 설정에서 조정. */
const TAX_ASSUMPTION = { homeCountAfter: 1 } as const;

const num = (v: string | number | null): number => (v == null ? 0 : typeof v === 'number' ? v : parseFloat(v));

function rowToListing(r: ListingRow): Listing {
  return {
    caseNo: r.case_no,
    court: r.court,
    address: r.address,
    roadAddress: r.road_address ?? undefined,
    lat: r.lat ?? undefined,
    lng: r.lng ?? undefined,
    propertyType: r.property_type,
    appraisalValue: num(r.appraisal_value),
    minBidPrice: num(r.min_bid_price),
    failCount: r.fail_count ?? 0,
    saleDate: r.sale_date ?? undefined,
    demandDeadline: r.demand_deadline ?? undefined,
    areaM2: r.area_m2 != null ? num(r.area_m2) : undefined,
    isCollectiveBuilding: r.is_collective_building ?? false,
    source: r.source,
    sourceUrl: r.source_url ?? undefined,
    crawledAt: new Date().toISOString(),
  };
}

/** 등기/임차인 문서(parsed_json)로 RightsInput을 구성. 없으면 빈 입력(엔진이 경고). */
async function buildRightsInput(listingId: number, listing: Listing): Promise<{ input: RightsInput; siteAssumed: number | null; appraisalHighlights: string[]; siteMetrics: SiteMetrics; gongPrice?: number; scanNotes: string[]; appraisalText: string }> {
  const data = await fetchListingDocs(listingId);

  let registry: RegistryEntry[] = [];
  let landRegistry: RegistryEntry[] | undefined;
  let tenants: Tenant[] = [];
  let statementSeniorDate: string | undefined;
  let siteAssumed: number | null = null;
  let appraisalHighlights: string[] = [];
  let siteMetrics: SiteMetrics = {};
  let gongPrice: number | undefined;
  let appraisalText = '';
  const notes: string[] = [];

  for (const d of data) {
    const p = d.parsed_json ?? {};
    if (d.doc_type === 'appraisal_report') {
      if (Array.isArray(p.highlights)) appraisalHighlights = p.highlights as string[];
      if (typeof p.gongPrice === 'number') gongPrice = p.gongPrice;
      if (typeof p.text === 'string') appraisalText = p.text as string;
    }
    if (d.doc_type === 'site_metrics') siteMetrics = p as SiteMetrics;
    if (d.doc_type === 'registry_summary') {
      if (Array.isArray(p.registry)) registry = p.registry as RegistryEntry[];
      if (Array.isArray(p.landRegistry)) landRegistry = p.landRegistry as RegistryEntry[];
      if (typeof p.siteAssumedAmount === 'number') siteAssumed = p.siteAssumedAmount;
      if (typeof p.statementSeniorDate === 'string') statementSeniorDate = p.statementSeniorDate;
    }
    if (d.doc_type === 'sale_statement') {
      if (Array.isArray(p.tenants)) tenants = p.tenants as Tenant[];
      if (typeof p.statementSeniorDate === 'string') statementSeniorDate = p.statementSeniorDate;
    }
    if (d.doc_type === 'survey_report' && Array.isArray(p.tenants) && tenants.length === 0) {
      tenants = p.tenants as Tenant[];
    }
    if (typeof p.notes === 'string') notes.push(p.notes);
    if (Array.isArray(p.notes)) notes.push(...p.notes);
  }

  return {
    input: {
      listing: {
        caseNo: listing.caseNo,
        court: listing.court,
        address: listing.address,
        minBidPrice: listing.minBidPrice,
        appraisalValue: listing.appraisalValue,
        demandDeadline: listing.demandDeadline,
        isCollectiveBuilding: listing.isCollectiveBuilding,
      },
      registry,
      landRegistry,
      tenants,
      statementSeniorDate,
      notes,
    },
    siteAssumed,
    appraisalHighlights,
    siteMetrics,
    gongPrice,
    scanNotes: notes,
    appraisalText,
  };
}

async function main() {
  const withVerify = process.argv.includes('--verify');

  const reanalyzeAll = process.argv.includes('--all');
  const listings = await fetchListingsForAnalysis(2000, !reanalyzeAll);
  const concurrency = Math.max(1, parseInt(process.env.ANALYZE_CONCURRENCY ?? '6', 10));
  console.log(`분석 대상 매물: ${listings.length}건 ${reanalyzeAll ? '(전체 재분석)' : '(신규만 — 전체는 --all)'} | 병렬 ${concurrency}`);

  // 검증 모드 결정: claude CLI(Max 구독, 과금 0) 우선 → API 키 → 생략
  let verifyMode: 'cli' | 'api' | 'none' = 'none';
  if (withVerify) {
    const { claudeCliAvailable } = await import('./rights/claude-verify-cli.ts');
    if (await claudeCliAvailable()) verifyMode = 'cli';
    else if (process.env.ANTHROPIC_API_KEY) verifyMode = 'api';
    console.log(`[verify] 모드: ${verifyMode}${verifyMode === 'cli' ? ' (Claude Max 구독, 추가 과금 없음)' : ''}`);
  }

  let cursor = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
   for (;;) {
    const idx = cursor++;
    if (idx >= listings.length) break;
    const r = listings[idx]!;
    const listing = rowToListing(r);
    try {
      // 1) 권리분석 (결정형 엔진) + 사이트 예상 낙찰자인수(권위값) 반영
      const { input, siteAssumed, appraisalHighlights, siteMetrics, gongPrice, scanNotes, appraisalText } = await buildRightsInput(r.id, listing);
      const rights = analyzeRights(input);
      if (siteAssumed != null) {
        if (siteAssumed !== rights.assumedAmount) {
          rights.warnings.push(`인수금액: 엔진추정 ${rights.assumedAmount.toLocaleString('ko-KR')}원 / 사이트 ${siteAssumed.toLocaleString('ko-KR')}원(예상배당 기준 적용)`);
        }
        rights.assumedAmount = siteAssumed;
        if (siteAssumed > 0) rights.assumedBreakdown = [{ label: '사이트 예상 낙찰자인수', amount: siteAssumed, reason: '더낙찰옥션 예상배당표 기준' }];
        rights.isClean = siteAssumed === 0 && rights.riskGrade !== 'review_required' && !rights.redFlags.some((f) => f.severity === 'danger');
        if (siteAssumed > 0 && (rights.riskGrade === 'clean' || rights.riskGrade === 'caution')) rights.riskGrade = 'risky';
      }

      // 2) 입지분석 (+ 감정평가요항 하이라이트)
      const loc = await analyzeLocation(listing, { tradeMonths: 12 });
      if (appraisalHighlights.length) loc.devSignals = appraisalHighlights;

      // 2-b) 상세페이지 부가요소 통합 (역세권·표제부·매각기일·규제·동일건물 실거래·예상낙찰가·총취득비용)
      loc.saleRounds = siteMetrics.saleRounds;
      loc.building = siteMetrics.building;
      loc.adminOffices = siteMetrics.adminOffices;
      loc.siteComps = siteMetrics.siteComps;
      loc.photos = siteMetrics.photos;
      loc.landUseFlags = classifyLandUseFlags(siteMetrics.landUseText);
      if (siteMetrics.transit?.length) {
        const nearest = [...siteMetrics.transit].sort((a, b) => a.distanceM - b.distanceM)[0]!;
        const lines = new Set(siteMetrics.transit.map((t) => t.line)).size;
        loc.transit = { ...loc.transit, nearestStation: `${nearest.line} ${nearest.station} ${nearest.distanceM}m`, lines, stations: siteMetrics.transit };
      }

      // 시세 보강: 사이트 동일건물 실거래(동일면적 ≥2건)는 신뢰도 최상 → 우선 채택, MOLIT는 교차검증으로 남김
      const siteMarket = marketFromSiteComps(siteMetrics.siteComps, listing.areaM2);
      if (siteMarket.price && siteMarket.n >= 2) {
        if (loc.marketPrice && Math.abs(loc.marketPrice - siteMarket.price) / siteMarket.price > 0.05) {
          loc.compBasis = `${siteMarket.basis} ${(siteMarket.price / 1e8).toFixed(2)}억 채택 (MOLIT추정 ${(loc.marketPrice / 1e8).toFixed(2)}억)`;
        } else {
          loc.compBasis = siteMarket.basis;
        }
        loc.marketPrice = siteMarket.price;
        loc.marketConfidence = 'high';
        loc.safetyMargin = listing.minBidPrice > 0 ? Math.round(((siteMarket.price - listing.minBidPrice) / siteMarket.price) * 1e5) / 1e5 : loc.safetyMargin;
      }

      // 예상낙찰가(감정가×낙찰가율)
      const eb = expectedBid(listing.appraisalValue, siteMetrics.sameBuildingSaleRatios, siteMetrics.nearbySaleRatios);
      loc.expectedBidPrice = eb.price;
      loc.expectedBidBasis = eb.basis;

      // 총취득비용 + 진짜 안전마진 (예상낙찰가가 현 최저가 이상이면 그 가격, 아니면 현 최저가로 가정)
      const bidForCost = eb.price && eb.price >= listing.minBidPrice ? eb.price : listing.minBidPrice;
      const bidBasis = eb.price && eb.price >= listing.minBidPrice ? `예상낙찰가(${eb.basis})` : '현 회차 최저매각가';
      loc.acquisitionCost = computeAcquisitionCost({
        propertyType: listing.propertyType,
        address: listing.address,
        areaM2: listing.areaM2,
        bidPrice: bidForCost,
        bidBasis,
        gongPrice,
        moveOutCost: siteMetrics.moveOutCost,
        assumedAmount: rights.assumedAmount,
        marketPrice: loc.marketPrice,
        taxOptions: { ...TAX_ASSUMPTION, officetelAsHouse: false },
      });

      // 3) 최대 안전 입찰가
      rights.maxSafeBid = maxSafeBid(loc.marketPrice, rights.assumedAmount, 0.1);

      // 3-b) 매물별 보고서 + 입찰 전 필수 확인사항(법률문서 스캔)
      const scanText = `${appraisalText} ${siteMetrics.landUseText ?? ''} ${appraisalHighlights.join(' ')}`;
      // 등기 미수집(빈 배열 = 사이트 접속차단/로드실패)이면 분석 보류 처리
      const dataComplete = input.registry.length > 0 || siteAssumed != null || input.tenants.length > 0;
      loc.report = buildReport({ rights, loc, listing, notes: scanNotes, scanText, dataComplete });
      // 3-c) 초보자 용어 풀이 + 법령 근거 리스크 평가
      loc.report.glossary = attachGlossary([
        loc.report.headline, loc.report.rightsSummary, loc.report.locationSummary, loc.report.costSummary,
        ...loc.report.summary, ...loc.report.checklist.flatMap((c) => [c.label, c.detail]),
      ]);
      loc.report.legalRisk = await assessLegalRisk(rights, loc, loc.report.checklist);

      // 4) (옵션) Claude 2차 검증
      let citations: unknown;
      let modelVersion: string | undefined;
      if (verifyMode !== 'none') {
        const { searchLegal } = await import('./legal/search.ts');
        try {
          const legalContext = await searchLegal('대항력 우선변제 말소기준권리 인수 소멸 임차인 배당');
          let v;
          if (verifyMode === 'cli') {
            const m = await import('./rights/claude-verify-cli.ts');
            v = await m.verifyRightsCli({ engineResult: rights, legalContext });
            modelVersion = m.VERIFY_CLI_MODEL;
          } else {
            const m = await import('./rights/claude-verify.ts');
            v = await m.verifyRights({ engineResult: rights, legalContext });
            modelVersion = m.VERIFY_MODEL;
          }
          citations = v.citations;
          rights.warnings.push(...v.discrepancies.map((d) => `[Claude] ${d.field}: ${d.concern}`));
        } catch (e) {
          console.warn(`[verify] ${listing.caseNo} 검증 실패: ${e}`);
        }
      }

      // 5) 점수
      const score = scoreListing(listing.caseNo, rights, loc, listing.propertyType, listing.address, DEFAULT_SCORE_CONFIG);

      // 6) 저장
      await saveRightsAnalysis(r.id, rights, modelVersion, citations);
      await saveLocationAnalysis(r.id, loc);
      await saveScore(r.id, score);

      done++;
      const tm = loc.acquisitionCost?.trueSafetyMargin;
      if (done % 25 === 0 || done === listings.length) console.log(`[analyze] ${done}/${listings.length}`);
      console.log(
        `✓ ${listing.caseNo} | 위험:${rights.riskGrade} 인수:${rights.assumedAmount.toLocaleString('ko-KR')} ` +
          `안전마진:${loc.safetyMargin !== null ? (loc.safetyMargin * 100).toFixed(1) + '%' : 'N/A'} ` +
          `진짜마진:${tm != null ? (tm * 100).toFixed(1) + '%' : 'N/A'} 점수:${score.totalScore} ${score.passedFilter ? 'PASS' : 'skip'}`,
      );
    } catch (e) {
      console.error(`✗ ${listing.caseNo}: ${e}`);
    }
   }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, listings.length) || 1 }, () => worker()));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
