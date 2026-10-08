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
    expect(roundBandFromMinBid(40_000_000, 100_000_000)).toBe('r4');  // 40%
  });
  it('정보 없으면 보수적으로 신건(r1)', () => {
    expect(roundBandFromMinBid(null, 100_000_000)).toBe('r1');
    expect(roundBandFromMinBid(50_000_000, 0)).toBe('r1');
  });
});

describe('buildSaleRatioTable 계층적 조회', () => {
  const mk = (propertyType: string, region: string, band: RoundBand, ratioPct: number, n: number): SaleRatioSample[] =>
    Array.from({ length: n }, () => ({ propertyType, region, band, ratioPct }));

  it('종류×지역×밴드 표본 충분(≥MIN_N)이면 그 중앙값', () => {
    const t = buildSaleRatioTable(mk('villa', '인천', 'r3', 58, MIN_N));
    const r = t.lookup('villa', '인천광역시 …', 'r3');
    expect(r.tier).toBe('type_region_band');
    expect(r.ratioPct).toBe(58);
  });

  it('밴드는 지역보다 우선 — 종류×지역×밴드 부족하면 종류×밴드(지역통합)로', () => {
    // 서울 신건 5건(부족) + 경기 신건 MIN_N건 → 서울 신건 조회는 type_band로 폴백(회차 유지)
    const t = buildSaleRatioTable([...mk('villa', '서울', 'r1', 85, 5), ...mk('villa', '경기', 'r1', 82, MIN_N)]);
    const r = t.lookup('villa', '서울특별시 …', 'r1');
    expect(r.tier).toBe('type_band');
    expect(r.ratioPct).toBe(82); // 25건 중앙값(경기 82 다수)
  });

  it('회차밴드가 다르면 다른 값 — 같은 종류·지역이라도 신건과 3회유찰 구분', () => {
    const t = buildSaleRatioTable([
      ...mk('villa', '경기', 'r1', 84, MIN_N),
      ...mk('villa', '경기', 'r4', 40, MIN_N),
    ]);
    expect(t.lookup('villa', '경기도 …', 'r1').ratioPct).toBe(84);
    expect(t.lookup('villa', '경기도 …', 'r4').ratioPct).toBe(40);
  });

  it('종류×밴드도 부족하면 종류×지역(회차통합)으로', () => {
    // r2 표본은 어디에도 MIN_N 없음, villa|경기(회차통합)는 충분
    const t = buildSaleRatioTable([
      ...mk('villa', '경기', 'r1', 84, 12),
      ...mk('villa', '경기', 'r3', 58, 12),
      ...mk('villa', '서울', 'r1', 80, 5),
    ]);
    const r = t.lookup('villa', '경기도 …', 'r2');
    expect(r.tier).toBe('type_region');
    expect(r.n).toBe(24); // 경기 전체(r1 12 + r3 12)
  });

  it('종류 표본도 부족하면 보수적 프라이어(과대추천 방지: 높게)', () => {
    const t = buildSaleRatioTable(mk('apartment', '서울', 'r2', 64, 7));
    const r = t.lookup('apartment', '서울특별시 …', 'r2');
    expect(r.tier).toBe('prior');
    expect(r.ratioPct).toBe(TYPE_RATIO_PRIOR.apartment);
    expect(r.ratioPct).toBeGreaterThan(64);
  });

  it('미등록 종류는 기본 프라이어', () => {
    const t = buildSaleRatioTable([]);
    const r = t.lookup('commercial', '서울특별시 …', 'r1');
    expect(r.tier).toBe('prior');
    expect(r.ratioPct).toBe(80);
  });

  it('ratio 0/음수·빈 종류 표본은 무시', () => {
    const t = buildSaleRatioTable([
      ...mk('villa', '경기', 'r3', 54, MIN_N),
      { propertyType: 'villa', region: '경기', band: 'r3', ratioPct: 0 },
      { propertyType: '', region: '경기', band: 'r3', ratioPct: 99 },
    ]);
    const r = t.lookup('villa', '경기도 …', 'r3');
    expect(r.n).toBe(MIN_N);
    expect(r.ratioPct).toBe(54);
  });
});
