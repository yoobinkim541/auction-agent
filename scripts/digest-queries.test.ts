import { describe, expect, it } from 'vitest';
import {
  clampDigestTopN,
  HISTORICAL_RESULTS_SQL,
  TOP_RECOMMENDATIONS_SQL,
  UPCOMING_RECOMMENDATIONS_SQL,
} from './digest-queries.ts';

describe('digest recommendation queries', () => {
  it('clamps the requested recommendation count to an integer from 3 through 7', () => {
    expect(clampDigestTopN(undefined)).toBe(5);
    expect(clampDigestTopN('2')).toBe(3);
    expect(clampDigestTopN('6')).toBe(6);
    expect(clampDigestTopN('9')).toBe(7);
    expect(clampDigestTopN('3.5')).toBe(5);
    expect(clampDigestTopN('invalid')).toBe(5);
  });

  it('uses only the precision shortlist for active and upcoming recommendations', () => {
    for (const sql of [TOP_RECOMMENDATIONS_SQL, UPCOMING_RECOMMENDATIONS_SQL]) {
      expect(sql).toContain('from gm_precision_shortlist');
      expect(sql).not.toContain('gm_scores');
    }
  });

  it('marks historical recommendations only from recommended precision evaluations', () => {
    expect(HISTORICAL_RESULTS_SQL).toContain('gm_precision_evaluations');
    expect(HISTORICAL_RESULTS_SQL).toContain("p.status = 'recommended'");
    expect(HISTORICAL_RESULTS_SQL).not.toContain('gm_scores');
  });
});
