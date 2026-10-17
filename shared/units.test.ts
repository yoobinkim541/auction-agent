import { describe, expect, it } from 'vitest';
import { m2ToPyeong, pyeongToM2, SQM_PER_PYEONG } from './units.ts';

describe('shared/units', () => {
  it('상수 SQM_PER_PYEONG 정의가 3.305785다', () => {
    expect(SQM_PER_PYEONG).toBe(3.305785);
  });

  it('㎡ → 평 변환이 정확하다', () => {
    expect(m2ToPyeong(0)).toBe(0);
    expect(m2ToPyeong(SQM_PER_PYEONG)).toBeCloseTo(1, 6);
    expect(m2ToPyeong(84.95)).toBeCloseTo(25.697, 2);
    expect(m2ToPyeong(59.94)).toBeCloseTo(18.132, 2);
  });

  it('평 → ㎡ 변환이 정확하다', () => {
    expect(pyeongToM2(0)).toBe(0);
    expect(pyeongToM2(1)).toBe(SQM_PER_PYEONG);
    expect(pyeongToM2(25)).toBeCloseTo(82.6446, 2);
    expect(pyeongToM2(34)).toBeCloseTo(112.3967, 2);
  });

  it('m2ToPyeong과 pyeongToM2가 역함수 관계를 만족한다', () => {
    const area = 84.95;
    expect(pyeongToM2(m2ToPyeong(area))).toBeCloseTo(area, 6);
    const pyeong = 33;
    expect(m2ToPyeong(pyeongToM2(pyeong))).toBeCloseTo(pyeong, 6);
  });
});
