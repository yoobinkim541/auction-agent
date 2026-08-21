import { describe, expect, it } from 'vitest';
import {
  PRECISION_AUDIT_SQL,
  auditResult,
  type PrecisionAuditMetrics,
} from './precision-audit.ts';

const metrics = (overrides: Partial<PrecisionAuditMetrics> = {}): PrecisionAuditMetrics => ({
  safety: {
    recommendedNonTrusted: 0,
    recommendedAssumedAmount: 0,
    recommendedHardCapBelowMinBid: 0,
    duplicateCaseRepresentatives: 0,
    shortlistCount: 5,
  },
  precisionStatusDistribution: [],
  listingTrustStatusDistribution: [],
  outcomeTrustStatusDistribution: [],
  topHoldQuarantineReasons: [],
  decisionConversion: {
    recommended: 5,
    decided: 0,
    conversionRate: 0,
    byDecision: {},
  },
  trustedOutcomeCoverage: {
    raw: 0,
    evaluated: 0,
    trusted: 0,
    hold: 0,
    quarantined: 0,
    trustedRate: 0,
  },
  ...overrides,
});

describe('auditResult', () => {
  it.each([
    ['RECOMMENDED_NON_TRUSTED', { recommendedNonTrusted: 1 }],
    ['RECOMMENDED_ASSUMED_AMOUNT', { recommendedAssumedAmount: 1 }],
    ['RECOMMENDED_HARD_CAP_BELOW_MIN_BID', { recommendedHardCapBelowMinBid: 1 }],
    ['DUPLICATE_CASE_REPRESENTATIVES', { duplicateCaseRepresentatives: 1 }],
    ['SHORTLIST_ABOVE_WEEKLY_CAP', { shortlistCount: 8 }],
  ] as const)('fails the %s safety invariant', (code, safetyOverride) => {
    const result = auditResult(metrics({
      safety: { ...metrics().safety, ...safetyOverride },
    }));

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(code);
    expect(result.warnings).toEqual([]);
  });

  it('warns without failing when there are zero recommendations', () => {
    const result = auditResult(metrics({
      safety: { ...metrics().safety, shortlistCount: 0 },
      decisionConversion: { ...metrics().decisionConversion, recommended: 0 },
    }));

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['ZERO_RECOMMENDATIONS']);
  });
});

describe('precision audit SQL safety coverage', () => {
  it('counts missing rights and null assumed amounts as recommendation failures', () => {
    expect(PRECISION_AUDIT_SQL).toContain('left join gm_rights_analysis r');
    expect(PRECISION_AUDIT_SQL).toContain('r.assumed_amount is distinct from 0');
  });

  it('counts null hard caps and hard caps below minimum bid as failures', () => {
    expect(PRECISION_AUDIT_SQL).toContain('p.hard_cap_bid is null or p.hard_cap_bid < l.min_bid_price');
  });
});
