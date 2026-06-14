import { describe, it, expect } from 'vitest';
import { classifyRegionTier, evaluateSohaek, pickSohaekVersion } from './sohaek-table.ts';

const 만 = 10_000;

describe('classifyRegionTier (chart3 과밀억제권역 기준)', () => {
  it('서울', () => expect(classifyRegionTier('서울특별시 강남구').tier).toBe('seoul'));
  it('인천 → 과밀', () => expect(classifyRegionTier('인천광역시 연수구').tier).toBe('overcrowded'));
  it('수원 → 과밀', () => expect(classifyRegionTier('경기도 수원시 영통구').tier).toBe('overcrowded'));
  it('부산 → 광역시', () => expect(classifyRegionTier('부산광역시 해운대구').tier).toBe('metro'));
  it('청주 → 기타', () => expect(classifyRegionTier('충청북도 청주시').tier).toBe('other'));
});

describe('pickSohaekVersion (담보물권 설정일 기준)', () => {
  it('2024년 설정 → 2023 개정판', () => expect(pickSohaekVersion('2024-01-01').effectiveFrom).toBe('2023-02-21'));
  it('2015년 설정 → 2014 개정판', () => expect(pickSohaekVersion('2015-06-01').effectiveFrom).toBe('2014-01-01'));
});

describe('evaluateSohaek (chart15 연혁 교차확인)', () => {
  it('서울 2024 보증금 1.6억 → 소액, 최우선 5,500만', () => {
    const r = evaluateSohaek(16000 * 만, '서울특별시 송파구', '2024-01-01');
    expect(r.isSmallTenant).toBe(true);
    expect(r.maxPriority).toBe(5500 * 만);
  });
  it('서울 2024 보증금 2억 → 소액 아님', () => {
    expect(evaluateSohaek(2_0000 * 만, '서울특별시', '2024-01-01').isSmallTenant).toBe(false);
  });
  it('과밀(수원) 2024 보증금 1.4억 → 소액, 최우선 4,800만', () => {
    const r = evaluateSohaek(14000 * 만, '경기도 수원시', '2024-01-01');
    expect(r.isSmallTenant).toBe(true);
    expect(r.maxPriority).toBe(4800 * 만);
  });
});
