import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Listing, LocationAnalysis, RightsAnalysisResult, Score } from '../../shared/types.ts';
import type { RegistryOpinionRow } from '../../shared/db.ts';

const db = vi.hoisted(() => ({
  saveRightsAnalysis: vi.fn(),
  saveLocationAnalysis: vi.fn(),
  backfillFailCountFromSaleRounds: vi.fn(),
  saveListingDataTrust: vi.fn(),
  savePrecisionEvaluation: vi.fn(),
  saveScore: vi.fn(),
  fetchRegistryOpinion: vi.fn<(listingId: number) => Promise<RegistryOpinionRow | null>>(async () => null),
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

  it('EMPTY_REGISTRY 단독 hold + 캐시된 AI 소견(hasClue) → conditional로 완화한다', async () => {
    db.fetchRegistryOpinion.mockResolvedValueOnce({
      has_clue: true, tentative_kind: 'geunjeodang', tentative_date: '2023-05-01',
      explanation: '소견', citations: [], required_checks: ['등기부 직접 열람 필요'],
      confidence: 'medium', model_version: 'claude-cli(subscription)', input_hash: 'h',
    });
    const registryOnlyInput = {
      ...persistenceInput(),
      rights: { ...rights, classified: [] } as unknown as RightsAnalysisResult, // registryCount=0 → EMPTY_REGISTRY
      location: { ...location, comps: [...location.comps, { areaM2: 80, dealAmount: 312_000_000, dealDate: '2026-08-03' }] } as unknown as LocationAnalysis, // comparableCount=3 → INSUFFICIENT_COMPS 회피(EMPTY_REGISTRY 단독화)
    };

    await persistPrecisionStages(registryOnlyInput);

    expect(db.saveListingDataTrust).toHaveBeenCalledWith(
      101, expect.objectContaining({ status: 'hold', reasonCodes: ['EMPTY_REGISTRY'] }), expect.any(String),
    );
    expect(db.fetchRegistryOpinion).toHaveBeenCalledWith(101);
    expect(db.savePrecisionEvaluation).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ status: 'conditional', reasonCodes: expect.arrayContaining(['REGISTRY_AI_OPINION_UNCONFIRMED']) }),
      expect.any(String),
    );
  });

  it('EMPTY_REGISTRY 외 다른 사유도 섞이면 AI 소견을 조회하지 않고 정상 hold를 유지한다', async () => {
    const mixedReasonInput = {
      ...persistenceInput(),
      rights: { ...rights, classified: [] } as unknown as RightsAnalysisResult, // EMPTY_REGISTRY + 기존 comps(2건)로 INSUFFICIENT_COMPS도 겹침
    };

    await persistPrecisionStages(mixedReasonInput);

    expect(db.fetchRegistryOpinion).not.toHaveBeenCalled();
    expect(db.savePrecisionEvaluation).toHaveBeenCalledWith(
      101, expect.objectContaining({ status: 'hold' }), expect.any(String),
    );
  });

  it.each([
    ['missing recommended bid', null, 250_000_000],
    ['bid below the listing minimum', 170_000_000, 250_000_000],
    ['bid above the hard cap', 260_000_000, 250_000_000],
  ] as const)('fails closed before persistence for %s', async (_label, recommendedBid, hardCapBid) => {
    setPrecisionEvaluatorForTesting(() => ({
      status: 'recommended',
      confidence: 'high',
      conservativeValue: 300_000_000,
      recommendedBid,
      hardCapBid,
      reasonCodes: [],
      strengths: [],
      risks: [],
      requiredChecks: [],
      evaluatorVersion: 'precision-v1',
    }));

    await persistPrecisionStages(persistenceInput());

    expect(db.savePrecisionEvaluation).toHaveBeenCalledWith(
      101,
      expect.objectContaining({
        status: 'hold',
        confidence: 'low',
        reasonCodes: ['INTERNAL_EVALUATION_ERROR'],
      }),
      expect.any(String),
    );
    expect(db.saveScore).toHaveBeenCalledWith(101, expect.objectContaining({
      passedFilter: false,
      reason: expect.stringContaining('정밀 평가 내부 오류'),
    }));
  });
});
