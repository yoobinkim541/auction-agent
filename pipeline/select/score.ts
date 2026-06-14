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
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  wSafety: 0.5,
  wClean: 0.5,
  safetyMaxAt: 0.4,
  minSafetyMargin: 0.1,
  allowedTypes: ['apartment', 'villa', 'officetel'],
  regionKeywords: ['서울', '경기', '인천'],
  requireCleanRights: true,
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
): Score {
  const sSafety = safetyScore(loc.safetyMargin, cfg.safetyMaxAt);
  const sClean = cleanScore(rights);
  const total = Math.round(cfg.wSafety * sSafety + cfg.wClean * sClean);

  const reasons: string[] = [];
  let passed = true;

  if (!cfg.allowedTypes.includes(propertyType)) {
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
  if (loc.safetyMargin !== null && loc.safetyMargin < cfg.minSafetyMargin) {
    passed = false;
    reasons.push(`안전마진 ${(loc.safetyMargin * 100).toFixed(1)}% < 최소 ${(cfg.minSafetyMargin * 100).toFixed(0)}%`);
  }
  if (loc.safetyMargin === null) {
    reasons.push('시세 미확보 — 안전마진 산정 불가');
  }

  return {
    caseNo,
    safetyMarginScore: sSafety,
    cleanRightsScore: sClean,
    totalScore: total,
    passedFilter: passed,
    reason: passed ? `통과 (안전마진 ${sSafety}, 권리 ${sClean})` : reasons.join('; '),
  };
}

/** 최대 안전 입찰가 = 시세 − 인수금액 − 여유마진(시세의 marginPct) */
export function maxSafeBid(marketPrice: number | null, assumedAmount: number, marginPct = 0.1): number | null {
  if (marketPrice === null) return null;
  return Math.max(0, Math.round(marketPrice * (1 - marginPct) - assumedAmount));
}
