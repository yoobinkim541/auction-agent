import { describe, it, expect } from 'vitest';
import { decideRecommendation } from './build.ts';

type Input = Parameters<typeof decideRecommendation>[0];
const base: Input = { dataComplete: true, assumedAmount: 0, dangerCount: 0, warnCount: 0, riskGrade: 'clean', trueMargin: 0.3 };
const rec = (o: Partial<Input>) => decideRecommendation({ ...base, ...o });

describe('decideRecommendation', () => {
  it('데이터 불완전 → caution(다른 조건 무관)', () => {
    expect(rec({ dataComplete: false, assumedAmount: 999, dangerCount: 9 })).toBe('caution');
  });

  it('avoid: 인수금액>0 / danger / review_required / 음수마진', () => {
    expect(rec({ assumedAmount: 1 })).toBe('avoid');
    expect(rec({ dangerCount: 1 })).toBe('avoid');
    expect(rec({ riskGrade: 'review_required' })).toBe('avoid');
    expect(rec({ trueMargin: -0.01 })).toBe('avoid');
  });

  it('caution: warn / 저마진(<10%) / risky·caution 등급', () => {
    expect(rec({ warnCount: 1 })).toBe('caution');
    expect(rec({ trueMargin: 0.05 })).toBe('caution');
    expect(rec({ riskGrade: 'risky' })).toBe('caution');
    expect(rec({ riskGrade: 'caution' })).toBe('caution');
  });

  it('consider: 깨끗 + 여유마진', () => {
    expect(rec({})).toBe('consider');
    expect(rec({ trueMargin: null })).toBe('consider'); // null은 저마진 아님
    expect(rec({ trueMargin: 0.1 })).toBe('consider');  // 경계: <0.1 아님
  });

  it('우선순위: avoid가 caution보다 먼저(인수 있으면 warn 있어도 avoid)', () => {
    expect(rec({ assumedAmount: 1, warnCount: 5 })).toBe('avoid');
  });
});
