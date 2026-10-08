export type DataTrustStatus = 'trusted' | 'hold' | 'quarantined';

export type DataTrustReasonCode =
  | 'MISSING_RIGHTS' | 'EMPTY_REGISTRY' | 'MISSING_LOCATION'
  | 'MISSING_MARKET_PRICE' | 'MISSING_EXPECTED_BID' | 'INSUFFICIENT_COMPS'
  | 'ITEM_MISMATCH' | 'MONEY_PARSE_WARNING'
  | 'STALE_RIGHTS_ANALYSIS' | 'STALE_LOCATION_ANALYSIS';

export interface ListingTrustInput {
  caseNo: string; itemNo: string; appraisalValue: number | null; minBidPrice: number | null;
  crawledAt: string; rightsAnalyzed: boolean; registryCount: number; tenantCount: number;
  moneyParseWarnings: number; documentItemMismatch: boolean; locationAnalyzed: boolean;
  marketPrice: number | null; expectedBidPrice: number | null; comparableCount: number;
  rightsAnalyzedAt: string | null; locationAnalyzedAt: string | null;
}

export interface ListingTrustResult {
  status: DataTrustStatus; score: number; reasonCodes: DataTrustReasonCode[];
  checks: Record<string, boolean>; evaluatorVersion: 'listing-trust-v2';
}

const MAX_ANALYSIS_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEDUCTIONS: Record<Exclude<DataTrustReasonCode, 'ITEM_MISMATCH' | 'MONEY_PARSE_WARNING'>, number> = {
  MISSING_RIGHTS: 35,
  EMPTY_REGISTRY: 30,
  MISSING_LOCATION: 35,
  MISSING_MARKET_PRICE: 25,
  MISSING_EXPECTED_BID: 20,
  INSUFFICIENT_COMPS: 10,
  STALE_RIGHTS_ANALYSIS: 15,
  STALE_LOCATION_ANALYSIS: 15,
};

const parseDate = (value: string | null): Date | null => {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const evaluateListingTrust = (input: ListingTrustInput, now = new Date()): ListingTrustResult => {
  const crawledAt = parseDate(input.crawledAt);
  const nowMs = now.getTime();
  const staleAnalysis = (value: string | null): boolean => {
    const analysisAt = parseDate(value);
    const analysisMs = analysisAt?.getTime() ?? null;
    return analysisMs === null
    || nowMs - analysisMs > MAX_ANALYSIS_AGE_MS
    || (crawledAt !== null && analysisMs < crawledAt.getTime());
  };

  const failedChecks: Array<[DataTrustReasonCode, boolean]> = [
    ['MISSING_RIGHTS', !input.rightsAnalyzed],
    ['EMPTY_REGISTRY', input.registryCount <= 0],
    ['MISSING_LOCATION', !input.locationAnalyzed],
    ['MISSING_MARKET_PRICE', input.marketPrice === null],
    ['MISSING_EXPECTED_BID', input.expectedBidPrice === null],
    ['INSUFFICIENT_COMPS', input.comparableCount < 3],
    ['ITEM_MISMATCH', input.documentItemMismatch],
    ['MONEY_PARSE_WARNING', input.moneyParseWarnings > 0],
    ['STALE_RIGHTS_ANALYSIS', staleAnalysis(input.rightsAnalyzedAt)],
    ['STALE_LOCATION_ANALYSIS', staleAnalysis(input.locationAnalyzedAt)],
  ];
  const reasonCodes = failedChecks.filter(([, failed]) => failed).map(([reason]) => reason);
  const quarantined = reasonCodes.includes('ITEM_MISMATCH') || reasonCodes.includes('MONEY_PARSE_WARNING');
  const score = quarantined
    ? 0
    : Math.max(0, Math.min(100, 100 - reasonCodes.reduce((total, reason) => (
      total + (reason in DEDUCTIONS ? DEDUCTIONS[reason as keyof typeof DEDUCTIONS] : 0)
    ), 0)));

  return {
    status: quarantined ? 'quarantined' : reasonCodes.length > 0 ? 'hold' : 'trusted',
    score,
    reasonCodes,
    checks: Object.fromEntries(failedChecks.map(([reason, failed]) => [reason, !failed])),
    evaluatorVersion: 'listing-trust-v2',
  };
};
