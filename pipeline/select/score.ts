/**
 * 매물 선별/점수화.
 * 사용자 우선순위: ① 시세 대비 저가(안전마진), ② 권리관계 깨끗(인수 0).
 */
import type { RightsAnalysisResult, LocationAnalysis, Score } from '../../shared/types.ts';

export interface ScoreConfig {
  /** 안전마진 가중치 */
  wSafety: number;
  /** 권리 깨끗함 가중치 */
  wClean: number;
  /** 안전마진 100점 도달 기준(예: 0.4 = 시세의 40% 이상 저가면 만점) */
  safetyMaxAt: number;
  /** 통과 최소 안전마진 */
  minSafetyMargin: number;
  /** 허용 물건종류 */
  allowedTypes: string[];
  /** 관심 지역 키워드(주소 포함 매칭) */
  regionKeywords: string[];
  /** 인수금액 0만 통과시킬지 */
  requireCleanRights: boolean;
  /** 경쟁도 가중치(조회·관심 낮을수록 가점). 신호 없으면 중립 */
  wCompetition: number;
  /** 경쟁압력 만점기준(이 값 이상이면 경쟁점수 0). 압력=조회+관심×3 */
  competitionMaxAt: number;
  /** 특수권리(위험 red_flag) 하드 제외 */
  excludeSpecialRights: boolean;
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  wSafety: 0.5,
  wClean: 0.5,
  safetyMaxAt: 0.4,
  minSafetyMargin: 0.1,
  allowedTypes: ['apartment', 'villa', 'officetel'],
  regionKeywords: ['서울', '경기', '인천'],
  requireCleanRights: true,
  wCompetition: 0.2,
  competitionMaxAt: 50,
  excludeSpecialRights: true,
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function safetyScore(margin: number | null, maxAt: number): number {
  if (margin === null) return 0;
  return Math.round(clamp(margin / maxAt, 0, 1) * 100);
}

function cleanScore(rights: RightsAnalysisResult): number {
  const byGrade: Record<RightsAnalysisResult['riskGrade'], number> = {
    clean: 100,
    caution: 65,
    risky: 25,
    review_required: 0,
  };
  let s = byGrade[rights.riskGrade];
  if (rights.assumedAmount > 0) s = Math.min(s, 20); // 인수금액 있으면 강한 감점
  return s;
}

export function scoreListing(
  caseNo: string,
  rights: RightsAnalysisResult,
  loc: LocationAnalysis,
  propertyType: string,
  address: string,
  cfg: ScoreConfig = DEFAULT_SCORE_CONFIG,
  competition?: { inq?: number | null; interest?: number | null },
): Score {
  // trueSafetyMargin(취득비용·예상낙찰가 반영)을 우선 사용, 없으면 raw safetyMargin으로 fallback
  const trueSM = loc.acquisitionCost?.trueSafetyMargin ?? null;
  const effectiveMargin = trueSM !== null ? trueSM : loc.safetyMargin;

  const sSafety = safetyScore(effectiveMargin, cfg.safetyMaxAt);
  const sClean = cleanScore(rights);
  // 무피 보너스: 실거래 기반(non-estimated) zeroPiCandidate에만 +5점
  const zeroPiBonus = (loc.income?.zeroPiCandidate && !loc.income?.estimated) ? 5 : 0;
  // 위험항목 감점(-8점/건, 최대 -30) — web/src/scoring.ts 클라이언트 로직과 동일하게 유지
  const dangerCnt = loc.report?.dangerCount ?? 0;
  const dangerPenalty = Math.min(30, dangerCnt * 8);
  // 경쟁도(조회·관심 낮을수록 가점). 신호 없으면 중립(가중 제외) — 클라이언트와 동일 산식.
  const compPressure = (competition?.inq ?? 0) + (competition?.interest ?? 0) * 3;
  const hasComp = competition != null && (competition.inq != null || competition.interest != null);
  const sComp = hasComp ? Math.round(clamp(1 - compPressure / (cfg.competitionMaxAt || 50), 0, 1) * 100) : 0;
  const wComp = hasComp ? cfg.wCompetition : 0;
  const wSum = cfg.wSafety + cfg.wClean + wComp || 1;
  const total = Math.max(0, Math.min(100, Math.round((cfg.wSafety * sSafety + cfg.wClean * sClean + wComp * sComp) / wSum) + zeroPiBonus - dangerPenalty));

  const reasons: string[] = [];
  let passed = true;

  if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(propertyType)) {
    passed = false;
    reasons.push(`물건종류(${propertyType}) 제외`);
  }
  if (cfg.regionKeywords.length && !cfg.regionKeywords.some((k) => address.includes(k))) {
    passed = false;
    reasons.push('관심 지역 외');
  }
  if (cfg.requireCleanRights && rights.assumedAmount > 0) {
    passed = false;
    reasons.push(`인수금액 ${rights.assumedAmount.toLocaleString('ko-KR')}원`);
  }
  if (rights.riskGrade === 'review_required') {
    passed = false;
    reasons.push('사람 검토 필요(특수권리)');
  }
  if (cfg.excludeSpecialRights && rights.redFlags.some((f) => f.severity === 'danger')) {
    passed = false;
    reasons.push('특수권리(위험) 제외');
  }
  if (effectiveMargin !== null && effectiveMargin < cfg.minSafetyMargin) {
    passed = false;
    const label = trueSM !== null ? '진짜안전마진' : '안전마진';
    reasons.push(`${label} ${(effectiveMargin * 100).toFixed(1)}% < 최소 ${(cfg.minSafetyMargin * 100).toFixed(0)}%`);
  }
  if (effectiveMargin === null) {
    passed = false;
    reasons.push('시세 미확보 — 안전마진 산정 불가');
  }

  return {
    caseNo,
    safetyMarginScore: sSafety,
    cleanRightsScore: sClean,
    totalScore: total,
    passedFilter: passed,
    reason: passed
      ? `통과 (안전마진 ${sSafety}, 권리 ${sClean}${zeroPiBonus ? ', 무피+5' : ''})`
      : reasons.join('; '),
  };
}

/**
 * 최대 안전 입찰가 — 이 값 이하로 낙찰하면 취득비용까지 포함해도 목표 마진(marginPct)이 남는 상한.
 *   총취득비용 = 입찰가 + 취득세(입찰가×세율) + 명도비 + 채권 + 인수금액 이므로,
 *   시세×(1−마진) = B×(1+세율) + 고정비 + 인수금액 을 B에 대해 푼다.
 *   costs 미제공 시(이전 호출부 호환) 취득세·부대비 무시한 종전 근사식.
 */
export function maxSafeBid(
  marketPrice: number | null, assumedAmount: number, marginPct = 0.1,
  costs?: { taxRatePct: number; fixedCosts: number },
): number | null {
  if (marketPrice === null) return null;
  const target = marketPrice * (1 - marginPct) - assumedAmount;
  if (!costs) return Math.max(0, Math.round(target));
  const bid = (target - costs.fixedCosts) / (1 + costs.taxRatePct / 100);
  return Math.max(0, Math.round(bid));
}
