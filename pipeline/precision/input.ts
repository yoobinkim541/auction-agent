import { createHash } from 'node:crypto';
import type { ListingTrustInput } from '../../shared/data-trust.ts';
import type { Listing, LocationAnalysis, RightsAnalysisResult } from '../../shared/types.ts';
import type { PrecisionEvaluation, PrecisionInput, PrecisionTrustStatus } from './evaluate.ts';

const MONEY_WARNING_PATTERNS = ['파싱', '금액 단위', '보증금 단위'];

const nonblankItemMismatch = (documents: readonly unknown[], itemNo: string): boolean => (
  documents.some((document) => {
    if (document === null || typeof document !== 'object') return false;
    const parsed = document as Record<string, unknown>;
    return [parsed.itemNo, parsed.item_no].some((value) => (
      value != null && String(value).trim().length > 0 && String(value).trim() !== itemNo
    ));
  })
);

const moneyParseWarnings = (warnings: readonly string[]): number => (
  warnings.filter((warning) => MONEY_WARNING_PATTERNS.some((pattern) => warning.includes(pattern))).length
);

export function buildListingTrustInput(args: {
  listing: Listing;
  rights: RightsAnalysisResult;
  location: LocationAnalysis;
  documents: readonly unknown[];
  analysisAt: string;
}): ListingTrustInput {
  const itemNo = args.listing.itemNo?.trim() || '1';
  return {
    caseNo: args.listing.caseNo,
    itemNo,
    appraisalValue: args.listing.appraisalValue,
    minBidPrice: args.listing.minBidPrice,
    crawledAt: args.listing.crawledAt,
    rightsAnalyzed: true,
    registryCount: args.rights.classified.length,
    tenantCount: args.rights.tenants.length,
    moneyParseWarnings: moneyParseWarnings(args.rights.warnings),
    documentItemMismatch: nonblankItemMismatch(args.documents, itemNo),
    locationAnalyzed: true,
    marketPrice: args.location.marketPrice,
    expectedBidPrice: args.location.expectedBidPrice ?? null,
    comparableCount: args.location.comps.length + (args.location.siteComps?.length ?? 0),
    analysisAt: args.analysisAt,
  };
}

export function buildPrecisionInput(args: {
  listing: Listing;
  rights: RightsAnalysisResult;
  location: LocationAnalysis;
  trustStatus: PrecisionTrustStatus;
}): PrecisionInput {
  const cost = args.location.acquisitionCost;
  return {
    trustStatus: args.trustStatus,
    appraisalValue: args.listing.appraisalValue,
    minBidPrice: args.listing.minBidPrice,
    marketPrice: args.location.marketPrice,
    marketConfidence: args.location.marketConfidence ?? 'low',
    comparablePrices: [
      ...args.location.comps.map((comparable) => comparable.dealAmount),
      ...(args.location.siteComps ?? []).map((comparable) => comparable.dealManwon * 10_000),
    ],
    expectedBidPrice: args.location.expectedBidPrice ?? null,
    maxSafeBid: args.rights.maxSafeBid,
    assumedAmount: args.rights.assumedAmount,
    riskGrade: args.rights.riskGrade,
    dangerFlagCount: args.rights.redFlags.filter((flag) => flag.severity === 'danger').length,
    occupantLabel: args.location.eviction?.occupantLabel ?? '점유관계 미상',
    trueSafetyMargin: cost?.trueSafetyMargin ?? null,
    fixedCosts: cost ? cost.acqTax + cost.moveOutCost + cost.bondCost + cost.etcCost : 0,
  };
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const hashEvaluationInput = (input: ListingTrustInput | PrecisionInput): string => (
  createHash('sha256').update(stableJson(input)).digest('hex')
);

export const hashPrecisionInput = (input: PrecisionInput): string => hashEvaluationInput(input);

export const internalEvaluationHold = (): PrecisionEvaluation => ({
  status: 'hold',
  confidence: 'low',
  conservativeValue: null,
  recommendedBid: null,
  hardCapBid: null,
  reasonCodes: ['INTERNAL_EVALUATION_ERROR'],
  strengths: [],
  risks: ['정밀 평가 중 내부 오류가 발생했습니다.'],
  requiredChecks: ['평가 입력과 원천 자료를 다시 확인하세요.'],
  evaluatorVersion: 'precision-v1',
});
