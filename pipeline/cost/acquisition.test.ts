import { describe, it, expect } from 'vitest';
import {
  acquisitionTaxRate, estimateHousingBondCost, estimateMoveOutCost,
  marketFromSiteComps, expectedBid, classifyLandUseFlags, computeAcquisitionCost, bondRegionFromAddress,
  decideBidForCost,
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
  it('경기도 광주시 → 기타(중간 광주 오탐 방지 — ^ 앵커)', () => {
    expect(bondRegionFromAddress('경기도 광주시 오포읍')).toBe('기타');
    expect(bondRegionFromAddress('광주광역시 북구')).toBe('서울/광역시');
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
  it('실거래 comp 없으면 실증 낙찰가율 폴백 사용', () => {
    const e = expectedBid(200_000_000, undefined, undefined, 90_000_000, { ratioPct: 56, basis: '실증 낙찰가율 villa×경기' });
    expect(e.ratioPct).toBe(56);
    expect(e.price).toBe(112_000_000); // 2억×56%
    expect(e.basis).toContain('실증');
  });
  it('실증 폴백: 극단적 저최저가여도 최저가로 끌어내리지 않음(가짜마진 방지)', () => {
    // 감정 4억, 최저 0.14억(극단 유찰) → 실증 56%면 예상낙찰 2.24억 (down-cap으로 최저가 근처로 붕괴되면 안 됨)
    const e = expectedBid(400_000_000, undefined, undefined, 14_000_000, { ratioPct: 56, basis: '실증 villa' });
    expect(e.price).toBe(224_000_000);
    expect(e.basis).not.toContain('1.3배');
  });
  it('실증 폴백: 감정가×율 < 최저가면 최저가 하한(현 회차 최저 이상)', () => {
    // 1회차(최저=감정): 감정 2억, 최저 2억, 실증 56% → 1.12억 < 최저 → 최저 2억으로 하한
    const e = expectedBid(200_000_000, undefined, undefined, 200_000_000, { ratioPct: 56, basis: '실증 villa' });
    expect(e.price).toBe(200_000_000);
    expect(e.basis).toContain('최저가 하한');
  });
  it('실거래 comp가 실증보다 우선', () => {
    const e = expectedBid(200_000_000, [80], undefined, 90_000_000, { ratioPct: 56, basis: '실증' });
    expect(e.ratioPct).toBe(80); // comp 80 사용, 실증 56 무시
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

  it('신규 공법상 제한: 군사·도시계획시설·농지·보전산지·녹지·상수원·문화재', () => {
    const text = [
      '군사기지및군사시설보호구역(제한보호구역)', '비행안전구역',
      '도시계획시설 공원 저촉', '농업진흥구역', '보전산지(임업용산지)',
      '자연녹지지역', '상수원보호구역', '문화재보호구역',
    ].join(', ');
    const flags = classifyLandUseFlags(text);
    const find = (s: string) => flags.find((f) => f.label.includes(s));
    expect(find('군사시설보호구역')).toMatchObject({ kind: 'info', severity: 'low' }); // 제한보호구역/비행안전(통제 없음) → info/low
    expect(find('도시계획시설 저촉')).toMatchObject({ kind: 'risk', severity: 'medium' });
    expect(find('농업용도지역')).toMatchObject({ kind: 'risk', severity: 'medium' });
    expect(find('보전산지')).toMatchObject({ kind: 'risk', severity: 'high' });
    expect(find('녹지지역')).toMatchObject({ kind: 'risk', severity: 'medium' });
    expect(find('상수원보호구역')).toMatchObject({ kind: 'risk', severity: 'high' });
    expect(find('문화재보호구역')).toMatchObject({ kind: 'risk', severity: 'medium' });
  });

  it('군사 분할: 통제보호구역=risk/high, 제한·비행안전=info/low, 통제 동반 표기 시 info 억제', () => {
    expect(classifyLandUseFlags('통제보호구역').find((f) => f.label.includes('통제보호구역')))
      .toMatchObject({ kind: 'risk', severity: 'high' });
    expect(classifyLandUseFlags('제한보호구역').find((f) => f.label.includes('군사시설보호구역')))
      .toMatchObject({ kind: 'info', severity: 'low' });
    expect(classifyLandUseFlags('비행안전구역').find((f) => f.label.includes('군사시설보호구역')))
      .toMatchObject({ kind: 'info', severity: 'low' });
    // 표준 표기 '군사기지 및 군사시설 보호구역(통제보호구역)' → high만, info 중복 발화 억제
    const std = classifyLandUseFlags('군사기지 및 군사시설 보호구역(통제보호구역)');
    expect(std.find((f) => f.label.includes('통제보호구역'))?.severity).toBe('high');
    expect(std.find((f) => f.kind === 'info')).toBeUndefined();
  });

  it('보전관리지역/자연환경보전지역 → 보전산지 flag(high)', () => {
    expect(classifyLandUseFlags('보전관리지역').find((f) => f.label.includes('보전산지'))?.severity).toBe('high');
    expect(classifyLandUseFlags('자연환경보전지역').find((f) => f.label.includes('보전산지'))?.kind).toBe('risk');
  });

  it('정비구역 flag impact는 권리산정기준일·현금청산(입주권 불가) 경고 포함', () => {
    const f = classifyLandUseFlags('재개발 정비구역').find((x) => x.label.includes('정비구역'));
    expect(f?.impact).toContain('권리산정기준일');
    expect(f?.impact).toContain('현금청산');
    expect(f?.impact).toContain('입주권 불가');
  });

  it('저촉: 풀어쓴 "…에 저촉/저촉됨"·도로등급 잡고, 부정문·인접·-대로 조사는 제외', () => {
    const has = (t: string, label: string) => classifyLandUseFlags(t).some((f) => f.label.includes(label));
    expect(has('도시계획시설(도로)에 저촉됨', '도로 저촉')).toBe(true);
    expect(has('소로3류에 저촉', '도로 저촉')).toBe(true);
    expect(has('도시계획시설(공원)에 저촉됨', '도시계획시설 저촉')).toBe(true);
    expect(has('근린공원에 저촉되는 부분', '도시계획시설 저촉')).toBe(true);
    expect(has('도시계획시설 저촉', '도시계획시설 저촉')).toBe(true); // 시설명 없는 두 번째 대안 커버
    expect(has('도로에 저촉되지 않음', '도로 저촉')).toBe(false); // 부정문
    expect(has('도로 저촉 없음', '도로 저촉')).toBe(false);
    expect(has('남측 도로는 양호, 북측 공원에 저촉', '도로 저촉')).toBe(false); // 콤마 너머 타 시설
    expect(has('종전대로 저촉', '도로 저촉')).toBe(false); // '-대로' 조사 오탐 가드(lookbehind)
    expect(has('근린공원 인접', '도시계획시설 저촉')).toBe(false); // 저촉 없는 단순 인접
  });

  it('농지: 용도지역·괄호 지목·과수원 잡고, 평범한 서술의 전/답은 오탐 아님', () => {
    const isNongji = (t: string) => classifyLandUseFlags(t).some((f) => f.label.includes('농업용도지역'));
    ['농업진흥구역', '농업보호구역', '농업진흥지역', '농림지역', '절대농지', '과수원', '지목 (전), 자연녹지지역']
      .forEach((t) => expect(isNongji(t)).toBe(true));
    ['지목 전체적으로 정리됨', '전세권 설정, 전용면적 84㎡', '임차인 답변서 제출', '전용주거지역']
      .forEach((t) => expect(isNongji(t)).toBe(false));
  });

  it('상수원: 보호구역·수질보전특별대책·수변구역·N권역 잡고, 대기·권고문은 오탐 아님', () => {
    const isWater = (t: string) => classifyLandUseFlags(t).some((f) => f.label.includes('상수원보호구역'));
    ['상수원보호구역', '수질보전특별대책지역', '수질보전 특별대책지역', '특별대책지역 1권역', '한강수계 수변구역']
      .forEach((t) => expect(isWater(t)).toBe(true));
    ['대기보전특별대책지역', '특별대책지역(대기) 울산국가산업단지', '하천 수질보전에 유의 요망']
      .forEach((t) => expect(isWater(t)).toBe(false));
  });

  it('음성(오탐 회귀): 평범한 용도지역 텍스트엔 flag 0개', () => {
    ['제2종일반주거지역, 도시지역', '계획관리지역', '자연취락지구, 제3종일반주거지역', '준주거지역']
      .forEach((t) => expect(classifyLandUseFlags(t).length).toBe(0));
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

describe('decideBidForCost (가정 낙찰가 결정)', () => {
  it('예상낙찰가 ≥ 최저가 → 예상낙찰가 사용', () => {
    const r = decideBidForCost(214_830_000, '인근 낙찰가율 93%', 200_000_000, 250_000_000);
    expect(r.bidForCost).toBe(214_830_000);
    expect(r.bidBasis).toContain('예상낙찰가');
  });
  it('예상낙찰가 없고 최저가<시세 5% → 시세×80% 보수추정', () => {
    const r = decideBidForCost(null, '', 9_000_000, 300_000_000); // 9M < 15M(5%)
    expect(r.bidForCost).toBe(240_000_000); // 300M×0.8
    expect(r.bidBasis).toContain('시세×80%');
  });
  it('그 외 → 현 회차 최저매각가', () => {
    expect(decideBidForCost(null, '', 180_000_000, 250_000_000)).toEqual({ bidForCost: 180_000_000, bidBasis: '현 회차 최저매각가' });
    // 예상낙찰가가 최저가보다 낮으면(과거 저율) 최저가 사용
    expect(decideBidForCost(150_000_000, 'x', 180_000_000, 250_000_000).bidForCost).toBe(180_000_000);
  });
});
