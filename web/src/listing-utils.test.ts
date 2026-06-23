import { describe, it, expect } from 'vitest';
import { resolveRound, marginColor } from './listing-utils.ts';
import type { ListingItem } from './api.ts';

const rounds = [{ date: '2026-06-16', round: 1 }, { date: '2026-07-21', round: 2 }];

describe('resolveRound', () => {
  it('sale_date 일치 차수 → 확정(est=false)', () => {
    expect(resolveRound(rounds, '2026-07-21')).toEqual({ n: 2, est: false });
  });
  it('빈 rounds → null', () => {
    expect(resolveRound([], '2026-07-21')).toBeNull();
  });
  it('sale_date가 최신차수보다 미래(구형 데이터) + 유찰수 → 유찰수+1 추정', () => {
    expect(resolveRound(rounds, '2026-09-01', 3)).toEqual({ n: 4, est: true });
  });
  it('sale_date 미래 + 유찰수 없음 → 최신 round+1 추정', () => {
    expect(resolveRound(rounds, '2026-09-01', null)).toEqual({ n: 3, est: true });
  });
  it('sale_date가 과거/일치없음(최신 이하) → 최신 차수 확정', () => {
    expect(resolveRound(rounds, '2026-05-01')).toEqual({ n: 2, est: false });
  });
  it('sale_date 없음 → 최신 차수', () => {
    expect(resolveRound(rounds)).toEqual({ n: 2, est: false });
  });
});

describe('marginColor', () => {
  const mk = (tm: number | null, raw: number | null = null): ListingItem =>
    ({ location: { acquisition_cost: tm == null ? null : { trueSafetyMargin: tm }, safety_margin: raw } } as unknown as ListingItem);
  it('진짜마진 구간별 색', () => {
    expect(marginColor(mk(0.3))).toBe('#1ec758');
    expect(marginColor(mk(0.15))).toBe('#a3d977');
    expect(marginColor(mk(0.05))).toBe('#f5a623');
    expect(marginColor(mk(-0.1))).toBe('#f04545');
  });
  it('진짜마진 없으면 raw 안전마진 폴백, 둘 다 없으면 회색', () => {
    expect(marginColor(mk(null, 0.3))).toBe('#1ec758');
    expect(marginColor(mk(null, null))).toBe('#7a8699');
  });
});
