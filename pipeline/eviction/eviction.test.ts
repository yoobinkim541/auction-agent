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

  it('공실 → WRIT/easy(명도 불요)', () => {
    const e = analyzeEviction(base({}), 30, ['공실']);
    expect(inferOccupantType(base({}), ['공실'])).toBe('VACANT');
    expect(e.remedy).toBe('WRIT'); expect(e.difficulty).toBe('easy');
  });

  it('대항력+인수0 → WRIT_THEN_LAWSUIT/medium(배당 전액회수)', () => {
    const r = base({ tenants: [{ hasOpposition: true } as any], assumedAmount: 0 });
    expect(inferOccupantType(r, [])).toBe('TENANT_OPP_PAID');
    const e = analyzeEviction(r, 45, []);
    expect(e.remedy).toBe('WRIT_THEN_LAWSUIT'); expect(e.difficulty).toBe('medium');
  });

  it('임차인 없음+문자 힌트 없음 → UNKNOWN/medium', () => {
    expect(inferOccupantType(base({}), [])).toBe('UNKNOWN');
    const e = analyzeEviction(base({}), 45, []);
    expect(e.difficulty).toBe('medium');
  });
});
