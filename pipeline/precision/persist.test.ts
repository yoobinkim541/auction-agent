import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Listing, LocationAnalysis, RightsAnalysisResult, Score } from '../../shared/types.ts';

const db = vi.hoisted(() => ({
  saveRightsAnalysis: vi.fn(),
  saveLocationAnalysis: vi.fn(),
  backfillFailCountFromSaleRounds: vi.fn(),
  saveListingDataTrust: vi.fn(),
  savePrecisionEvaluation: vi.fn(),
  saveScore: vi.fn(),
}));

vi.mock('../../shared/db.ts', () => db);

import {
  persistPrecisionStages,
  setPrecisionEvaluatorForTesting,
} from './persist.ts';

const listing: Listing = {
  caseNo: '2026타경101', itemNo: '1', court: '서울중앙지방법원', address: '서울시 중구 1',
  propertyType: 'apartment', appraisalValue: 300_000_000, minBidPrice: 180_000_000,
  failCount: 1, source: 'courtauction', crawledAt: new Date().toISOString(),
};

const rights = {
  caseNo: listing.caseNo,
  classified: [{ entry: {}, disposition: 'extinguished', reason: '' }],
  tenants: [],
  assumedAmount: 0,
  maxSafeBid: 250_000_000,
  redFlags: [],
  riskGrade: 'clean',
  warnings: [],
} as unknown as RightsAnalysisResult;

const location = {
  caseNo: listing.caseNo,
  marketPrice: 320_000_000,
  marketConfidence: 'high',
  comps: [
    { areaM2: 80, dealAmount: 310_000_000, dealDate: '2026-08-01' },
    { areaM2: 80, dealAmount: 315_000_000, dealDate: '2026-08-02' },
  ],
  safetyMargin: 0.4,
  expectedBidPrice: 200_000_000,
  acquisitionCost: {
    acqTax: 4_000_000, moveOutCost: 2_000_000, bondCost: 1_000_000, etcCost: 500_000,
    trueSafetyMargin: 0.25,
  },
  saleRounds: [{ round: 2, date: '2026-09-01', minPrice: 180_000_000 }],
  eviction: { occupantLabel: '소유자·채무자 점유' },
} as unknown as LocationAnalysis;

const passingScore = (): Score => ({
  caseNo: listing.caseNo, safetyMarginScore: 90, cleanRightsScore: 100, totalScore: 95,
  passedFilter: true, reason: 'legacy pass',
});

const persistenceInput = () => ({
  listingId: 101,
  listing,
  rights,
  location,
  documents: [{ itemNo: '1' }],
  analysisAt: new Date().toISOString(),
  score: passingScore(),
});

afterEach(() => {
  setPrecisionEvaluatorForTesting(undefined);
  vi.clearAllMocks();
});

describe('persistPrecisionStages', () => {
  it('uses production persistence functions in the required order', async () => {
    const events: string[] = [];
    db.saveRightsAnalysis.mockImplementation(async () => { events.push('saveRightsAnalysis'); });
    db.saveLocationAnalysis.mockImplementation(async () => { events.push('saveLocationAnalysis'); });
    db.backfillFailCountFromSaleRounds.mockImplementation(async () => { events.push('backfillFailCountFromSaleRounds'); });
    db.saveListingDataTrust.mockImplementation(async () => { events.push('saveListingDataTrust'); });
    db.savePrecisionEvaluation.mockImplementation(async () => { events.push('savePrecisionEvaluation'); });
    db.saveScore.mockImplementation(async () => { events.push('saveScore'); });

    await persistPrecisionStages(persistenceInput());

    expect(events).toEqual([
      'saveRightsAnalysis',
      'saveLocationAnalysis',
      'backfillFailCountFromSaleRounds',
      'saveListingDataTrust',
      'savePrecisionEvaluation',
      'saveScore',
    ]);
    expect(db.saveListingDataTrust).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ status: 'hold', reasonCodes: ['INSUFFICIENT_COMPS'] }),
      expect.any(String),
    );
  });

  it('persists an internal-error hold and blocks a legacy pass when the precision evaluator throws', async () => {
    setPrecisionEvaluatorForTesting(() => { throw new Error('evaluator unavailable'); });

    await persistPrecisionStages(persistenceInput());

    expect(db.savePrecisionEvaluation).toHaveBeenCalledWith(
      101,
      expect.objectContaining({
        status: 'hold', confidence: 'low', reasonCodes: ['INTERNAL_EVALUATION_ERROR'],
      }),
      expect.any(String),
    );
    expect(db.saveScore).toHaveBeenCalledWith(101, expect.objectContaining({
      passedFilter: false,
      reason: expect.stringContaining('정밀 평가 내부 오류'),
    }));
  });
});
