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
  fetchListingsForAnalysis, fetchListingDocs, type ListingRow, query, backfillFailCountFromSaleRounds,
} from '../shared/db.ts';
import type { Listing, RightsInput, RegistryEntry, Tenant, SiteMetrics } from '../shared/types.ts';
import { analyzeRights } from './rights/engine.ts';
import { analyzeLocation } from './location/index.ts';
import { scoreListing, maxSafeBid, DEFAULT_SCORE_CONFIG } from './select/score.ts';
import { computeAcquisitionCost, expectedBid, marketFromSiteComps, classifyLandUseFlags, decideBidForCost } from './cost/acquisition.ts';
import { buildReport } from './report/build.ts';
import { bandLine, compsStats, fetchCompsWithFallback, regionKey, recentSalesLines, winRateGuide, type CompSale } from './predict/comps.ts';
import { attachGlossary } from './report/glossary.ts';
import { assessLegalRisk } from './legal/risk.ts';
import { addressToLawdCd } from './location/lawd-codes.ts';
import { fetchRentDeals, estimateRent, estimateRentFromSalePrice } from './income/rent.ts';
import { analyzeIncome } from './income/yield.ts';
import { analyzeEviction } from './eviction/index.ts';
import { parseKoreanMoney, parseKoreanDate } from '../crawler/normalize.ts';

/** 사용자 취득세 가정(개인 1주택 기본). 다주택/법인이면 여기 또는 향후 설정에서 조정. */
const TAX_ASSUMPTION = { homeCountAfter: 1 } as const;

const num = (v: string | number | null): number => (v == null ? 0 : typeof v === 'number' ? v : parseFloat(v));

/** 시세 대비 현 최저가 안전마진(소수 5자리). 최저가 ≤0이면 null(호출부에서 기존값 유지). */
const marginVsMinBid = (price: number, minBid: number): number | null =>
  minBid > 0 ? Math.round(((price - minBid) / price) * 1e5) / 1e5 : null;

/**
 * 매각물건명세서 "매각효력" 노트에서 임차인 정보 추출.
 * 임차권등기 유형의 임차인은 구조화 테이블(임차인현황) 대신 매각효력 자연어 문장에
 * 보증금·전입일·확정일이 기재되는 경우가 많음. 이를 보완 파싱하여 엔진에 전달한다.
 * — 출처 표기(raw 필드)로 구분, 크롤러 파싱 결과가 있으면 이 함수는 호출되지 않음.
 */
function extractTenantsFromNotes(notes: string[]): Tenant[] {
  const tenants: Tenant[] = [];
  for (const note of notes) {
    if (!/매각효력/.test(note)) continue;
    if (!/대항할\s*수\s*있는/.test(note)) continue;
    // 단일 메모에 복수 임차인이 기재될 수 있으므로 블록 단위로 분리
    // "매수인에게 대항할 수 있는 ..." 또는 "대항할 수 있는 임차인이 있음 ..."
    const blocks = note.split(/(?=매수인에게\s*대항할|대항할\s*수\s*있는\s*임차인)/);
    for (const block of blocks) {
      if (!/대항할\s*수\s*있는/.test(block)) continue;
      const depositM = block.match(/(?:임차보증금|임대차보증금)\s*금?\s*([\d,]+)/);
      const moveInM = block.match(/(?:전입일자|주민등록일자)\s*(\d{4}[.년-]\d{1,2}[.월-]\d{1,2})/);
      const fixedM = block.match(/확정일자\s*(?:\(\s*1차\s*\))?\s*(\d{4}[.년-]\d{1,2}[.월-]\d{1,2})/);
      if (!depositM && !moveInM) continue; // 최소 하나 이상의 정량 정보 필요
      tenants.push({
        moveInDate: moveInM ? parseKoreanDate(moveInM[1]) : undefined,
        occupancyDate: moveInM ? parseKoreanDate(moveInM[1]) : undefined,
        fixedDate: fixedM ? parseKoreanDate(fixedM[1]) : undefined,
        deposit: depositM ? (parseKoreanMoney(depositM[1]) ?? 0) : 0,
        demandedDistribution: false, // 임차권등기는 별도 배당요구 없이 우선변제
        occupied: true,
        raw: `(매각효력노트추출) ${block.slice(0, 300)}`,
      });
    }
  }
  return tenants;
}

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

  // 임차인현황 테이블 미탐지(임차권등기 유형 등) → 매각효력 노트에서 보완 추출
  if (tenants.length === 0) {
    const notesTenants = extractTenantsFromNotes(notes);
    if (notesTenants.length > 0) {
      tenants = notesTenants;
    }
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
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1] ?? '', 10)) : null;
  let listings = await fetchListingsForAnalysis(2000, !reanalyzeAll);
  if (limit) listings = listings.slice(0, limit); // 소규모 검증/점진 적재용
  const concurrency = Math.max(1, parseInt(process.env.ANALYZE_CONCURRENCY ?? '6', 10));
  console.log(`분석 대상 매물: ${listings.length}건 ${reanalyzeAll ? '(전체 재분석)' : '(신규만 — 전체는 --all)'}${limit ? ` [--limit ${limit}]` : ''} | 병렬 ${concurrency}`);

  // 검증 모드 결정: claude CLI(Max 구독, 과금 0) 우선 → API 키 → 생략
  let verifyMode: 'cli' | 'api' | 'none' = 'none';
  if (withVerify) {
    const { claudeCliAvailable } = await import('./rights/claude-verify-cli.ts');
    if (await claudeCliAvailable()) verifyMode = 'cli';
    else if (process.env.ANTHROPIC_API_KEY) verifyMode = 'api';
    console.log(`[verify] 모드: ${verifyMode}${verifyMode === 'cli' ? ' (Claude Max 구독, 추가 과금 없음)' : ''}`);
  }

  // 마지막 정상 시세 캐시 — MOLIT 쿼터/차단으로 이번 분석이 시세를 못 낼 때 회귀 방지 + 임대 fallback 가동.
  // (query는 상단에서 정적 import — 이전의 중복 동적 import 제거)
  const prevMarket = new Map<number, { price: number; conf: string | null; basis: string | null }>();
  for (const row of await query<{ listing_id: number; market_price: number | null; market_confidence: string | null; comp_basis: string | null }>(
    'select listing_id, market_price, market_confidence, comp_basis from gm_location_analysis where market_price is not null',
  )) {
    if (row.market_price) prevMarket.set(row.listing_id, { price: row.market_price, conf: row.market_confidence, basis: row.comp_basis });
  }

  // 직전 LLM 의견서 캐시 — report 재생성이 memo를 덮어쓰지 않도록 보존(2차 패스 해시 캐시 적중 위함).
  const prevMemo = new Map<number, { memo: string; memoHash?: string; memoModel?: string }>();
  for (const row of await query<{ listing_id: number; memo: string | null; memohash: string | null; memomodel: string | null }>(
    "select listing_id, report->>'memo' memo, report->>'memoHash' memohash, report->>'memoModel' memomodel from gm_location_analysis where report->>'memo' is not null",
  )) {
    if (row.memo) prevMemo.set(row.listing_id, { memo: row.memo, memoHash: row.memohash ?? undefined, memoModel: row.memomodel ?? undefined });
  }

  // 유사 낙찰 사례(comps) 캐시 — 같은 시군구·유형은 배치 내 1회만 조회.
  const compsCache = new Map<string, { region: string; sales: CompSale[] }>();

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
      // courtauction 원천: 등기부·임차인 데이터 없음 → 거짓 "클린" 방지
      if (r.source === 'courtauction' && input.registry.length === 0) {
        rights.riskGrade = 'review_required';
        rights.isClean = false;
        rights.warnings.push('[법원경매] 등기부·임차인 데이터 없음 — 입찰 전 법원경매정보시스템에서 직접 확인 필요');
      }
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
        loc.safetyMargin = marginVsMinBid(siteMarket.price, listing.minBidPrice) ?? loc.safetyMargin;
      }

      // 시세 산출 실패(MOLIT 쿼터/차단 + 사이트 comps 없음) → 마지막 정상 시세 재사용(회귀 방지 + 임대 fallback 가동)
      if (loc.marketPrice == null) {
        const prev = prevMarket.get(r.id);
        if (prev) {
          loc.marketPrice = prev.price;
          loc.marketConfidence = (prev.conf as typeof loc.marketConfidence) ?? loc.marketConfidence;
          loc.compBasis = prev.basis ? `${prev.basis} (이전 분석값 유지 — 이번 회차 실거래 미조회)` : loc.compBasis;
          loc.safetyMargin = marginVsMinBid(prev.price, listing.minBidPrice) ?? loc.safetyMargin;
        }
      }

      // 예상낙찰가(감정가×낙찰가율)
      const eb = expectedBid(listing.appraisalValue, siteMetrics.sameBuildingSaleRatios, siteMetrics.nearbySaleRatios, listing.minBidPrice);
      loc.expectedBidPrice = eb.price;
      loc.expectedBidBasis = eb.basis;

      // 총취득비용 + 진짜 안전마진
      // 예상낙찰가가 현 최저가 이상이면 그 가격 사용.
      // 예상낙찰가가 없고(sale ratio 미확보) 최저가가 시세의 5% 미만이면 시세×80%로 보수 추정.
      // (극단적으로 낮은 min_bid를 그대로 사용하면 trueSafetyMargin이 허위로 95%+가 됨)
      const { bidForCost, bidBasis } = decideBidForCost(eb.price, eb.basis, listing.minBidPrice, loc.marketPrice);
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

      // 2-c) 임대수익·출구 엔진 (MOLIT 전월세 → 전세가율·수익률·현금흐름·세후 매도 시나리오)
      try {
        const lawdCd = addressToLawdCd(listing.address);
        if (lawdCd) {
          let rent = estimateRent(await fetchRentDeals(listing.propertyType, lawdCd, 12), listing.areaM2);
          // 전월세 실거래 미확보(쿼터/표본부족)면 매매시세×전세가율로 전세보증금만 추정(저신뢰 fallback)
          if (rent.n === 0 && loc.marketPrice) rent = estimateRentFromSalePrice(listing.propertyType, loc.marketPrice);
          if (rent.n > 0 || rent.estimated) {
            loc.income = analyzeIncome({
              marketPrice: loc.marketPrice, totalAcqCost: loc.acquisitionCost?.totalCost ?? null,
              bidPrice: loc.acquisitionCost?.bidPrice ?? listing.minBidPrice,
              acqTax: loc.acquisitionCost?.acqTax ?? 0, bondCost: loc.acquisitionCost?.bondCost ?? 0,
              gongPrice, rent, hasOpposingTenant: rights.tenants.some((t) => t.hasOpposition),
            });
          }
        }
      } catch { /* 전월세 조회 실패는 무시(임대분석 생략) */ }

      // 2-d) 명도 난이도 엔진 (점유유형·인도명령·비용/기간·협상 브리프)
      loc.eviction = analyzeEviction(rights, listing.areaM2, scanNotes);

      // 3) 최대 안전 입찰가
      rights.maxSafeBid = maxSafeBid(loc.marketPrice, rights.assumedAmount, 0.1);

      // 3-b) 매물별 보고서 + 입찰 전 필수 확인사항(법률문서 스캔)
      const scanText = `${appraisalText} ${siteMetrics.landUseText ?? ''} ${appraisalHighlights.join(' ')}`;
      // 등기 미수집(빈 배열 = 사이트 접속차단/로드실패)이면 분석 보류 처리
      const dataComplete = input.registry.length > 0 || siteAssumed != null || input.tenants.length > 0;
      loc.report = buildReport({ rights, loc, listing, notes: scanNotes, scanText, dataComplete });
      // 3-b-2) 유사 낙찰 사례 — 같은 시군구·유형 실제 낙찰가율 밴드 + 최근 3건(입찰가 감각, 발품 대체)
      try {
        const ck = `${listing.propertyType}|${regionKey(listing.address)}`;
        let cc = compsCache.get(ck);
        if (!cc) { cc = await fetchCompsWithFallback(listing.propertyType, listing.address); compsCache.set(ck, cc); }
        const band = bandLine(listing.appraisalValue ?? null, compsStats(cc.sales));
        if (band) {
          loc.report.summary.push(`📈 ${band} — ${cc.region} 유사 낙찰:`);
          for (const line of recentSalesLines(cc.sales)) loc.report.summary.push(`· ${line}`);
        }
        const guide = winRateGuide(listing.appraisalValue ?? null, cc.sales);
        if (guide) loc.report.summary.push(`🎯 ${guide}`);
      } catch { /* comps 실패는 리포트 생략(치명 아님) */ }
      // 직전 LLM 의견서 보존 — report를 새로 만들면 memo가 사라져 2차 패스가 매번 전건 재생성하게 됨.
      // 입력이 그대로면 memoHash가 일치해 2차 패스가 캐시 적중(재생성 생략)한다.
      const pm = prevMemo.get(r.id);
      if (pm) { loc.report.memo = pm.memo; loc.report.memoHash = pm.memoHash; loc.report.memoModel = pm.memoModel; }
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

      // 5) 점수 (데이터 불완전이면 통과 불가 — 등기 미수집 상태에서 점수 통과하면 오탐)
      const score = scoreListing(listing.caseNo, rights, loc, listing.propertyType, listing.address, DEFAULT_SCORE_CONFIG, { inq: listing.inquiryCount ?? null, interest: listing.interestCount ?? null });
      if (!dataComplete && score.passedFilter) {
        score.passedFilter = false;
        score.reason = (score.reason ? score.reason + '; ' : '') + '등기 미수집 — 권리분석 보류';
      }

      // 6) 저장
      await saveRightsAnalysis(r.id, rights, modelVersion, citations);
      await saveLocationAnalysis(r.id, loc);
      await backfillFailCountFromSaleRounds(r.id, loc.saleRounds); // 부수효과 명시 호출(이전엔 save 내부 숨김)
      await saveScore(r.id, score);
      // 분석 중 지오코딩으로 새로 얻은 좌표를 gm_listings에 캐시
      if (loc.resolvedLat != null && loc.resolvedLng != null && (r.lat == null || r.lng == null)) {
        await query('UPDATE gm_listings SET lat=$2, lng=$3 WHERE id=$1', [r.id, loc.resolvedLat, loc.resolvedLng]);
      }

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

  // 2차 패스 — LLM 투자 의견서(통과 상위 N건, Claude 구독 CLI). 입력 해시 캐시로 재생성 최소화.
  // MEMO=off 로 끄고, MEMO_TOP_N 으로 건수 조절(기본 30). 실패해도 분석 결과엔 영향 없음.
  if (process.env.MEMO !== 'off') {
    const { claudeCliAvailable, generateMemosForTopCandidates } = await import('./report/memo.ts');
    if (await claudeCliAvailable()) {
      const topN = Math.max(1, parseInt(process.env.MEMO_TOP_N ?? '30', 10));
      console.log(`[memo] 투자 의견서 생성(통과 상위 ${topN}건, Claude 구독 CLI)…`);
      const m = await generateMemosForTopCandidates(topN);
      console.log(`[memo] 후보 ${m.candidates} · 생성 ${m.generated} · 캐시 ${m.cached} · 실패 ${m.failed}`);
    } else {
      console.log('[memo] claude CLI 미가용 — 의견서 생략');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
