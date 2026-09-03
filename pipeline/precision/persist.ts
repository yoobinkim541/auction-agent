import {
  backfillFailCountFromSaleRounds,
  fetchRegistryOpinion,
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

function persistenceSafePrecision(
  evaluation: PrecisionEvaluation,
  input: PrecisionInput,
): PrecisionEvaluation {
  if (evaluation.status !== 'recommended') return evaluation;
  const recommendedBid = evaluation.recommendedBid;
  const hardCapBid = evaluation.hardCapBid;
  const minBidPrice = input.minBidPrice;
  const valid = Number.isSafeInteger(recommendedBid)
    && Number.isSafeInteger(hardCapBid)
    && Number.isSafeInteger(minBidPrice)
    && (recommendedBid as number) >= (minBidPrice as number)
    && (recommendedBid as number) <= (hardCapBid as number);
  if (valid) return evaluation;
  return internalEvaluationHold();
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
    rightsAnalyzedAt: input.analysisAt,
    locationAnalyzedAt: input.analysisAt,
  });
  const trust = evaluateListingTrust(trustInput);
  await saveListingDataTrust(input.listingId, trust, hashEvaluationInput(trustInput));

  // EMPTY_REGISTRY가 신뢰 실패의 유일한 사유일 때만 AI 1차 소견을 조회한다(다른 사유가 섞이면
  // 무시 — 그 물건은 여전히 정상 hold). 여기서는 배치(scripts/registry-opinion-backfill.ts)가
  // 미리 채워둔 값을 읽기만 한다 — 매 분석마다 Claude를 부르지 않는다.
  const registryOnlyHold = trust.status !== 'trusted' && trust.reasonCodes.length === 1
    && trust.reasonCodes[0] === 'EMPTY_REGISTRY';
  const registryOpinion = registryOnlyHold ? await fetchRegistryOpinion(input.listingId) : null;

  const precisionInput = buildPrecisionInput({
    listing: input.listing,
    rights: input.rights,
    location: input.location,
    trustStatus: trust.status,
    registryOpinion: registryOpinion ? { hasClue: registryOpinion.has_clue, requiredChecks: registryOpinion.required_checks } : null,
  });
  let precision: PrecisionEvaluation;
  try {
    precision = persistenceSafePrecision(precisionEvaluator(precisionInput), precisionInput);
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
