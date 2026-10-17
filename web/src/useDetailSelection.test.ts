import { describe, expect, it } from 'vitest';
import { syncDecisionToDetail, syncFavoriteToDetail } from './useDetailSelection.ts';
import type { DecisionEvent, ListingItem } from './api.ts';

describe('useDetailSelection ViewModel', () => {
  const item: ListingItem = {
    id: 100,
    case_no: '2024타경100',
    item_no: '1',
    is_favorite: false,
    current_decision: undefined,
  } as unknown as ListingItem;

  const event: DecisionEvent = {
    id: 1,
    listing_id: 100,
    case_no: '2024타경100',
    item_no: '1',
    decision: 'recommended',
    reason_code: 'clean_rights',
    reason_note: '권리 깨끗',
    target_bid: 150_000_000,
    created_at: '2026-06-22T00:00:00Z',
  };

  describe('syncFavoriteToDetail', () => {
    it('선택된 항목의 ID와 일치하면 is_favorite 상태를 갱신한다', () => {
      const updated = syncFavoriteToDetail(item, 100, true);
      expect(updated?.is_favorite).toBe(true);
    });

    it('ID가 일치하지 않으면 원래 상태를 유지한다', () => {
      const updated = syncFavoriteToDetail(item, 999, true);
      expect(updated?.is_favorite).toBe(false);
    });

    it('선택된 항목이 null이면 null을 반환한다', () => {
      expect(syncFavoriteToDetail(null, 100, true)).toBeNull();
    });
  });

  describe('syncDecisionToDetail', () => {
    it('선택된 항목의 ID와 일치하면 current_decision을 갱신한다', () => {
      const updated = syncDecisionToDetail(item, event);
      expect(updated?.current_decision).toEqual(event);
    });

    it('ID가 일치하지 않으면 원래 상태를 유지한다', () => {
      const otherEvent = { ...event, listing_id: 999 };
      const updated = syncDecisionToDetail(item, otherEvent);
      expect(updated?.current_decision).toBeUndefined();
    });

    it('선택된 항목이 null이면 null을 반환한다', () => {
      expect(syncDecisionToDetail(null, event)).toBeNull();
    });
  });
});
