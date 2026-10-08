import { describe, expect, it } from 'vitest';
import {
  buildListingTrustInput,
  buildPrecisionInput,
  hashEvaluationInput,
  internalEvaluationHold,
  hashPrecisionInput,
} from './input.ts';
import type { Listing, LocationAnalysis, RightsAnalysisResult } from '../../shared/types.ts';

const listing: Listing = {
  caseNo: '2026타경101', itemNo: '2', court: '서울중앙지방법원', address: '서울시 중구 1',
  propertyType: 'apartment', appraisalValue: 300_000_000, minBidPrice: 180_000_000,
  failCount: 1, source: 'courtauction', crawledAt: '2026-08-20T10:00:00.000Z',
};

const rights = {
  classified: [{ entry: {}, disposition: 'extinguished', reason: '' }],
  tenants: [],
  assumedAmount: 0,
  maxSafeBid: 220_000_000,
  redFlags: [{ severity: 'danger' }, { severity: 'warn' }],
  riskGrade: 'clean',
  warnings: ['금액 단위 확인 필요'],
} as unknown as RightsAnalysisResult;

const location = {
  marketPrice: 320_000_000,
  marketConfidence: 'high',
  comps: [{ dealAmount: 310_000_000 }],
  expectedBidPrice: 200_000_000,
  acquisitionCost: {
    acqTax: 4_000_000, moveOutCost: 2_000_000, bondCost: 1_000_000, etcCost: 500_000,
    trueSafetyMargin: 0.25,
  },
  siteComps: [{ dealManwon: 31_500 }],
  eviction: { occupantLabel: '소유자·채무자 점유' },
} as unknown as LocationAnalysis;

describe('precision input mapping', () => {
  it('maps trust and precision inputs with one site-comparable unit conversion', () => {
    const trustInput = buildListingTrustInput({
      listing,
      rights,
      location,
      documents: [{ itemNo: '2' }, { item_no: '2' }, {}],
      rightsAnalyzedAt: '2026-08-21T09:59:59.000Z',
      locationAnalyzedAt: '2026-08-21T10:00:00.000Z',
    });
    const precisionInput = buildPrecisionInput({ listing, rights, location, trustStatus: 'trusted' });

    expect(trustInput).toMatchObject({
      crawledAt: '2026-08-20T10:00:00.000Z', registryCount: 1, tenantCount: 0,
      moneyParseWarnings: 1, documentItemMismatch: false, marketPrice: 320_000_000,
      expectedBidPrice: 200_000_000, comparableCount: 2,
      rightsAnalyzedAt: '2026-08-21T09:59:59.000Z',
      locationAnalyzedAt: '2026-08-21T10:00:00.000Z',
    });
    expect(precisionInput).toEqual({
      trustStatus: 'trusted', registryOpinion: null, appraisalValue: 300_000_000, minBidPrice: 180_000_000,
      marketPrice: 320_000_000, marketConfidence: 'high',
      comparablePrices: [310_000_000, 315_000_000], expectedBidPrice: 200_000_000,
      maxSafeBid: 220_000_000, assumedAmount: 0, riskGrade: 'clean', dangerFlagCount: 1,
      occupantLabel: '소유자·채무자 점유', trueSafetyMargin: 0.25, fixedCosts: 7_500_000,
    });
  });

  it('registryOpinion을 전달하면 그대로 precisionInput에 실린다', () => {
    const opinion = { hasClue: true, requiredChecks: ['등기부 직접 열람 필요'] };
    const precisionInput = buildPrecisionInput({ listing, rights, location, trustStatus: 'hold', registryOpinion: opinion });
    expect(precisionInput.registryOpinion).toEqual(opinion);
  });

  it('flags only explicit embedded item numbers that differ from the listing item', () => {
    const input = buildListingTrustInput({
      listing,
      rights,
      location,
      documents: [{ itemNo: '3' }, {}, { item_no: ' ' }],
      rightsAnalyzedAt: '2026-08-21T09:59:59.000Z',
      locationAnalyzedAt: '2026-08-21T10:00:00.000Z',
    });

    expect(input.documentItemMismatch).toBe(true);
  });

  it('hashes precision inputs deterministically', () => {
    const input = buildPrecisionInput({ listing, rights, location, trustStatus: 'trusted' });

    expect(hashPrecisionInput(input)).toBe(hashPrecisionInput({ ...input }));
    expect(hashEvaluationInput(input)).toBe(hashPrecisionInput(input));
  });

  it('creates a low-confidence hold when precision evaluation throws', () => {
    expect(internalEvaluationHold()).toMatchObject({
      status: 'hold', confidence: 'low', reasonCodes: ['INTERNAL_EVALUATION_ERROR'],
      conservativeValue: null, recommendedBid: null, hardCapBid: null,
      evaluatorVersion: 'precision-v1',
    });
  });
});
