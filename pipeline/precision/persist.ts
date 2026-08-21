import {
  backfillFailCountFromSaleRounds,
  saveListingDataTrust,
  saveLocationAnalysis,
  savePrecisionEvaluation,
  saveRightsAnalysis,
  saveScore,
} from '../../shared/db.ts';
import { evaluateListingTrust } from '../../shared/data-trust.ts';
import type { Listing, LocationAnalysis, RightsAnalysisResult, Score } from '../../shared/types.ts';
import { evaluatePrecision } from './evaluate.ts';
import type { PrecisionEvaluation, PrecisionInput } from './evaluate.ts';
import {
  buildListingTrustInput,
  buildPrecisionInput,
  hashEvaluationInput,
  internalEvaluationHold,
} from './input.ts';

type PrecisionEvaluator = (input: PrecisionInput) => PrecisionEvaluation;

let precisionEvaluator: PrecisionEvaluator = evaluatePrecision;

export function setPrecisionEvaluatorForTesting(evaluator: PrecisionEvaluator | undefined): void {
  precisionEvaluator = evaluator ?? evaluatePrecision;
}

export interface PrecisionPersistenceInput {
  listingId: number;
  listing: Listing;
  rights: RightsAnalysisResult;
  location: LocationAnalysis;
  documents: readonly unknown[];
  analysisAt: string;
  score: Score;
  modelVersion?: string;
  citations?: unknown;
}

export interface PrecisionPersistenceResult {
  precision: PrecisionEvaluation;
  score: Score;
}

export async function persistPrecisionStages(input: PrecisionPersistenceInput): Promise<PrecisionPersistenceResult> {
  await saveRightsAnalysis(input.listingId, input.rights, input.modelVersion, input.citations);
  await saveLocationAnalysis(input.listingId, input.location);
  await backfillFailCountFromSaleRounds(input.listingId, input.location.saleRounds);

  const trustInput = buildListingTrustInput({
    listing: input.listing,
    rights: input.rights,
    location: input.location,
    documents: input.documents,
    analysisAt: input.analysisAt,
  });
  const trust = evaluateListingTrust(trustInput);
  await saveListingDataTrust(input.listingId, trust, hashEvaluationInput(trustInput));

  const precisionInput = buildPrecisionInput({
    listing: input.listing,
    rights: input.rights,
    location: input.location,
    trustStatus: trust.status,
  });
  let precision: PrecisionEvaluation;
  try {
    precision = precisionEvaluator(precisionInput);
  } catch (error) {
    console.warn(`[precision] ${input.listing.caseNo} 평가 실패: ${error instanceof Error ? error.message : String(error)}`);
    precision = internalEvaluationHold();
  }
  await savePrecisionEvaluation(input.listingId, precision, hashEvaluationInput(precisionInput));

  const score = precision.reasonCodes.includes('INTERNAL_EVALUATION_ERROR') && input.score.passedFilter
    ? {
      ...input.score,
      passedFilter: false,
      reason: `${input.score.reason ? `${input.score.reason}; ` : ''}정밀 평가 내부 오류 — 추천 보류`,
    }
    : input.score;
  await saveScore(input.listingId, score);

  return { precision, score };
}
