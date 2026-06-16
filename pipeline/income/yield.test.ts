import { describe, it, expect } from 'vitest';
import { saleScenarios, analyzeIncome } from './yield.ts';
import type { RentEstimate } from './rent.ts';

describe('양도세 시나리오', () => {
  const base = { salePrice: 300_000_000, bidPrice: 200_000_000, acqTax: 2_200_000, bondCost: 400_000, totalAcqCost: 210_000_000 };
  it('보유 2년: 누진세율 + 장특공 0%(3년 미만)', () => {
    const s = saleScenarios({ ...base, holdYearsList: [2] })[0]!;
    expect(s.ltdRate).toBe(0);
    expect(s.yangdoTax).toBeGreaterThan(0);
    // 차익 ≈ 3억-2억-필요경비 ≈ 9650만 → 과표 ≈ 9400만 → 24%구간
    expect(s.yangdoTax).toBeLessThan(s.netCashProfit + base.totalAcqCost); // sanity
  });
  it('보유 5년: 장특공 10%', () => {
    expect(saleScenarios({ ...base, holdYearsList: [5] })[0]!.ltdRate).toBeCloseTo(0.10);
  });
  it('보유 15년: 장특공 30% 상한', () => {
    expect(saleScenarios({ ...base, holdYearsList: [15] })[0]!.ltdRate).toBe(0.30);
  });
  it('차익 0 이하: 양도세 0', () => {
    const s = saleScenarios({ salePrice: 200_000_000, bidPrice: 230_000_000, acqTax: 2_500_000, bondCost: 0, totalAcqCost: 240_000_000, holdYearsList: [2] })[0]!;
    expect(s.yangdoTax).toBe(0);
  });
});

describe('임대수익률', () => {
  it('전세가율·갭·표면수익률 계산', () => {
    const rent: RentEstimate = { jeonseDeposit: 200_000_000, monthlyDeposit: 30_000_000, monthlyRent: 800_000, n: 10, nJeonse: 6, nMonthly: 4, basis: 'test' };
    const r = analyzeIncome({ marketPrice: 280_000_000, totalAcqCost: 240_000_000, bidPrice: 210_000_000, acqTax: 2_310_000, bondCost: 400_000, rent });
    expect(r.jeonseRatioPct).toBeCloseTo(71.4, 0); // 2억/2.8억
    expect(r.gapInvestment).toBe(40_000_000); // 2.4억-2억
    expect(r.grossYieldPct).toBeCloseTo(4.0, 0); // 960만/2.4억
    expect(r.saleScenarios.length).toBe(3);
  });
});
