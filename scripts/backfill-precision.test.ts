import { describe, expect, it } from 'vitest';
import {
  PRECISION_BACKFILL_SQL,
  mapPrecisionBackfillInput,
  readPrecisionBackfillOptions,
} from './backfill-precision.ts';

describe('readPrecisionBackfillOptions', () => {
  it('accepts explicit limit and since-days bounds', () => {
    expect(readPrecisionBackfillOptions(['--limit=125', '--since-days=2'], {})).toEqual({
      limit: 125,
      sinceDays: 2,
    });
  });

  it.each(['0', '-2', '2.5', 'later'])('rejects invalid --since-days=%s', (value) => {
    expect(() => readPrecisionBackfillOptions([`--since-days=${value}`], {}))
      .toThrow('유효한 --since-days');
  });
});

describe('precision backfill bounded selection', () => {
  it('bounds rows by listing, analysis, and trust update timestamps before limit', () => {
    expect(PRECISION_BACKFILL_SQL).toContain('l.crawled_at');
    expect(PRECISION_BACKFILL_SQL).toContain('r.analyzed_at');
    expect(PRECISION_BACKFILL_SQL).toContain('loc.analyzed_at');
    expect(PRECISION_BACKFILL_SQL).toContain('t.evaluated_at');
    expect(PRECISION_BACKFILL_SQL).toContain("make_interval(days => $2::int)");
  });

  it('selects only missing or source-stale precision rows in since-days mode', () => {
    expect(PRECISION_BACKFILL_SQL).toContain('left join gm_precision_evaluations current_precision');
    expect(PRECISION_BACKFILL_SQL).toContain('current_precision.evaluated_at is null');
    expect(PRECISION_BACKFILL_SQL).toContain('current_precision.evaluated_at < greatest(');
    expect(PRECISION_BACKFILL_SQL).toContain('$2::int is null\n      or (');
  });
});

describe('precision backfill report gate', () => {
  const baseRow = {
    id: 1, case_no: '2026타경1', item_no: '1', court: 'court', address: '경기도 광주시',
    property_type: 'villa' as const, appraisal_value: 220_000_000, min_bid_price: 53_000_000,
    fail_count: 3, source: 'courtauction' as const, crawled_at: '2026-10-01T00:00:00Z',
    trust_status: 'trusted', classified: [], tenants: [], assumed_amount: 0, max_safe_bid: 90_000_000,
    red_flags: [], risk_grade: 'clean', warnings: [], market_price: 171_000_000,
    market_confidence: 'medium', comps: [], expected_bid_price: 92_000_000,
    acquisition_cost: null, site_comps: [], eviction: null,
  };

  it('재평가 입력에 종합 보고서 권고를 싣는다 — 누락 시 백필이 avoid 매물을 recommended로 되돌린다', () => {
    expect(PRECISION_BACKFILL_SQL).toContain("loc.report->>'recommendation'");
    expect(mapPrecisionBackfillInput({ ...baseRow, report_recommendation: 'avoid' }).reportRecommendation).toBe('avoid');
    expect(mapPrecisionBackfillInput({ ...baseRow, report_recommendation: 'consider' }).reportRecommendation).toBe('consider');
  });

  it('알 수 없거나 없는 권고값은 null로 정규화한다', () => {
    expect(mapPrecisionBackfillInput({ ...baseRow, report_recommendation: null }).reportRecommendation).toBeNull();
    expect(mapPrecisionBackfillInput({ ...baseRow, report_recommendation: 'weird' }).reportRecommendation).toBeNull();
  });
});
