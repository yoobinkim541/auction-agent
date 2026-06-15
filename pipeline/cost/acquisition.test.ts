import { describe, it, expect } from 'vitest';
import {
  acquisitionTaxRate, estimateHousingBondCost, estimateMoveOutCost,
  marketFromSiteComps, expectedBid, classifyLandUseFlags, computeAcquisitionCost, bondRegionFromAddress,
} from './acquisition.ts';

describe('취득세', () => {
  it('1주택 6억이하 85㎡이하 = 1.1% (더낙찰옥션 기본 케이스)', () => {
    const r = acquisitionTaxRate('apartment', 200_000_000, 13.88, { homeCountAfter: 1 });
    expect(r.totalRatePct).toBe(1.1);
    expect(r.totalKRW).toBe(2_200_000);
  });
  it('1주택 85㎡초과 6억이하 = 1.3%', () => {
    expect(acquisitionTaxRate('apartment', 500_000_000, 100, { homeCountAfter: 1 }).totalRatePct).toBe(1.3);
  });
  it('6~9억 누진: 7.5억 85㎡이하 = 2.2%', () => {
    expect(acquisitionTaxRate('apartment', 750_000_000, 84, { homeCountAfter: 1 }).totalRatePct).toBe(2.2);
  });
  it('9억초과 85㎡초과 = 3.5%', () => {
    expect(acquisitionTaxRate('apartment', 1_200_000_000, 100, { homeCountAfter: 1 }).totalRatePct).toBe(3.5);
  });
  it('조정 2주택 85㎡이하 = 8.4% 중과', () => {
    expect(acquisitionTaxRate('apartment', 200_000_000, 50, { homeCountAfter: 2, isRegulatedArea: true }).totalRatePct).toBe(8.4);
  });
  it('오피스텔/상가/토지 = 4.6%', () => {
    expect(acquisitionTaxRate('officetel', 200_000_000, 30).totalRatePct).toBe(4.6);
    expect(acquisitionTaxRate('commercial', 200_000_000, 30).totalRatePct).toBe(4.6);
    expect(acquisitionTaxRate('land', 100_000_000, 0).totalRatePct).toBe(4.6);
  });
});

describe('국민주택채권', () => {
  it('서울 공시 1.3억 → 매입 273만, 본인부담 ~38만(14%)', () => {
    const b = estimateHousingBondCost(130_000_000, '서울/광역시');
    expect(b.faceAmount).toBe(2_730_000);
    expect(b.ownCost).toBe(382_200);
  });
  it('2천만 미만 면제', () => {
    expect(estimateHousingBondCost(15_000_000, '서울/광역시').faceAmount).toBe(0);
  });
  it('지역구분: 경기=기타, 인천=광역시', () => {
    expect(bondRegionFromAddress('경기도 성남시')).toBe('기타');
    expect(bondRegionFromAddress('인천광역시 부평구')).toBe('서울/광역시');
  });
});

describe('명도비', () => {
  it('4.2평 → 접수10+운반110+노무자3×12 = 156만(폴백)', () => {
    expect(estimateMoveOutCost(4.2)).toBe(1_560_000);
  });
});

describe('시세/예상낙찰가', () => {
  it('동일건물 실거래 중앙값(4.2평 매칭)', () => {
    const comps = [
      { name: 'A', areaM2: 13.88, dealYm: '2026-01', dealManwon: 21000 },
      { name: 'A', areaM2: 14.139, dealYm: '2026-02', dealManwon: 22450 },
      { name: 'A', areaM2: 26.537, dealYm: '2026-04', dealManwon: 37500 },
    ];
    const m = marketFromSiteComps(comps, 13.88);
    expect(m.price).toBe(217_250_000); // (21000+22450)/2 만원
    expect(m.n).toBe(2);
  });
  it('예상낙찰가 = 감정가 × 동일건물 낙찰가율', () => {
    const e = expectedBid(231_000_000, [93], [104, 95, 113]);
    expect(e.ratioPct).toBe(93);
    expect(e.price).toBe(214_830_000);
  });
});

describe('토지규제 flags', () => {
  it('토허구역=기회(경매 배제), 과밀억제=위험, 가축사육=info', () => {
    const text = '일반상업지역, 지구단위계획구역, 가축사육제한구역, 교육환경보호구역, 과밀억제권역, 토지거래계약에관한허가구역(2025-10-20)';
    const flags = classifyLandUseFlags(text);
    const byLabel = Object.fromEntries(flags.map((f) => [f.label.split('(')[0], f]));
    expect(flags.find((f) => f.label.includes('토지거래허가'))?.kind).toBe('opportunity');
    expect(flags.find((f) => f.label.includes('과밀억제'))?.kind).toBe('risk');
    expect(flags.find((f) => f.label.includes('가축사육'))?.kind).toBe('info');
    expect(Object.keys(byLabel).length).toBeGreaterThanOrEqual(5);
  });
});

describe('총취득비용', () => {
  it('1113138: 낙찰 2.31억·인수 2.25억·시세 2.17억 → 진짜안전마진 음수', () => {
    const r = computeAcquisitionCost({
      propertyType: 'apartment', address: '서울특별시 동대문구 장안동', areaM2: 13.88,
      bidPrice: 231_000_000, bidBasis: '최저가', gongPrice: 130_000_000,
      moveOutCost: 1_800_000, assumedAmount: 225_000_000, marketPrice: 217_250_000,
      taxOptions: { homeCountAfter: 1 },
    });
    expect(r.acqTax).toBe(2_541_000); // 231M×1.1%
    expect(r.totalCost).toBeGreaterThan(231_000_000 + 225_000_000); // 인수금액 포함
    expect(r.trueSafetyMargin).toBeLessThan(0); // 인수 큰 물건 → 음수
  });
});
