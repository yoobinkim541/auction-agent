export type PrecisionStatus = 'recommended' | 'conditional' | 'hold' | 'rejected';
export type PrecisionConfidence = 'high' | 'medium' | 'low';
export type PrecisionTrustStatus = 'trusted' | 'hold' | 'quarantined';
export type PrecisionMarketConfidence = 'high' | 'medium' | 'low';
export type PrecisionRiskGrade = 'clean' | 'caution' | 'risky' | 'review_required';

export interface PrecisionInput {
  trustStatus: PrecisionTrustStatus;
  appraisalValue: number | null;
  minBidPrice: number | null;
  marketPrice: number | null;
  marketConfidence: PrecisionMarketConfidence;
  comparablePrices: readonly number[];
  expectedBidPrice: number | null;
  maxSafeBid: number | null;
  assumedAmount: number;
  riskGrade: PrecisionRiskGrade;
  dangerFlagCount: number;
  occupantLabel: string;
  trueSafetyMargin: number | null;
  fixedCosts: number;
  targetMarginPct?: number;
}

export interface PrecisionEvaluation {
  status: PrecisionStatus;
  confidence: PrecisionConfidence;
  conservativeValue: number | null;
  recommendedBid: number | null;
  hardCapBid: number | null;
  reasonCodes: string[];
  strengths: string[];
  risks: string[];
  requiredChecks: string[];
  evaluatorVersion: 'precision-v1';
}

const isPositive = (value: number | null): value is number => (
  value !== null && Number.isFinite(value) && value > 0
);

const isNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

const p25NearestRank = (prices: number[]): number => {
  const sorted = [...prices].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.25) - 1] as number;
};

const result = (
  status: PrecisionStatus,
  confidence: PrecisionConfidence,
  conservativeValue: number | null,
  recommendedBid: number | null,
  hardCapBid: number | null,
  reasonCodes: string[],
  strengths: string[],
  risks: string[],
  requiredChecks: string[],
): PrecisionEvaluation => ({
  status,
  confidence,
  conservativeValue,
  recommendedBid,
  hardCapBid,
  reasonCodes,
  strengths,
  risks,
  requiredChecks,
  evaluatorVersion: 'precision-v1',
});

export const evaluatePrecision = (input: PrecisionInput): PrecisionEvaluation => {
  const targetMarginPct = input.targetMarginPct ?? 0.15;
  const positivePriceEvidence = [input.appraisalValue, input.minBidPrice, input.marketPrice]
    .every(isPositive);
  const validCosts = isNonNegative(input.fixedCosts) && isNonNegative(input.assumedAmount);
  const validControls = isPositive(input.expectedBidPrice)
    && isPositive(input.maxSafeBid)
    && Number.isFinite(targetMarginPct)
    && targetMarginPct >= 0
    && targetMarginPct < 1
    && isNonNegative(input.dangerFlagCount)
    && input.trueSafetyMargin !== null
    && Number.isFinite(input.trueSafetyMargin);
  const positiveComparables = input.comparablePrices.filter(isPositive);
  const enoughComparables = positiveComparables.length >= 2
    || (positiveComparables.length === 1 && input.marketConfidence === 'high');
  const validEvidence = positivePriceEvidence && validCosts && validControls && enoughComparables;
  const sparseEvidence = positiveComparables.length < 3;
  const reasonCodes: string[] = [];
  const risks: string[] = [];
  const requiredChecks: string[] = [];
  const strengths: string[] = [];

  let conservativeValue: number | null = null;
  let hardCapBid: number | null = null;
  let recommendedBid: number | null = null;

  if (!positivePriceEvidence) reasonCodes.push('MISSING_OR_NON_POSITIVE_PRICE_EVIDENCE');
  if (!validCosts) reasonCodes.push('INVALID_COST_INPUT');
  if (!isPositive(input.expectedBidPrice)) reasonCodes.push('MISSING_OR_NON_POSITIVE_EXPECTED_BID');
  if (!isPositive(input.maxSafeBid)) reasonCodes.push('MISSING_OR_NON_POSITIVE_MAX_SAFE_BID');
  if (!Number.isFinite(targetMarginPct) || targetMarginPct < 0 || targetMarginPct >= 1) {
    reasonCodes.push('INVALID_TARGET_MARGIN');
  }
  if (positiveComparables.length === 0) reasonCodes.push('NO_VALID_COMPARABLE_PRICES');
  else if (!enoughComparables) reasonCodes.push('INSUFFICIENT_COMPARABLE_PRICES');

  if (positivePriceEvidence && positiveComparables.length > 0) {
    const comparableP25 = p25NearestRank(positiveComparables);
    conservativeValue = Math.min(input.marketPrice as number, comparableP25);
    const divergence = (Math.max(input.marketPrice as number, comparableP25)
      - Math.min(input.marketPrice as number, comparableP25)) / Math.min(input.marketPrice as number, comparableP25);
    if (divergence > 0.2) {
      reasonCodes.push('PRICE_BASIS_DIVERGENCE');
      risks.push('시장가와 비교사례 하위 25% 가격의 차이가 20%를 초과합니다.');
    }
  }

  if (conservativeValue !== null && isPositive(input.maxSafeBid) && validCosts && Number.isFinite(targetMarginPct)) {
    const costCap = conservativeValue * (1 - targetMarginPct) - input.fixedCosts - input.assumedAmount;
    hardCapBid = Math.max(0, Math.floor(Math.min(input.maxSafeBid, costCap)));
    if (isPositive(input.minBidPrice)) {
      if (input.minBidPrice > hardCapBid) reasonCodes.push('MIN_BID_ABOVE_HARD_CAP');
      else if (isPositive(input.expectedBidPrice)) {
        recommendedBid = Math.min(hardCapBid, Math.max(input.minBidPrice, input.expectedBidPrice));
      }
    }
  }

  if (input.assumedAmount > 0) {
    reasonCodes.push('ASSUMED_AMOUNT_PRESENT');
    risks.push('인수금액이 있어 경제적 하드 게이트를 통과하지 못합니다.');
  }
  if (input.dangerFlagCount > 0) {
    reasonCodes.push('DANGER_FLAGS_PRESENT');
    risks.push('위험 플래그가 존재합니다.');
  }
  if (input.riskGrade === 'risky') {
    reasonCodes.push('RISK_GRADE_RISKY');
    risks.push('권리 위험등급이 위험입니다.');
  }
  if (input.trueSafetyMargin !== null && Number.isFinite(input.trueSafetyMargin)
    && input.trueSafetyMargin < targetMarginPct) {
    reasonCodes.push('MARGIN_BELOW_TARGET');
    risks.push('안전마진이 목표 마진보다 낮습니다.');
  }

  const hardReject = input.assumedAmount > 0
    || input.dangerFlagCount > 0
    || input.riskGrade === 'risky'
    || (Number.isFinite(input.trueSafetyMargin) && input.trueSafetyMargin !== null && input.trueSafetyMargin < targetMarginPct)
    || (hardCapBid !== null && isPositive(input.minBidPrice) && input.minBidPrice > hardCapBid);
  const unresolvedTrust = input.trustStatus !== 'trusted';
  const reviewRequired = input.riskGrade === 'review_required';
  const unresolvedEvidence = !validEvidence || reasonCodes.includes('PRICE_BASIS_DIVERGENCE');
  const unknownOccupancy = input.occupantLabel.includes('미상');
  const caution = input.riskGrade === 'caution';

  let status: PrecisionStatus;
  if (hardReject) status = 'rejected';
  else if (unresolvedTrust || reviewRequired || unresolvedEvidence) status = 'hold';
  else if (unknownOccupancy || caution) status = 'conditional';
  else status = 'recommended';

  if (status === 'recommended') {
    strengths.push('보수적 가치와 가격 근거가 일치합니다.');
    strengths.push('목표 마진과 하드캡을 반영한 입찰가입니다.');
  }
  if (unresolvedTrust) {
    reasonCodes.push('TRUST_STATUS_UNRESOLVED');
    requiredChecks.push('목록 신뢰성 상태와 원천 자료를 재검토하세요.');
  }
  if (reviewRequired) {
    reasonCodes.push('RIGHTS_REVIEW_REQUIRED');
    requiredChecks.push('권리분석 검토 필요 항목을 사람에게 확인받으세요.');
  }
  if (unknownOccupancy) {
    reasonCodes.push('OCCUPANCY_UNKNOWN');
    requiredChecks.push('점유자 실거주 여부와 명도 가능성을 현장 확인하세요.');
  }
  if (caution) {
    reasonCodes.push('RISK_GRADE_CAUTION');
    requiredChecks.push('주의 등급의 권리·현장 리스크를 추가 확인하세요.');
  }
  if (sparseEvidence && validEvidence) {
    risks.push('비교사례가 성긴 가격 근거입니다.');
    requiredChecks.push('독립적인 추가 비교사례를 확인하세요.');
  }

  const confidence: PrecisionConfidence = status === 'hold' || status === 'conditional' || status === 'rejected'
    ? 'low'
    : input.marketConfidence === 'high' && positiveComparables.length >= 3 ? 'high' : 'medium';

  return result(status, confidence, conservativeValue, recommendedBid, hardCapBid, reasonCodes, strengths, risks, requiredChecks);
};
