import { describe, expect, it } from 'vitest';
import { evaluateOutcomeTrust } from './outcome-trust.ts';

describe('evaluateOutcomeTrust', () => {
  it('trusts a plausible matched sale', () => {
    expect(evaluateOutcomeTrust({ appraisalValue: 300_000_000, soldAmount: 240_000_000,
      duplicateResultCount: 1, saleDateMatches: true, batchSaleSuspected: false }).status).toBe('trusted');
  });

  it('quarantines extreme sale ratios', () => {
    const result = evaluateOutcomeTrust({ appraisalValue: 495_900_000, soldAmount: 23_000_000_000,
      duplicateResultCount: 1, saleDateMatches: true, batchSaleSuspected: false });
    expect(result.status).toBe('quarantined');
    expect(result.reasonCodes).toContain('EXTREME_SALE_RATIO');
  });

  it('quarantines suspected aggregate results', () => {
    expect(evaluateOutcomeTrust({ appraisalValue: 216_000_000, soldAmount: 1_076_670_010,
      duplicateResultCount: 1, saleDateMatches: true, batchSaleSuspected: true }).reasonCodes)
      .toContain('BATCH_SALE_SUSPECTED');
  });

  it('trusts inclusive sale ratio boundaries', () => {
    expect(evaluateOutcomeTrust({ appraisalValue: 100, soldAmount: 20,
      duplicateResultCount: 1, saleDateMatches: true, batchSaleSuspected: false }).status).toBe('trusted');
    expect(evaluateOutcomeTrust({ appraisalValue: 100, soldAmount: 150,
      duplicateResultCount: 1, saleDateMatches: true, batchSaleSuspected: false }).status).toBe('trusted');
  });

  it('holds missing amounts', () => {
    const result = evaluateOutcomeTrust({ appraisalValue: null, soldAmount: null,
      duplicateResultCount: 1, saleDateMatches: true, batchSaleSuspected: false });
    expect(result.status).toBe('hold');
    expect(result.ratio).toBeNull();
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['MISSING_APPRAISAL', 'MISSING_SOLD_AMOUNT']));
  });

  it('trusts a known unsold result without a sold amount', () => {
    const result = evaluateOutcomeTrust({ appraisalValue: 300_000_000, soldAmount: null, sold: false,
      duplicateResultCount: 1, saleDateMatches: true, batchSaleSuspected: false });

    expect(result.status).toBe('trusted');
    expect(result.ratio).toBeNull();
    expect(result.reasonCodes).not.toContain('MISSING_SOLD_AMOUNT');
  });

  it('holds a snapshot with no matched auction result', () => {
    const result = evaluateOutcomeTrust({ appraisalValue: 300_000_000, soldAmount: null, sold: false,
      duplicateResultCount: 0, resultKnown: false, saleDateMatches: false, batchSaleSuspected: false });

    expect(result.status).toBe('hold');
    expect(result.reasonCodes).toContain('MISSING_RESULT');
  });

  it('quarantines duplicate, mismatched, and aggregate signals', () => {
    const result = evaluateOutcomeTrust({ appraisalValue: 100, soldAmount: 50,
      duplicateResultCount: 2, saleDateMatches: false, batchSaleSuspected: true });
    expect(result.status).toBe('quarantined');
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'DUPLICATE_RESULT', 'SALE_DATE_MISMATCH', 'BATCH_SALE_SUSPECTED',
    ]));
  });
});
