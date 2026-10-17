import { describe, expect, it } from 'vitest';
import { applyDecisionToItems } from './usePrecisionInbox.ts';
import type { DecisionEvent, ListingItem } from './api.ts';

describe('usePrecisionInbox ViewModel', () => {
  const makeItem = (id: number): ListingItem =>
    ({
      id,
      case_no: `2024타경${id}`,
      item_no: '1',
      current_decision: undefined,
    } as unknown as ListingItem);

  const makeDecision = (id: number, decision: 'recommended' | 'hold' | 'rejected'): DecisionEvent => ({
    id: 999,
    listing_id: id,
    case_no: `2024타경${id}`,
    item_no: '1',
    decision,
    reason_code: 'price_high',
    reason_note: '가격 부담',
    target_bid: 200_000_000,
    created_at: '2026-06-22T00:00:00Z',
  });

  describe('applyDecisionToItems', () => {
    it('일치하는 listing_id를 가진 항목의 current_decision을 갱신한다', () => {
      const items = [makeItem(1), makeItem(2), makeItem(3)];
      const event = makeDecision(2, 'hold');

      const updated = applyDecisionToItems(items, event);

      expect(updated[0]!.current_decision).toBeUndefined();
      expect(updated[1]!.current_decision).toEqual(event);
      expect(updated[2]!.current_decision).toBeUndefined();
    });

    it('일치하는 항목이 없으면 배열을 그대로 유지한다', () => {
      const items = [makeItem(1), makeItem(2)];
      const event = makeDecision(99, 'recommended');

      const updated = applyDecisionToItems(items, event);

      expect(updated[0]!.current_decision).toBeUndefined();
      expect(updated[1]!.current_decision).toBeUndefined();
    });
  });
});
