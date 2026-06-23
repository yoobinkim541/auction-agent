import { describe, it, expect } from 'vitest';
import { median, recentYearMonths } from './stats.ts';

describe('median', () => {
  it('빈 배열 → null', () => expect(median([])).toBeNull());
  it('단일 값', () => expect(median([5])).toBe(5));
  it('홀수 개수 → 가운데', () => expect(median([1, 3, 2])).toBe(2));
  it('짝수 개수 → 두 중앙값 평균(반올림)', () => expect(median([1, 2, 3, 4])).toBe(3)); // (2+3)/2=2.5 → round=3? 아니, 반올림 → 3
  it('짝수 평균 정수', () => expect(median([2, 4])).toBe(3)); // (2+4)/2=3
});

describe('recentYearMonths', () => {
  it('1개월 → 현재월 1개', () => {
    const result = recentYearMonths(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/^\d{6}$/); // YYYYMM 형식
  });

  it('12개월 → 12개, 최신이 먼저', () => {
    const result = recentYearMonths(12);
    expect(result).toHaveLength(12);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i]! > result[i + 1]!).toBe(true); // 내림차순
    }
  });

  it('결과는 YYYYMM 형식(유효한 월)', () => {
    for (const ym of recentYearMonths(24)) {
      const month = parseInt(ym.slice(4, 6), 10);
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
    }
  });

  it('0개월 → 빈 배열', () => expect(recentYearMonths(0)).toHaveLength(0));
});
