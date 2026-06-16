import { describe, it, expect } from 'vitest';
import { inferOccupantType, analyzeEviction } from './index.ts';
import type { RightsAnalysisResult } from '../../shared/types.ts';
const base = (over: Partial<RightsAnalysisResult>): RightsAnalysisResult => ({
  caseNo: 'x', malsoBasis: { entry: null, date: null, note: '' }, classified: [], tenants: [], distribution: [],
  assumedAmount: 0, assumedBreakdown: [], maxSafeBid: null, redFlags: [], riskGrade: 'clean', isClean: true, warnings: [], engineVersion: '0', ...over,
} as RightsAnalysisResult);

describe('명도 엔진', () => {
  it('대항력 임차인+인수 → 명도소송/hard', () => {
    const r = base({ tenants: [{ hasOpposition: true } as any], assumedAmount: 200_000_000 });
    const e = analyzeEviction(r, 45, []);
    expect(e.remedy).toBe('LAWSUIT'); expect(e.difficulty).toBe('hard'); expect(e.writEligible).toBe(false);
  });
  it('무대항력 임차인 → 인도명령/easy', () => {
    const r = base({ tenants: [{ hasOpposition: false } as any] });
    const e = analyzeEviction(r, 45, []);
    expect(e.remedy).toBe('WRIT'); expect(inferOccupantType(r, [])).toBe('TENANT_NO_OPP');
  });
  it('유치권 → 명도소송/hard, 기간 김', () => {
    const r = base({ redFlags: [{ kind: 'yuchigwon', severity: 'danger', message: '유치권' } as any] });
    const e = analyzeEviction(r, 45, []);
    expect(e.difficulty).toBe('hard'); expect(e.monthsHigh).toBeGreaterThanOrEqual(12);
  });
  it('소유자 점유 → 인도명령/easy', () => {
    expect(inferOccupantType(base({}), ['소유자 점유'])).toBe('OWNER_DEBTOR');
  });
  it('비용 레인지 low<base<high', () => {
    const e = analyzeEviction(base({}), 60, ['소유자 점유']);
    expect(e.costLow).toBeLessThan(e.costBase); expect(e.costBase).toBeLessThan(e.costHigh);
  });
});
