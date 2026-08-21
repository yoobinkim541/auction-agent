import { describe, expect, it } from 'vitest';
import { evaluateListingTrust, type ListingTrustInput } from './data-trust.ts';

const complete = (over: Partial<ListingTrustInput> = {}): ListingTrustInput => ({
  caseNo: '2026타경1', itemNo: '1', appraisalValue: 300_000_000,
  minBidPrice: 210_000_000, crawledAt: '2026-08-21T00:00:00Z',
  rightsAnalyzed: true, registryCount: 2, tenantCount: 0,
  moneyParseWarnings: 0, documentItemMismatch: false,
  locationAnalyzed: true, marketPrice: 350_000_000,
  expectedBidPrice: 230_000_000, comparableCount: 3,
  analysisAt: '2026-08-21T00:00:00Z',
  ...over,
});

describe('evaluateListingTrust', () => {
  it('marks complete evidence trusted', () => {
    expect(evaluateListingTrust(complete(), new Date('2026-08-21T12:00:00Z')).status).toBe('trusted');
  });
  it('holds missing market evidence', () => {
    const result = evaluateListingTrust(complete({ marketPrice: null, comparableCount: 0 }));
    expect(result.status).toBe('hold');
    expect(result.reasonCodes).toContain('MISSING_MARKET_PRICE');
  });
  it('quarantines item mismatch and money warnings', () => {
    const result = evaluateListingTrust(complete({ documentItemMismatch: true, moneyParseWarnings: 1 }));
    expect(result.status).toBe('quarantined');
    expect(result.score).toBe(0);
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['ITEM_MISMATCH', 'MONEY_PARSE_WARNING']));
  });
  it('does not mark analysis exactly seven days old as stale', () => {
    const result = evaluateListingTrust(
      complete({ crawledAt: '2026-08-14T12:00:00Z', analysisAt: '2026-08-14T12:00:00Z' }),
      new Date('2026-08-21T12:00:00Z'),
    );
    expect(result.reasonCodes).not.toContain('STALE_ANALYSIS');
  });
  it('marks analysis more than seven days old as stale', () => {
    const result = evaluateListingTrust(
      complete({ crawledAt: '2026-08-14T11:59:59.999Z', analysisAt: '2026-08-14T11:59:59.999Z' }),
      new Date('2026-08-21T12:00:00Z'),
    );
    expect(result.reasonCodes).toContain('STALE_ANALYSIS');
    expect(result.status).toBe('hold');
  });
  it('marks analysis older than crawl as stale', () => {
    const result = evaluateListingTrust(
      complete({ crawledAt: '2026-08-21T12:00:00Z', analysisAt: '2026-08-21T11:59:59.999Z' }),
      new Date('2026-08-21T12:00:00Z'),
    );
    expect(result.reasonCodes).toContain('STALE_ANALYSIS');
  });
});
