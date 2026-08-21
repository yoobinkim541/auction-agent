import type { ListingTrustResult } from '../../shared/data-trust.ts';
import type { Score } from '../../shared/types.ts';
import type { PrecisionEvaluation } from './evaluate.ts';
import { internalEvaluationHold } from './input.ts';

export interface PrecisionPersistenceStages {
  score: Score;
  saveRights: () => Promise<void>;
  saveLocation: () => Promise<void>;
  evaluateTrust: () => ListingTrustResult;
  saveTrust: (trust: ListingTrustResult) => Promise<void>;
  evaluatePrecision: (trust: ListingTrustResult) => PrecisionEvaluation;
  savePrecision: (evaluation: PrecisionEvaluation) => Promise<void>;
  saveLegacyScore: (score: Score) => Promise<void>;
  onPrecisionError?: (error: unknown) => void;
}

export interface PrecisionPersistenceResult {
  precision: PrecisionEvaluation;
  score: Score;
}

export async function persistPrecisionStages(stages: PrecisionPersistenceStages): Promise<PrecisionPersistenceResult> {
  await stages.saveRights();
  await stages.saveLocation();

  const trust = stages.evaluateTrust();
  await stages.saveTrust(trust);

  let precision: PrecisionEvaluation;
  try {
    precision = stages.evaluatePrecision(trust);
  } catch (error) {
    stages.onPrecisionError?.(error);
    precision = internalEvaluationHold();
  }
  await stages.savePrecision(precision);

  const score = precision.reasonCodes.includes('INTERNAL_EVALUATION_ERROR') && stages.score.passedFilter
    ? {
      ...stages.score,
      passedFilter: false,
      reason: `${stages.score.reason ? `${stages.score.reason}; ` : ''}정밀 평가 내부 오류 — 추천 보류`,
    }
    : stages.score;
  await stages.saveLegacyScore(score);

  return { precision, score };
}
