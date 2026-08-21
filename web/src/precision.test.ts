import { describe, expect, it } from 'vitest';
import { canShowBid, decisionReasonLabel, precisionView } from './precision.ts';

describe('precision presentation', () => {
  it('labels hold verdicts with the missing-market rationale', () => {
    const view = precisionView({ status: 'hold', reason_codes: ['MISSING_MARKET_PRICE'] });

    expect(view.label).toBe('보류');
    expect(view.summary).toContain('시세 근거 부족');
  });

  it('only exposes bid values for recommended verdicts', () => {
    expect(canShowBid({ status: 'recommended', hard_cap_bid: 240_000_000 })).toBe(true);
    expect(canShowBid({ status: 'hold', hard_cap_bid: 240_000_000 })).toBe(false);
    expect(canShowBid({ status: 'rejected', recommended_bid: 180_000_000 })).toBe(false);
  });

  it('renders structured decision reasons in Korean', () => {
    expect(decisionReasonLabel('data_missing')).toBe('데이터 부족');
    expect(decisionReasonLabel('rights')).toBe('권리관계');
  });
});
