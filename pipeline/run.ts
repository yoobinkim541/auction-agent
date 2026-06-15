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
import type { Listing, RightsInput, RegistryEntry, Tenant } from '../shared/types.ts';
import { analyzeRights } from './rights/engine.ts';
import { analyzeLocation } from './location/index.ts';
import { scoreListing, maxSafeBid, DEFAULT_SCORE_CONFIG } from './select/score.ts';

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
    crawledAt: new Date().toISOString(),
  };
}

/** 등기/임차인 문서(parsed_json)로 RightsInput을 구성. 없으면 빈 입력(엔진이 경고). */
async function buildRightsInput(listingId: number, listing: Listing): Promise<RightsInput> {
  const data = await fetchListingDocs(listingId);

  let registry: RegistryEntry[] = [];
  let landRegistry: RegistryEntry[] | undefined;
  let tenants: Tenant[] = [];
  let statementSeniorDate: string | undefined;
  const notes: string[] = [];

  for (const d of data) {
    const p = d.parsed_json ?? {};
    if (d.doc_type === 'registry_summary') {
      if (Array.isArray(p.registry)) registry = p.registry as RegistryEntry[];
      if (Array.isArray(p.landRegistry)) landRegistry = p.landRegistry as RegistryEntry[];
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
  };
}

async function main() {
  const withVerify = process.argv.includes('--verify');

  const reanalyzeAll = process.argv.includes('--all');
  const listings = await fetchListingsForAnalysis(200, !reanalyzeAll);
  console.log(`분석 대상 매물: ${listings.length}건 ${reanalyzeAll ? '(전체 재분석)' : '(신규만 — 전체는 --all)'}`);

  // 검증 모드 결정: claude CLI(Max 구독, 과금 0) 우선 → API 키 → 생략
  let verifyMode: 'cli' | 'api' | 'none' = 'none';
  if (withVerify) {
    const { claudeCliAvailable } = await import('./rights/claude-verify-cli.ts');
    if (await claudeCliAvailable()) verifyMode = 'cli';
    else if (process.env.ANTHROPIC_API_KEY) verifyMode = 'api';
    console.log(`[verify] 모드: ${verifyMode}${verifyMode === 'cli' ? ' (Claude Max 구독, 추가 과금 없음)' : ''}`);
  }

  for (const r of listings) {
    const listing = rowToListing(r);
    try {
      // 1) 권리분석 (결정형 엔진)
      const rightsInput = await buildRightsInput(r.id, listing);
      const rights = analyzeRights(rightsInput);

      // 2) 입지분석
      const loc = await analyzeLocation(listing, { tradeMonths: 6 });

      // 3) 최대 안전 입찰가
      rights.maxSafeBid = maxSafeBid(loc.marketPrice, rights.assumedAmount, 0.1);

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

      console.log(
        `✓ ${listing.caseNo} | 위험:${rights.riskGrade} 인수:${rights.assumedAmount.toLocaleString('ko-KR')} ` +
          `안전마진:${loc.safetyMargin !== null ? (loc.safetyMargin * 100).toFixed(1) + '%' : 'N/A'} 점수:${score.totalScore} ${score.passedFilter ? 'PASS' : 'skip'}`,
      );
    } catch (e) {
      console.error(`✗ ${listing.caseNo}: ${e}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
