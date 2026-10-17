import { describe, expect, it } from 'vitest';
import {
  buildMissingPhotosQuery,
  readBackfillCliOptions,
  roundRobinByCourt,
  type BackfillOptions,
} from './backfill-listing-photos.ts';

describe('backfill-listing-photos options and queries', () => {
  describe('readBackfillCliOptions', () => {
    it('기본 옵션을 올바르게 파싱한다', () => {
      const opts = readBackfillCliOptions([], {});
      expect(opts.limit).toBe(100);
      expect(opts.priority).toBe('all');
      expect(opts.delayMs).toBe(400);
      expect(opts.court).toBeUndefined();
    });

    it('CLI 인자로 limit, priority, court, delay를 설정한다', () => {
      const args = ['--limit=50', '--priority=recommended', '--court=서울중앙', '--delay=300'];
      const opts = readBackfillCliOptions(args, {});
      expect(opts.limit).toBe(50);
      expect(opts.priority).toBe('recommended');
      expect(opts.court).toBe('서울중앙');
      expect(opts.delayMs).toBe(300);
    });

    it('환경변수 PHOTO_BACKFILL_LIMIT를 우선순위 낮게 반영한다', () => {
      const opts = readBackfillCliOptions([], { PHOTO_BACKFILL_LIMIT: '150' });
      expect(opts.limit).toBe(150);
    });

    it('잘못된 limit 값은 안전한 기본값(100)으로 보정한다', () => {
      expect(readBackfillCliOptions(['--limit=0'], {}).limit).toBe(100);
      expect(readBackfillCliOptions(['--limit=-5'], {}).limit).toBe(100);
      expect(readBackfillCliOptions(['--limit=abc'], {}).limit).toBe(100);
    });
  });

  describe('buildMissingPhotosQuery', () => {
    it('활성 매물 중 활성 사진이 없는 물건만 조회하는 SQL을 생성한다', () => {
      const opts: BackfillOptions = { limit: 50, priority: 'all', delayMs: 400 };
      const { sql, params } = buildMissingPhotosQuery(opts);

      expect(sql).toContain('not exists');
      expect(sql).toContain('from gm_listing_photos');
      expect(sql).toContain('l.sale_date >= current_date');
      expect(sql).toContain('status = \'active\'');
      expect(params).toContain(50);
    });

    it('court 필터가 있으면 법원 검색 조건을 추가한다', () => {
      const opts: BackfillOptions = { limit: 30, priority: 'all', court: '서울동부', delayMs: 400 };
      const { sql, params } = buildMissingPhotosQuery(opts);

      expect(sql).toContain('l.court like');
      expect(params).toContain('%서울동부%');
    });

    it('recommended 우선순위 시 정밀 추천 매물을 먼저 정렬한다', () => {
      const opts: BackfillOptions = { limit: 50, priority: 'recommended', delayMs: 400 };
      const { sql } = buildMissingPhotosQuery(opts);

      expect(sql).toContain('gm_precision_evaluations');
      expect(sql).toContain('order by');
    });
  });

  describe('roundRobinByCourt', () => {
    it('법원별로 1건씩 라운드로빈 방식으로 고르게 섞는다', () => {
      const items = [
        { id: 1, court: '서울중앙지방법원' },
        { id: 2, court: '서울중앙지방법원' },
        { id: 3, court: '인천지방법원' },
        { id: 4, court: '수원지방법원' },
        { id: 5, court: '인천지방법원' },
      ];

      const interleaved = roundRobinByCourt(items);

      // 첫 3건은 서로 다른 법원이어야 함 (중앙, 인천, 수원)
      const firstThreeCourts = new Set(interleaved.slice(0, 3).map((x) => x.court));
      expect(firstThreeCourts.size).toBe(3);
      expect(interleaved).toHaveLength(5);
    });

    it('빈 배열은 빈 배열을 반환한다', () => {
      expect(roundRobinByCourt([])).toEqual([]);
    });
  });
});
