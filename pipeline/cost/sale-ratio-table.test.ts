import { describe, it, expect } from 'vitest';
import { buildSaleRatioTable, regionFromAddress, MIN_N, TYPE_RATIO_PRIOR, type SaleRatioSample } from './sale-ratio-table.ts';

describe('regionFromAddress', () => {
  it('앞자리 앵커로 수도권 3분, 경기 광주 오분류 없음', () => {
    expect(regionFromAddress('서울특별시 강남구 …')).toBe('서울');
    expect(regionFromAddress('인천광역시 부평구 …')).toBe('인천');
    expect(regionFromAddress('경기도 광주시 …')).toBe('경기'); // '광주' 부분문자열이 서울/광역시로 오분류되면 안 됨
    expect(regionFromAddress('강원도 원주시 …')).toBe('기타');
  });
});

describe('buildSaleRatioTable 계층적 조회', () => {
  const mk = (propertyType: string, region: string, ratioPct: number, n: number): SaleRatioSample[] =>
    Array.from({ length: n }, () => ({ propertyType, region, ratioPct }));

  it('종류×지역 표본 충분(≥MIN_N)이면 그 중앙값 사용', () => {
    const t = buildSaleRatioTable([...mk('villa', '인천', 58, MIN_N)]);
    const r = t.lookup('villa', '인천광역시 …');
    expect(r.tier).toBe('type_region');
    expect(r.ratioPct).toBe(58);
    expect(r.n).toBe(MIN_N);
  });

  it('종류×지역 부족하지만 종류(지역통합) 충분이면 종류 중앙값', () => {
    // 서울 5건(부족) + 경기 MIN_N건 → 서울 조회는 type 계층으로 폴백
    const t = buildSaleRatioTable([...mk('villa', '서울', 72, 5), ...mk('villa', '경기', 54, MIN_N)]);
    const r = t.lookup('villa', '서울특별시 …');
    expect(r.tier).toBe('type');
    // 전체 25건의 중앙값(경기 54 다수) → 54
    expect(r.ratioPct).toBe(54);
  });

  it('종류 표본도 부족하면 보수적 프라이어(과대추천 방지: 높게)', () => {
    const t = buildSaleRatioTable([...mk('apartment', '서울', 64, 7)]);
    const r = t.lookup('apartment', '서울특별시 …');
    expect(r.tier).toBe('prior');
    expect(r.ratioPct).toBe(TYPE_RATIO_PRIOR.apartment); // 실측 64가 아니라 프라이어 88 — 얇은 표본 과신 방지
    expect(r.ratioPct).toBeGreaterThan(64);
  });

  it('미등록 종류는 기본 프라이어', () => {
    const t = buildSaleRatioTable([]);
    const r = t.lookup('commercial', '서울특별시 …');
    expect(r.tier).toBe('prior');
    expect(r.ratioPct).toBe(80);
  });

  it('ratio 0/음수·빈 종류 표본은 무시', () => {
    const t = buildSaleRatioTable([
      ...mk('villa', '경기', 54, MIN_N),
      { propertyType: 'villa', region: '경기', ratioPct: 0 },
      { propertyType: '', region: '경기', ratioPct: 99 },
    ]);
    const r = t.lookup('villa', '경기도 …');
    expect(r.n).toBe(MIN_N); // 0짜리 제외
    expect(r.ratioPct).toBe(54);
  });
});
