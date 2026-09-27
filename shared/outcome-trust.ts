export type OutcomeTrustStatus = 'trusted' | 'hold' | 'quarantined';

export type OutcomeTrustReasonCode =
  | 'MISSING_APPRAISAL'
  | 'MISSING_SOLD_AMOUNT'
  | 'MISSING_RESULT'
  | 'EXTREME_SALE_RATIO'
  | 'DUPLICATE_RESULT'
  | 'SALE_DATE_MISMATCH'
  | 'BATCH_SALE_SUSPECTED';

export interface OutcomeTrustInput {
  appraisalValue: number | null;
  soldAmount: number | null;
  duplicateResultCount: number;
  resultKnown?: boolean;
  saleDateMatches: boolean;
  sold?: boolean;
  batchSaleSuspected: boolean;
  caseNo?: string;
  itemNo?: string;
  saleDate?: string;
}

export interface OutcomeTrustResult {
  status: OutcomeTrustStatus;
  ratio: number | null;
  reasonCodes: OutcomeTrustReasonCode[];
  checks: Record<string, boolean>;
  evaluatorVersion: 'outcome-trust-v2';
}

const MIN_TRUSTED_SALE_RATIO = 0.2;
const MAX_TRUSTED_SALE_RATIO = 1.5;

export const evaluateOutcomeTrust = (input: OutcomeTrustInput): OutcomeTrustResult => {
  const missingAppraisal = input.appraisalValue === null;
  const sold = input.sold ?? true;
  const resultKnown = input.resultKnown ?? true;
  const missingResult = !resultKnown;
  const missingSoldAmount = sold && input.soldAmount === null;
  const ratio = !sold || missingAppraisal || missingSoldAmount
    ? null
    : (input.soldAmount as number) / (input.appraisalValue as number);
  const extremeSaleRatio = ratio !== null
    && (ratio < MIN_TRUSTED_SALE_RATIO || ratio > MAX_TRUSTED_SALE_RATIO);
  const duplicateResult = input.duplicateResultCount > 1;
  const saleDateMismatch = input.saleDateMatches === false && resultKnown;
  const batchSaleSuspected = input.batchSaleSuspected;

  const failedChecks: Array<[OutcomeTrustReasonCode, boolean]> = [
    ['MISSING_APPRAISAL', missingAppraisal],
    ['MISSING_SOLD_AMOUNT', missingSoldAmount],
    ['MISSING_RESULT', missingResult],
    ['EXTREME_SALE_RATIO', extremeSaleRatio],
    ['DUPLICATE_RESULT', duplicateResult],
    ['SALE_DATE_MISMATCH', saleDateMismatch],
    ['BATCH_SALE_SUSPECTED', batchSaleSuspected],
  ];
  const reasonCodes = failedChecks.filter(([, failed]) => failed).map(([reason]) => reason);
  const quarantined = reasonCodes.some((reason) => (
    reason === 'EXTREME_SALE_RATIO'
    || reason === 'DUPLICATE_RESULT'
    || reason === 'SALE_DATE_MISMATCH'
    || reason === 'BATCH_SALE_SUSPECTED'
  ));

  return {
    status: quarantined ? 'quarantined' : reasonCodes.length > 0 ? 'hold' : 'trusted',
    ratio,
    reasonCodes,
    checks: Object.fromEntries(failedChecks.map(([reason, failed]) => [reason, !failed])),
    evaluatorVersion: 'outcome-trust-v2',
  };
};
