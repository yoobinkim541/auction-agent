import { describe, it, expect } from 'vitest';
import { estimateRent, estimateRentFromSalePrice, type RentDeal } from './rent.ts';

const deal = (deposit: number, monthlyRent: number, areaM2: number): RentDeal =>
  ({ deposit, monthlyRent, areaM2, dealDate: '2026-01' });

describe('estimateRent', () => {
  it('빈 거래 → 전부 null', () => {
    expect(estimateRent([], 84)).toMatchObject({
      jeonseDeposit: null, monthlyDeposit: null, monthlyRent: null, n: 0, basis: '',
    });
  });

  it('전세/월세 분리 + 중앙값(면적 미지정 → 전체 사용)', () => {
    const deals = [
      deal(300_000_000, 0, 84), deal(320_000_000, 0, 84), deal(340_000_000, 0, 84), // 전세 3
      deal(100_000_000, 500_000, 84), deal(120_000_000, 700_000, 84),               // 월세 2
    ];
    const r = estimateRent(deals, undefined);
    expect(r.jeonseDeposit).toBe(320_000_000);  // median([3.0,3.2,3.4억])
    expect(r.monthlyDeposit).toBe(110_000_000); // round(median([1.0,1.2억]))
    expect(r.monthlyRent).toBe(600_000);        // round(median([50,70만]))
    expect(r).toMatchObject({ n: 5, nJeonse: 3, nMonthly: 2 });
    expect(r.basis).toBe('MOLIT 전월세 5건');
  });

  it('±15% 면적 필터(근접 3건 이상 → 근접만, 원거리 제외)', () => {
    const deals = [
      deal(300_000_000, 0, 80), deal(310_000_000, 0, 84), deal(320_000_000, 0, 90), // 84±15% 내
      deal(900_000_000, 0, 130), deal(100_000_000, 0, 50),                          // 밖 → 제외
    ];
    const r = estimateRent(deals, 84);
    expect(r.n).toBe(3);
    expect(r.jeonseDeposit).toBe(310_000_000); // 원거리 900/100M 섞이면 안 됨
    expect(r.basis).toContain('전용 84㎡±15%');
  });

  it('근접 3건 미만 → 전체 표본 폴백(±15% 미표기)', () => {
    const deals = [
      deal(300_000_000, 0, 84), deal(310_000_000, 0, 84),                            // 근접 2건(<3)
      deal(500_000_000, 0, 130), deal(520_000_000, 0, 135), deal(540_000_000, 0, 140), // 원거리 3건
    ];
    const r = estimateRent(deals, 84);
    expect(r.n).toBe(5);
    expect(r.basis).toBe('MOLIT 전월세 5건');
    expect(r.basis).not.toContain('±15%');
  });

  it('전세만 있으면 월세 시세는 null', () => {
    const r = estimateRent([deal(300_000_000, 0, 84), deal(320_000_000, 0, 84), deal(310_000_000, 0, 84)], undefined);
    expect(r.jeonseDeposit).toBe(310_000_000);
    expect(r.monthlyDeposit).toBeNull();
    expect(r.monthlyRent).toBeNull();
  });
});

describe('estimateRentFromSalePrice', () => {
  it('유형별 전세가율 역산(apartment 60% / officetel 75% / villa 68% / 기타 65%)', () => {
    expect(estimateRentFromSalePrice('apartment', 500_000_000)).toMatchObject({ jeonseDeposit: 300_000_000, estimated: true });
    expect(estimateRentFromSalePrice('officetel', 400_000_000).jeonseDeposit).toBe(300_000_000);
    expect(estimateRentFromSalePrice('villa', 100_000_000).jeonseDeposit).toBe(68_000_000);
    expect(estimateRentFromSalePrice('house', 100_000_000).jeonseDeposit).toBe(65_000_000); // 미지정 유형 → 0.65
  });

  it('월세는 추정 안 함, basis에 전세가율 명시', () => {
    const r = estimateRentFromSalePrice('apartment', 500_000_000);
    expect(r.monthlyRent).toBeNull();
    expect(r.monthlyDeposit).toBeNull();
    expect(r.basis).toContain('60%');
  });

  it('시세 없음/0 → 빈 추정', () => {
    expect(estimateRentFromSalePrice('apartment', null)).toMatchObject({ jeonseDeposit: null, n: 0 });
    expect(estimateRentFromSalePrice('apartment', 0).jeonseDeposit).toBeNull();
  });
});
