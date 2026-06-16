import { describe, it, expect } from 'vitest';
import { scoreListing, maxSafeBid, DEFAULT_SCORE_CONFIG } from './score.ts';
import type { RightsAnalysisResult, LocationAnalysis } from '../../shared/types.ts';

const 억 = 100_000_000;

function rights(over: Partial<RightsAnalysisResult> = {}): RightsAnalysisResult {
  return {
    caseNo: 'x', malsoBasis: { entry: null, date: null, note: '' }, classified: [], tenants: [],
    distribution: [], assumedAmount: 0, assumedBreakdown: [], maxSafeBid: null, redFlags: [],
    riskGrade: 'clean', isClean: true, warnings: [], engineVersion: '0.1.0', ...over,
  };
}
function loc(margin: number | null): LocationAnalysis {
  return { caseNo: 'x', marketPrice: margin === null ? null : 10 * 억, comps: [], safetyMargin: margin };
}

describe('scoreListing', () => {
  it('깨끗 + 높은 안전마진 → 통과 & 고득점', () => {
    const s = scoreListing('x', rights(), loc(0.4), 'apartment', '서울특별시 강남구');
    expect(s.passedFilter).toBe(true);
    expect(s.totalScore).toBe(100);
  });

  it('인수금액 있으면 탈락(requireCleanRights)', () => {
    const s = scoreListing('x', rights({ assumedAmount: 2 * 억, riskGrade: 'risky', isClean: false }), loc(0.3), 'apartment', '서울');
    expect(s.passedFilter).toBe(false);
    expect(s.reason).toContain('인수금액');
  });

  it('관심 지역 외 → 탈락', () => {
    const s = scoreListing('x', rights(), loc(0.3), 'apartment', '부산광역시 해운대구');
    expect(s.passedFilter).toBe(false);
  });

  it('안전마진 부족 → 탈락', () => {
    const s = scoreListing('x', rights(), loc(0.05), 'apartment', '서울');
    expect(s.passedFilter).toBe(false);
  });

  it('review_required → 탈락', () => {
    const s = scoreListing('x', rights({ riskGrade: 'review_required', isClean: false }), loc(0.3), 'apartment', '서울');
    expect(s.passedFilter).toBe(false);
  });

  it('허용 안 된 물건종류(토지) → 탈락', () => {
    const s = scoreListing('x', rights(), loc(0.3), 'land', '서울');
    expect(s.passedFilter).toBe(false);
  });

  it('시세 미확보(null safetyMargin) → 탈락', () => {
    const s = scoreListing('x', rights(), loc(null), 'apartment', '서울');
    expect(s.passedFilter).toBe(false);
    expect(s.reason).toContain('시세 미확보');
  });
});

describe('maxSafeBid', () => {
  it('시세 10억, 인수 0, 여유 10% → 9억', () => {
    expect(maxSafeBid(10 * 억, 0, 0.1)).toBe(9 * 억);
  });
  it('인수금액 차감', () => {
    expect(maxSafeBid(10 * 억, 2 * 억, 0.1)).toBe(7 * 억);
  });
  it('시세 없으면 null', () => {
    expect(maxSafeBid(null, 0)).toBeNull();
  });
});

it('기본 설정 sanity', () => {
  expect(DEFAULT_SCORE_CONFIG.allowedTypes).toContain('apartment');
});
