import { describe, expect, it } from 'vitest';
import { evaluatePrecision, type PrecisionInput } from './evaluate.js';

const precisionInput = (overrides: Partial<PrecisionInput> = {}): PrecisionInput => ({
  trustStatus: 'trusted',
  appraisalValue: 200_000_000,
  minBidPrice: 100_000_000,
  marketPrice: 200_000_000,
  marketConfidence: 'high',
  comparablePrices: [190_000_000, 200_000_000, 210_000_000, 220_000_000],
  expectedBidPrice: 120_000_000,
  maxSafeBid: 150_000_000,
  assumedAmount: 0,
  riskGrade: 'clean',
  dangerFlagCount: 0,
  occupantLabel: '소유자 점유',
  trueSafetyMargin: 0.25,
  fixedCosts: 10_000_000,
  ...overrides,
});

describe('evaluatePrecision', () => {
  it.each([
    ['safe', {}, 'recommended'],
    ['trust hold', { trustStatus: 'hold' }, 'hold'],
    ['trust quarantine', { trustStatus: 'quarantined' }, 'hold'],
    ['assumed amount', { assumedAmount: 10_000_000 }, 'rejected'],
    ['danger flags', { dangerFlagCount: 1 }, 'rejected'],
    ['risky grade', { riskGrade: 'risky' }, 'rejected'],
    ['below target margin', { trueSafetyMargin: 0.1 }, 'rejected'],
    ['min bid above cap', { minBidPrice: 150_000_001 }, 'rejected'],
    ['review required grade', { riskGrade: 'review_required' }, 'hold'],
    ['unknown occupancy', { occupantLabel: '점유관계 미상' }, 'conditional'],
    ['caution grade', { riskGrade: 'caution' }, 'conditional'],
    ['no comparables', { comparablePrices: [] }, 'hold'],
  ] as const)('%s has status %s', (_, overrides, status) => {
    expect(evaluatePrecision(precisionInput(overrides)).status).toBe(status);
  });

  it('uses nearest-rank p25 and the conservative price basis', () => {
    const result = evaluatePrecision(precisionInput({
      marketPrice: 250_000_000,
      comparablePrices: [300_000_000, 100_000_000, 200_000_000, 400_000_000],
    }));

    expect(result.conservativeValue).toBe(100_000_000);
  });

  it.each([
    [240_000_000, 'recommended'],
    [240_000_001, 'hold'],
  ] as const)('holds only when price basis divergence exceeds 20%% (%d)', (marketPrice, status) => {
    expect(evaluatePrecision(precisionInput({ marketPrice, comparablePrices: [200_000_000, 200_000_000] })).status).toBe(status);
  });

  it('caps bids by the cost cap and never recommends below the minimum bid', () => {
    const capped = evaluatePrecision(precisionInput({
      marketPrice: 200_000_000,
      comparablePrices: [200_000_000, 200_000_000, 200_000_000],
      maxSafeBid: 180_000_000,
      fixedCosts: 20_000_000,
      expectedBidPrice: 170_000_000,
    }));
    expect(capped.hardCapBid).toBe(150_000_000);
    expect(capped.recommendedBid).toBe(150_000_000);

    const minimum = evaluatePrecision(precisionInput({ expectedBidPrice: 80_000_000 }));
    expect(minimum.recommendedBid).toBe(100_000_000);
  });

  it.each([
    ['appraisalValue', { appraisalValue: null }],
    ['marketPrice', { marketPrice: 0 }],
    ['expectedBidPrice', { expectedBidPrice: null }],
    ['maxSafeBid', { maxSafeBid: null }],
    ['comparable price', { comparablePrices: [0, -1] }],
    ['one sparse comparable', { comparablePrices: [200_000_000], marketConfidence: 'medium' }],
  ] as const)('holds for missing or non-positive %s evidence', (_, overrides) => {
    expect(evaluatePrecision(precisionInput(overrides)).status).toBe('hold');
  });

  it.each([
    ['mixed comparable prices', [200_000_000, 0]],
    ['infinite comparable price', [200_000_000, Infinity]],
    ['NaN comparable price', [200_000_000, NaN]],
  ] as const)('never recommends with %s', (_, comparablePrices) => {
    const evaluation = evaluatePrecision(precisionInput({ comparablePrices }));
    expect(evaluation.status).toBe('hold');
    expect(evaluation.reasonCodes).toContain('INVALID_COMPARABLE_PRICE');
    expect(evaluation.recommendedBid).toBeNull();
    expect(`${evaluation.risks.join(' ')} ${evaluation.requiredChecks.join(' ')}`).toMatch(/[가-힣]/);
  });

  it.each([
    ['market', { marketPrice: null }],
    ['minimum bid', { minBidPrice: 0 }],
    ['expected bid', { expectedBidPrice: NaN }],
    ['maximum safe bid', { maxSafeBid: Infinity }],
    ['comparable', { comparablePrices: [200_000_000, -1] }],
  ] as const)('explains %s price holds in Korean', (_, overrides) => {
    const evaluation = evaluatePrecision(precisionInput(overrides));
    expect(evaluation.status).toBe('hold');
    expect(`${evaluation.risks.join(' ')} ${evaluation.requiredChecks.join(' ')}`).toMatch(/[가-힣]/);
    expect(evaluation.status).not.toBe('recommended');
  });

  it('allows one comparable only with high market confidence', () => {
    expect(evaluatePrecision(precisionInput({ comparablePrices: [200_000_000] })).status).toBe('recommended');
  });

  it('reports deterministic output metadata and confidence', () => {
    const result = evaluatePrecision(precisionInput());
    expect(result).toMatchObject({
      confidence: 'high',
      evaluatorVersion: 'precision-v1',
      strengths: expect.any(Array),
      risks: expect.any(Array),
      requiredChecks: expect.any(Array),
    });
    expect(result.reasonCodes).toEqual([]);
    expect(evaluatePrecision(precisionInput())).toEqual(result);
  });
});
