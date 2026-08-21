import { describe, expect, it } from 'vitest';
import { persistPrecisionStages } from './persist.ts';
import type { ListingTrustResult } from '../../shared/data-trust.ts';
import type { PrecisionEvaluation } from './evaluate.ts';
import type { Score } from '../../shared/types.ts';

const trusted: ListingTrustResult = {
  status: 'trusted', score: 100, reasonCodes: [], checks: {}, evaluatorVersion: 'listing-trust-v1',
};

const recommended: PrecisionEvaluation = {
  status: 'recommended', confidence: 'high', conservativeValue: 300_000_000,
  recommendedBid: 200_000_000, hardCapBid: 220_000_000, reasonCodes: [], strengths: [],
  risks: [], requiredChecks: [], evaluatorVersion: 'precision-v1',
};

const passingScore = (): Score => ({
  caseNo: '2026\ud0c0\uacbd101', safetyMarginScore: 90, cleanRightsScore: 100, totalScore: 95,
  passedFilter: true, reason: 'legacy pass',
});

describe('persistPrecisionStages', () => {
  it('persists rights and location before trust, then trust before precision', async () => {
    const events: string[] = [];

    await persistPrecisionStages({
      score: passingScore(),
      saveRights: async () => { events.push('rights'); },
      saveLocation: async () => { events.push('location'); },
      evaluateTrust: () => trusted,
      saveTrust: async () => { events.push('trust'); },
      evaluatePrecision: () => recommended,
      savePrecision: async () => { events.push('precision'); },
      saveLegacyScore: async () => { events.push('legacy'); },
    });

    expect(events).toEqual(['rights', 'location', 'trust', 'precision', 'legacy']);
  });

  it('persists an internal-error hold and blocks a legacy pass when precision evaluation throws', async () => {
    let savedPrecision: PrecisionEvaluation | undefined;
    let savedScore: Score | undefined;

    await persistPrecisionStages({
      score: passingScore(),
      saveRights: async () => {},
      saveLocation: async () => {},
      evaluateTrust: () => trusted,
      saveTrust: async () => {},
      evaluatePrecision: () => { throw new Error('evaluator unavailable'); },
      savePrecision: async (evaluation) => { savedPrecision = evaluation; },
      saveLegacyScore: async (score) => { savedScore = score; },
    });

    expect(savedPrecision).toMatchObject({
      status: 'hold', confidence: 'low', reasonCodes: ['INTERNAL_EVALUATION_ERROR'],
    });
    expect(savedScore).toMatchObject({ passedFilter: false });
    expect(savedScore?.reason).toContain('\uc815\ubc00 \ud3c9\uac00 \ub0b4\ubd80 \uc624\ub958');
  });
});
