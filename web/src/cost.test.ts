import { describe, it, expect } from 'vitest';
import { acquisitionTaxRate as webTax } from './cost.ts';
import { acquisitionTaxRate as serverTax } from '../../pipeline/cost/acquisition.ts';
import type { PropertyType } from '../../shared/types.ts';

// web/src/cost.ts(계산기 위젯)는 서버 pipeline/cost/acquisition.ts 의 미러.
// 공통 케이스에서 세율·세액이 어긋나면(드리프트) 위젯과 분석 결과가 불일치 → 회귀로 잡는다.
type Opts = { homeCountAfter?: number; isRegulatedArea?: boolean; officetelAsHouse?: boolean };
const cases: { pt: PropertyType; price: number; area: number; opts: Opts }[] = [
  { pt: 'apartment', price: 200_000_000, area: 13.88, opts: { homeCountAfter: 1 } },   // 1.1%
  { pt: 'apartment', price: 500_000_000, area: 100, opts: { homeCountAfter: 1 } },     // 1.3% over85
  { pt: 'apartment', price: 750_000_000, area: 84, opts: { homeCountAfter: 1 } },      // 2.2% 누진
  { pt: 'apartment', price: 1_200_000_000, area: 100, opts: { homeCountAfter: 1 } },   // 3.5%
  { pt: 'apartment', price: 200_000_000, area: 50, opts: { homeCountAfter: 2, isRegulatedArea: true } }, // 8.4%
  { pt: 'apartment', price: 200_000_000, area: 50, opts: { homeCountAfter: 4 } },      // 12.4% 비조정4주택
  { pt: 'villa', price: 300_000_000, area: 60, opts: { homeCountAfter: 3 } },          // 8.4% 비조정3주택
  { pt: 'officetel', price: 200_000_000, area: 30, opts: {} },                          // 4.6%
  { pt: 'commercial', price: 200_000_000, area: 30, opts: {} },                         // 4.6%
];

describe('web cost.ts ↔ 서버 acquisition.ts 취득세 미러 동기화', () => {
  for (const c of cases) {
    it(`${c.pt} ${c.price / 1e8}억/${c.area}㎡ ${JSON.stringify(c.opts)} 세율·세액 일치`, () => {
      const w = webTax(c.pt, c.price, c.area, c.opts);
      const s = serverTax(c.pt, c.price, c.area, c.opts);
      expect(w.totalRatePct).toBe(s.totalRatePct);
      expect(w.totalKRW).toBe(s.totalKRW);
    });
  }

  it('알려진 분기: 서버는 법인 중과(12%) 지원, web 미러는 미지원(의도된 차이 — 계산기는 개인 가정)', () => {
    const s = serverTax('apartment', 500_000_000, 84, { isCorporation: true });
    expect(s.totalRatePct).toBeGreaterThanOrEqual(12);
    expect(webTax('apartment', 500_000_000, 84, {}).totalRatePct).toBeLessThan(s.totalRatePct);
  });
});
