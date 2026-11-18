import { describe, it, expect } from 'vitest';
import {
  buildSaleRatioTable, regionFromAddress, roundBandFromMinBid, MIN_N, TYPE_RATIO_PRIOR,
  type SaleRatioSample, type RoundBand,
} from './sale-ratio-table.ts';

describe('regionFromAddress', () => {
  it('앞자리 앵커로 수도권 3분, 경기 광주 오분류 없음', () => {
    expect(regionFromAddress('서울특별시 강남구 …')).toBe('서울');
    expect(regionFromAddress('인천광역시 부평구 …')).toBe('인천');
    expect(regionFromAddress('경기도 광주시 …')).toBe('경기');
    expect(regionFromAddress('강원도 원주시 …')).toBe('기타');
  });
});

describe('roundBandFromMinBid', () => {
  it('최저가/감정가 비율로 회차밴드 근사', () => {
    expect(roundBandFromMinBid(100_000_000, 100_000_000)).toBe('r1'); // 100%
    expect(roundBandFromMinBid(80_000_000, 100_000_000)).toBe('r2');  // 80%
    expect(roundBandFromMinBid(64_000_000, 100_000_000)).toBe('r3');  // 64%
    expect(roundBandFromMinBid(49_000_000, 100_000_000)).toBe('r4');  // 49%
    expect(roundBandFromMinBid(34_300_000, 100_000_000)).toBe('r5');  // 34.3%
    expect(roundBandFromMinBid(24_000_000, 100_000_000)).toBe('r6');  // 24%
  });
  it('정보 없으면 보수적으로 신건(r1)', () => {
    expect(roundBandFromMinBid(null, 100_000_000)).toBe('r1');
    expect(roundBandFromMinBid(50_000_000, 0)).toBe('r1');
  });
});

describe('buildSaleRatioTable 계층적 조회', () => {
  const mk = (propertyType: string, region: string, band: RoundBand, overMin: number, n: number): SaleRatioSample[] =>
    Array.from({ length: n }, () => ({ propertyType, region, band, overMin }));
  const APPRAISAL = 100_000_000;

  it('종류×지역×밴드 표본 충분(≥MIN_N)이면 최저가에 그 배율 중앙값을 얹는다', () => {
    const t = buildSaleRatioTable(mk('villa', '인천', 'r3', 1.1, MIN_N));
    const r = t.lookup('villa', '인천광역시 …', 64_000_000, APPRAISAL);
    expect(r.tier).toBe('type_region_band');
    expect(r.ratioPct).toBeCloseTo(70.4, 6);
  });

  it('같은 밴드 안에서도 최저가가 낮으면 예상 낙찰가율이 따라 내려간다', () => {
    const t = buildSaleRatioTable(mk('villa', '인천', 'r3', 1.1, MIN_N));
    expect(t.lookup('villa', '인천광역시 …', 70_000_000, APPRAISAL).ratioPct).toBeCloseTo(77, 6);
    expect(t.lookup('villa', '인천광역시 …', 56_000_000, APPRAISAL).ratioPct).toBeCloseTo(61.6, 6);
  });

  it('밴드는 지역보다 우선 — 종류×지역×밴드 부족하면 종류×밴드(지역통합)로', () => {
    // 서울 신건 5건(부족) + 경기 신건 MIN_N건 → 서울 신건 조회는 type_band로 폴백(회차 유지)
    const t = buildSaleRatioTable([...mk('villa', '서울', 'r1', 1.2, 5), ...mk('villa', '경기', 'r1', 1.05, MIN_N)]);
    const r = t.lookup('villa', '서울특별시 …', APPRAISAL, APPRAISAL);
    expect(r.tier).toBe('type_band');
    expect(r.ratioPct).toBeCloseTo(105, 6); // 25건 중앙값(경기 1.05 다수)
  });

  it('회차밴드가 다르면 다른 배율 — 같은 종류·지역이라도 신건과 3회유찰 구분', () => {
    const t = buildSaleRatioTable([
      ...mk('villa', '경기', 'r1', 1.05, MIN_N),
      ...mk('villa', '경기', 'r4', 1.2, MIN_N),
    ]);
    expect(t.lookup('villa', '경기도 …', APPRAISAL, APPRAISAL).ratioPct).toBeCloseTo(105, 6);
    expect(t.lookup('villa', '경기도 …', 49_000_000, APPRAISAL).ratioPct).toBeCloseTo(58.8, 6);
  });

  it('종류×밴드도 부족하면 같은 밴드의 다른 종류까지 합친다', () => {
    const t = buildSaleRatioTable([...mk('land', '경기', 'r2', 1.3, 5), ...mk('villa', '서울', 'r2', 1.1, MIN_N)]);
    const r = t.lookup('land', '경기도 …', 80_000_000, APPRAISAL);
    expect(r.tier).toBe('band');
    expect(r.n).toBe(MIN_N + 5);
    expect(r.ratioPct).toBeCloseTo(88, 6);
  });

  it('밴드 표본도 부족하면 보수적 프라이어(과대추천 방지: 높게)', () => {
    const t = buildSaleRatioTable(mk('apartment', '서울', 'r2', 1.05, 7));
    const r = t.lookup('apartment', '서울특별시 …', 80_000_000, APPRAISAL);
    expect(r.tier).toBe('prior');
    expect(r.ratioPct).toBe(TYPE_RATIO_PRIOR.apartment);
    expect(r.ratioPct).toBeGreaterThan(80 * 1.05);
  });

  it('최저가를 모르면 배율을 얹을 곳이 없으므로 프라이어', () => {
    const t = buildSaleRatioTable(mk('commercial', '서울', 'r1', 1.05, MIN_N));
    const r = t.lookup('commercial', '서울특별시 …', null, APPRAISAL);
    expect(r.tier).toBe('prior');
    expect(r.ratioPct).toBe(80);
  });

  it('시세 구간 표본이 충분하면 신뢰도 high 시세가 있는 물건은 그 구간의 배율을 먼저 쓴다', () => {
    const anchored = (marketOverMin: number, overMin: number): SaleRatioSample[] =>
      mk('apartment', '서울', 'r2', overMin, MIN_N).map((sample) => ({ ...sample, marketOverMin }));
    const t = buildSaleRatioTable([...anchored(1.05, 1.02), ...anchored(1.6, 1.3)]);
    // 최저가 8천만원: 시세 8,400만원(÷최저가 1.05) → ×1.02, 시세 1억2,800만원(÷최저가 1.6) → ×1.3
    const near = t.lookup('apartment', '서울특별시 …', 80_000_000, APPRAISAL, 84_000_000);
    const far = t.lookup('apartment', '서울특별시 …', 80_000_000, APPRAISAL, 128_000_000);
    expect(near.tier).toBe('type_band_market');
    expect(near.ratioPct).toBeCloseTo(81.6, 6);
    expect(far.ratioPct).toBeCloseTo(104, 6);
    expect(far.basis).toContain('시세÷최저가 1.50~1.80');
    // 시세를 넘기지 않으면(신뢰도 high 아님) 회차밴드 배율 — 두 구간을 합친 중앙값
    expect(t.lookup('apartment', '서울특별시 …', 80_000_000, APPRAISAL).tier).toBe('type_region_band');
  });

  it('회차×시세 구간 표본이 부족하면 회차를 합친 시세 구간으로, 시세 구간 표본이 없는 종류는 회차밴드 배율로', () => {
    const t = buildSaleRatioTable([
      ...mk('apartment', '서울', 'r2', 1.2, 12).map((sample) => ({ ...sample, marketOverMin: 1.4 })),
      ...mk('apartment', '서울', 'r3', 1.2, 12).map((sample) => ({ ...sample, marketOverMin: 1.4 })),
      ...mk('villa', '서울', 'r2', 1.1, MIN_N),
    ]);
    const pooled = t.lookup('apartment', '서울특별시 …', 80_000_000, APPRAISAL, 112_000_000);
    expect(pooled.tier).toBe('type_market');
    expect(pooled.n).toBe(24);
    expect(t.lookup('villa', '서울특별시 …', 80_000_000, APPRAISAL, 112_000_000).tier).toBe('type_region_band');
  });

  it('최저가 미만 낙찰·빈 종류 표본은 무시', () => {
    const t = buildSaleRatioTable([
      ...mk('villa', '경기', 'r3', 1.1, MIN_N),
      { propertyType: 'villa', region: '경기', band: 'r3', overMin: 0.4 },
      { propertyType: '', region: '경기', band: 'r3', overMin: 3 },
    ]);
    const r = t.lookup('villa', '경기도 …', 64_000_000, APPRAISAL);
    expect(r.n).toBe(MIN_N);
    expect(r.ratioPct).toBeCloseTo(70.4, 6);
  });
});
