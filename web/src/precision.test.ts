import { describe, expect, it } from 'vitest';
import {
  applyIfCurrent, canShowBid, createDecisionDraft, createRequestGate, decisionReasonLabel,
  precisionView, shouldShowLegacyBid,
} from './precision.ts';

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

  it('shows legacy bid values only when there is no precision evaluation', () => {
    expect(shouldShowLegacyBid(null)).toBe(true);
    expect(shouldShowLegacyBid({ status: 'recommended' })).toBe(false);
    expect(shouldShowLegacyBid({ status: 'hold' })).toBe(false);
    expect(shouldShowLegacyBid({ status: 'rejected' })).toBe(false);
  });

  it('resets the A draft before navigating to B', () => {
    const draftForA = createDecisionDraft();
    draftForA.decision = 'rejected';
    draftForA.reasonCode = 'price';
    draftForA.note = 'A 메모';
    draftForA.targetBid = '240000000';

    expect(createDecisionDraft()).toEqual({ decision: 'reviewing', reasonCode: '', note: '', targetBid: '' });
  });

  it('rejects stale success and error responses after a newer precision request', () => {
    const gate = createRequestGate();
    const initialRequest = gate.begin();
    const newerRequest = gate.begin();
    const applied: string[] = [];

    expect(applyIfCurrent(gate, initialRequest, () => applied.push('stale-success'))).toBe(false);
    expect(applyIfCurrent(gate, initialRequest, () => applied.push('stale-error'))).toBe(false);
    expect(applied).toEqual([]);
    expect(applyIfCurrent(gate, newerRequest, () => applied.push('newer-success'))).toBe(true);
    expect(applied).toEqual(['newer-success']);
    expect(gate.isCurrent(newerRequest)).toBe(true);
  });

  it('rejects stale history and save responses after navigating from A to B', () => {
    const gate = createRequestGate();
    const listingARequest = gate.begin();
    const listingBRequest = gate.begin();
    const history: string[] = [];

    expect(applyIfCurrent(gate, listingARequest, () => history.push('A save'))).toBe(false);
    expect(applyIfCurrent(gate, listingARequest, () => history.push('A history'))).toBe(false);
    expect(history).toEqual([]);
    expect(applyIfCurrent(gate, listingBRequest, () => history.push('B history'))).toBe(true);
    expect(history).toEqual(['B history']);
    expect(gate.isCurrent(listingBRequest)).toBe(true);
  });
});
