import { describe, expect, it } from 'vitest';
import {
  nextSortDirection,
  SORT_DEFAULT_DIR,
} from './useListingFilters.ts';

describe('useListingFilters ViewModel', () => {
  describe('nextSortDirection', () => {
    it('같은 정렬 키를 연속 클릭하면 정렬 방향을 반전한다', () => {
      expect(nextSortDirection('score', 'score', 'desc')).toBe('asc');
      expect(nextSortDirection('score', 'score', 'asc')).toBe('desc');
      expect(nextSortDirection('price', 'price', 'asc')).toBe('desc');
    });

    it('다른 정렬 키를 클릭하면 해당 키의 기본 방향(SORT_DEFAULT_DIR)을 따른다', () => {
      expect(nextSortDirection('score', 'price', 'desc')).toBe('asc');
      expect(nextSortDirection('price', 'score', 'asc')).toBe('desc');
      expect(nextSortDirection('score', 'safety', 'asc')).toBe('desc');
      expect(nextSortDirection('score', 'gap', 'desc')).toBe('asc');
      expect(nextSortDirection('score', 'fieldwork', 'asc')).toBe('desc');
    });
  });

  describe('SORT_DEFAULT_DIR', () => {
    it('주요 지표별 합리적인 기본 정렬 방향을 갖는다', () => {
      expect(SORT_DEFAULT_DIR.score).toBe('desc');
      expect(SORT_DEFAULT_DIR.safety).toBe('desc');
      expect(SORT_DEFAULT_DIR.price).toBe('asc'); // 싼 가격 우선
      expect(SORT_DEFAULT_DIR.gap).toBe('asc'); // 갭 작은 것 우선
      expect(SORT_DEFAULT_DIR.competition).toBe('desc'); // 저경쟁 우선
    });
  });
});
