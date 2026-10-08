import { describe, expect, it } from 'vitest';
import {
  PRECISION_BACKFILL_SQL,
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
