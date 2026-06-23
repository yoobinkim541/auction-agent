/**
 * 매물별 종합 보고서 생성 — 권리·입지·취득비용·입찰전 체크리스트를 재가공해 한 건의 리포트로.
 * 더블체크용 원본 상세페이지 링크를 포함한다.
 */
import type {
  ListingReport, PreBidItem, RightsAnalysisResult, LocationAnalysis, Listing,
} from '../../shared/types.ts';
import { buildPreBidChecklist } from './checklist.ts';
import { buildFieldwork } from './fieldwork.ts';
import { won, eok, pct } from '../../shared/format.ts';

/** 종합 권고 등급 판정(순수) — 데이터 불완전→caution / 인수·danger·review_required·음수마진→avoid /
 *  warn·저마진(<10%)·risky·caution등급→caution / 그 외→consider. */
export function decideRecommendation(input: {
  dataComplete: boolean;
  assumedAmount: number;
  dangerCount: number;
  warnCount: number;
  riskGrade: RightsAnalysisResult['riskGrade'];
  trueMargin: number | null;
}): ListingReport['recommendation'] {
  if (!input.dataComplete) return 'caution';
  if (input.assumedAmount > 0 || input.dangerCount > 0 || input.riskGrade === 'review_required' || (input.trueMargin != null && input.trueMargin < 0)) return 'avoid';
  if (input.warnCount > 0 || (input.trueMargin != null && input.trueMargin < 0.1) || input.riskGrade === 'risky' || input.riskGrade === 'caution') return 'caution';
  return 'consider';
}

export function buildReport(args: {
  rights: RightsAnalysisResult;
  loc: LocationAnalysis;
  listing: Listing;
  notes: string[];
  scanText: string;
  dataComplete?: boolean;
}): ListingReport {
  const { rights, loc, listing } = args;
  const dataComplete = args.dataComplete !== false;
  const checklist: PreBidItem[] = buildPreBidChecklist(args);
  const dangerCount = checklist.filter((c) => c.severity === 'danger').length;
  const warnCount = checklist.filter((c) => c.severity === 'warn').length;
  const trueMargin = loc.acquisitionCost?.trueSafetyMargin ?? null;

  // 종합 권고: 인수금액/위험등급/danger 항목/진짜마진 기준 (데이터 불완전은 보류=caution)
  const recommendation = decideRecommendation({
    dataComplete, assumedAmount: rights.assumedAmount, dangerCount, warnCount,
    riskGrade: rights.riskGrade, trueMargin,
  });

  if (!dataComplete) {
    return {
      headline: `[데이터 불완전] 등기 미수집(접속차단/로드실패) — 재수집 후 분석 필요. 시세 ${eok(loc.marketPrice)} · 최저가 ${eok(listing.minBidPrice)}`,
      recommendation, summary: ['⚠️ 원천 데이터(등기·명세서) 미수집으로 권리분석 보류', `감정가 ${eok(listing.appraisalValue)} · 최저가 ${eok(listing.minBidPrice)}`],
      rightsSummary: '등기 미수집 — 권리분석 불가(재수집 필요).', locationSummary: loc.compBasis ?? '', costSummary: '',
      checklist, dangerCount, warnCount, sourceUrl: listing.sourceUrl,
      fieldwork: buildFieldwork(rights, loc, listing),
    };
  }

  const recLabel = { consider: '검토 권장', caution: '주의 검토', avoid: '신중/회피' }[recommendation];
  const headline =
    `[${recLabel}] 시세 ${eok(loc.marketPrice)} · 최저가 ${eok(listing.minBidPrice)}` +
    ` · 안전마진 ${pct(loc.safetyMargin)}` +
    (trueMargin != null ? ` · 진짜마진 ${pct(trueMargin)}` : '') +
    (rights.assumedAmount > 0 ? ` · 인수 ${eok(rights.assumedAmount)}` : ' · 인수 없음') +
    ` · 위험 ${dangerCount}/주의 ${warnCount}건`;

  const summary: string[] = [];
  summary.push(`감정가 ${eok(listing.appraisalValue)} → 최저가 ${eok(listing.minBidPrice)}${listing.minBidRatio ? ` (${listing.minBidRatio}%)` : ''}`);
  if (loc.expectedBidPrice) summary.push(`예상낙찰가 ${eok(loc.expectedBidPrice)} (${loc.expectedBidBasis})`);
  summary.push(`추정시세 ${eok(loc.marketPrice)}${loc.marketConfidence ? ` (신뢰도 ${loc.marketConfidence})` : ''} → 안전마진 ${pct(loc.safetyMargin)}`);
  if (loc.acquisitionCost) summary.push(`총취득비용 ${eok(loc.acquisitionCost.totalCost)} → 진짜 안전마진 ${pct(trueMargin)}`);
  if (rights.assumedAmount > 0) summary.push(`⚠️ 낙찰자 인수금액 ${won(rights.assumedAmount)}`);

  const rightsSummary =
    `말소기준권리: ${rights.malsoBasis.note || '-'}. ` +
    `위험등급 ${rights.riskGrade}. ` +
    `인수금액 ${won(rights.assumedAmount)}. ` +
    (rights.redFlags.length ? `특수권리/플래그 ${rights.redFlags.length}건(${rights.redFlags.map((f) => f.message.split(' — ')[0]).join(', ')}).` : '특수권리 플래그 없음.');

  const locationSummary =
    `${loc.transit?.nearestStation ? `최근접 ${loc.transit.nearestStation}. ` : ''}` +
    `${loc.building ? `${loc.building.mainUse ?? ''} ${loc.building.households ?? '?'}세대${loc.building.approvalDate ? ` · ${loc.building.approvalDate.slice(0, 4)}년 사용승인` : ''}. ` : ''}` +
    `${loc.compBasis ? `시세근거: ${loc.compBasis}.` : ''}` +
    `${(loc.landUseFlags ?? []).length ? ` 토지규제 ${loc.landUseFlags!.map((f) => f.label).join(', ')}.` : ''}`;

  const ac = loc.acquisitionCost;
  const costSummary = ac
    ? `가정 낙찰가 ${won(ac.bidPrice)}(${ac.bidBasis}) + 취득세 ${won(ac.acqTax)}(${ac.acqTaxRatePct}%) + 명도비 ${won(ac.moveOutCost)} + 채권 ${won(ac.bondCost)}` +
      (ac.assumedAmount > 0 ? ` + 인수 ${won(ac.assumedAmount)}` : '') +
      ` = 총 ${won(ac.totalCost)}. 진짜 안전마진 ${pct(ac.trueSafetyMargin)}.`
    : '취득비용 산정 불가(시세/공시가격 부족).';

  return {
    headline, recommendation, summary, rightsSummary, locationSummary, costSummary,
    checklist, dangerCount, warnCount, sourceUrl: listing.sourceUrl,
    fieldwork: buildFieldwork(rights, loc, listing),
  };
}
