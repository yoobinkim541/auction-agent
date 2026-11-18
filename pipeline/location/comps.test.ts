import { describe, it, expect } from 'vitest';
import type { Comparable } from '../../shared/types.ts';
import { parseMolitDealAmount, dongMatches, extractDong, estimateMarketPrice, capMarketPrice } from './comps.ts';

describe('parseMolitDealAmount', () => {
  it('정상 만원→원', () => expect(parseMolitDealAmount('120,000')).toBe(1_200_000_000));
  it('공백 포함', () => expect(parseMolitDealAmount(' 85,000 ')).toBe(850_000_000));
  it('정정 마커 거부', () => expect(parseMolitDealAmount('1,200(정정)')).toBeNull());
  it('음수 부호 거부', () => expect(parseMolitDealAmount('-1,200')).toBeNull());
  it('빈값 거부', () => expect(parseMolitDealAmount('')).toBeNull());
  it('비정상 과소(<1천만) 거부', () => expect(parseMolitDealAmount('500')).toBeNull()); // 500만원=5백만 → 범위 밖
});

describe('dongMatches (부분문자열 오염 방지)', () => {
  it('정확 일치', () => expect(dongMatches('천호동', '천호동')).toBe(true));
  it('"산동"이 "마산동"에 매칭되지 않음', () => expect(dongMatches('산동', '마산동')).toBe(false));
  it('빈값', () => expect(dongMatches(undefined, '천호동')).toBe(false));
});

const mk = (over: Partial<Comparable>): Comparable => ({
  areaM2: 84, dealAmount: 1_000_000_000, dealDate: '2025-01-01', dong: '천호동', apartmentName: '롯데캐슬', ...over,
});

describe('estimateMarketPrice', () => {
  it('면적 미상이면 동일건물 매칭이라도 high 가 아니라 medium', () => {
    const comps = [mk({ areaM2: 25, dealAmount: 300_000_000 }), mk({ areaM2: 84, dealAmount: 900_000_000 })];
    const est = estimateMarketPrice(comps, { dong: '천호동', buildingName: '롯데캐슬' }); // areaM2 없음
    expect(est.confidence).toBe('medium');
  });
  it('면적 있으면 동일건물·면적 매칭은 high', () => {
    const comps = [mk({ areaM2: 84, dealAmount: 900_000_000 }), mk({ areaM2: 85, dealAmount: 910_000_000 })];
    const est = estimateMarketPrice(comps, { areaM2: 84, dong: '천호동', buildingName: '롯데캐슬' });
    expect(est.confidence).toBe('high');
  });
  it('타동네(부분문자열) 비교군은 섞이지 않음', () => {
    const comps = [mk({ dong: '마산동', dealAmount: 2_000_000_000 }), mk({ dong: '마산동', dealAmount: 2_000_000_000 }), mk({ dong: '마산동', dealAmount: 2_000_000_000 })];
    const est = estimateMarketPrice(comps, { areaM2: 84, dong: '산동' });
    // '산동' 정확일치 비교군 없음 → 면적만으로 구 전체(low) 폴백
    expect(est.confidence).toBe('low');
  });
  it('같은 건물은 지번으로 고른다 — 같은 동의 이름만 같은 다른 빌라는 섞이지 않는다', () => {
    const comps = [
      mk({ apartmentName: '현대빌라', jibun: '12-3', areaM2: 50, dealAmount: 200_000_000 }),
      mk({ apartmentName: '현대빌라', jibun: '12-3', areaM2: 50, dealAmount: 210_000_000 }),
      mk({ apartmentName: '현대빌라', jibun: '98-1', areaM2: 50, dealAmount: 400_000_000 }),
      mk({ apartmentName: '현대빌라', jibun: '98-1', areaM2: 50, dealAmount: 410_000_000 }),
    ];
    const est = estimateMarketPrice(comps, { areaM2: 50, dong: '천호동', buildingName: '현대빌라', jibun: '12-3' });
    expect(est.marketPrice).toBe(205_000_000);
    expect(est.confidence).toBe('high');
  });
  it('실거래에 지번이 없으면 건물명 앞부분으로 맞춘다', () => {
    const comps = [mk({ apartmentName: '센트라움', areaM2: 30, dealAmount: 150_000_000 }), mk({ apartmentName: '센트라움', areaM2: 30, dealAmount: 160_000_000 })];
    const est = estimateMarketPrice(comps, { areaM2: 30, dong: '천호동', buildingName: '센트라움주건축물', jibun: '5-1' });
    expect(est.marketPrice).toBe(155_000_000);
  });
  it("대표지번이 '146-18외 1필지' 꼴이면 앞의 지번으로 맞춘다", () => {
    const comps = [mk({ jibun: '146-18', dealAmount: 300_000_000 }), mk({ jibun: '146-18', dealAmount: 320_000_000 }), mk({ jibun: '9' }), mk({ jibun: '9' }), mk({ jibun: '9' })];
    expect(estimateMarketPrice(comps, { areaM2: 84, dong: '천호동', jibun: '146-18외 1필지' })).toMatchObject({ marketPrice: 310_000_000, confidence: 'high' });
  });
  it('오피스텔은 그 지번에 거래가 없으면 이름이 똑같은 거래를 쓰되 medium 까지', () => {
    const comps = [
      mk({ apartmentName: '강남 파라곤', jibun: '241-1', areaM2: 30, dealAmount: 300_000_000 }),
      mk({ apartmentName: '강남 파라곤', jibun: '241-1', areaM2: 30, dealAmount: 320_000_000 }),
      mk({ apartmentName: '강남파라곤2차', jibun: '300', areaM2: 30, dealAmount: 900_000_000 }),
    ];
    const opts = { areaM2: 30, dong: '천호동', buildingName: '강남파라곤', jibun: '241' };
    expect(estimateMarketPrice(comps, { ...opts, propertyType: 'officetel' })).toMatchObject({ marketPrice: 310_000_000, confidence: 'medium' });
    // 빌라는 이름이 같아도 다른 건물인 경우가 많아 쓰지 않는다
    expect(estimateMarketPrice(comps, { ...opts, propertyType: 'villa' }).confidence).toBe('low');
  });
  it('같은 건물에 같은 면적 거래가 없으면 ㎡당가로 환산하고 medium', () => {
    const comps = [mk({ jibun: '7', areaM2: 100, dealAmount: 1_000_000_000 }), mk({ jibun: '7', areaM2: 120, dealAmount: 1_200_000_000 })];
    const est = estimateMarketPrice(comps, { areaM2: 60, dong: '천호동', jibun: '7' });
    expect(est.marketPrice).toBe(600_000_000);
    expect(est.confidence).toBe('medium');
  });
  it('같은 건물·같은 면적 거래가 1건뿐이면 그 값을 쓰되 medium', () => {
    const comps = [mk({ jibun: '7', dealAmount: 900_000_000 }), mk({ jibun: '8' }), mk({ jibun: '8' }), mk({ jibun: '8' })];
    const est = estimateMarketPrice(comps, { areaM2: 84, dong: '천호동', jibun: '7' });
    expect(est).toMatchObject({ marketPrice: 900_000_000, confidence: 'medium' });
  });
  it('같은 건물은 최근 5건만 본다', () => {
    const old = Array.from({ length: 6 }, (_, i) => mk({ jibun: '7', dealAmount: 500_000_000, dealDate: `2025-0${i + 1}-01` }));
    const fresh = Array.from({ length: 5 }, (_, i) => mk({ jibun: '7', dealAmount: 800_000_000, dealDate: `2025-1${i % 3}-0${i + 1}` }));
    expect(estimateMarketPrice([...old, ...fresh], { areaM2: 84, dong: '천호동', jibun: '7' }).marketPrice).toBe(800_000_000);
  });
  it('같은 건물에서는 직거래를 중개거래가 없을 때만 쓴다', () => {
    const brokered = mk({ jibun: '7', dealAmount: 900_000_000 });
    const direct = [mk({ jibun: '7', dealAmount: 500_000_000, direct: true }), mk({ jibun: '7', dealAmount: 520_000_000, direct: true })];
    expect(estimateMarketPrice([brokered, ...direct], { areaM2: 84, dong: '천호동', jibun: '7' }).marketPrice).toBe(900_000_000);
    expect(estimateMarketPrice(direct, { areaM2: 84, dong: '천호동', jibun: '7' }).marketPrice).toBe(510_000_000);
  });
  it('동 단위 비교군은 중개거래가 3건이 안 되면 직거래까지 넣어 3건을 채운다', () => {
    const comps = [
      mk({ jibun: '1', buildYear: 2020, dealAmount: 600_000_000 }),
      mk({ jibun: '2', buildYear: 2020, dealAmount: 500_000_000, direct: true }),
      mk({ jibun: '3', buildYear: 2020, dealAmount: 400_000_000, direct: true }),
    ];
    const est = estimateMarketPrice(comps, { areaM2: 84, dong: '천호동', jibun: '9', buildYear: 2018 });
    expect(est.used).toHaveLength(3);
    expect(est.marketPrice).toBe(500_000_000);
  });
  it('동·면적·준공±5년 비교군은 medium, 준공연도를 못 맞춘 동·면적 비교군은 low', () => {
    const aged = [1, 2, 3].map(() => mk({ jibun: '1', buildYear: 1995, dealAmount: 300_000_000 }));
    const recentBuild = [1, 2, 3].map(() => mk({ jibun: '2', buildYear: 2020, dealAmount: 600_000_000 }));
    const est = estimateMarketPrice([...aged, ...recentBuild], { areaM2: 84, dong: '천호동', jibun: '9', buildYear: 2018, propertyType: 'villa' });
    expect(est).toMatchObject({ marketPrice: 600_000_000, confidence: 'medium' });
    expect(estimateMarketPrice([...aged, ...recentBuild], { areaM2: 84, dong: '천호동', jibun: '9' }))
      .toMatchObject({ marketPrice: 450_000_000, confidence: 'low' });
  });
  it('아파트·상가는 준공연도를 맞춘 동 단위 비교군도 low — 단지·층에 따라 값이 갈린다', () => {
    const comps = [1, 2, 3].map(() => mk({ jibun: '2', buildYear: 2020, dealAmount: 600_000_000 }));
    const opts = { areaM2: 84, dong: '천호동', jibun: '9', buildYear: 2018 };
    expect(estimateMarketPrice(comps, { ...opts, propertyType: 'apartment' }).confidence).toBe('low');
    expect(estimateMarketPrice(comps, { ...opts, propertyType: 'commercial' }).confidence).toBe('low');
    expect(estimateMarketPrice(comps, { ...opts, propertyType: 'officetel' }).confidence).toBe('medium');
  });
  it('면적이 다른 동 전체 비교군은 ㎡당가로 환산하고 low', () => {
    const comps = [1, 2, 3].map(() => mk({ jibun: '1', areaM2: 40, dealAmount: 400_000_000 }));
    expect(estimateMarketPrice(comps, { areaM2: 84, dong: '천호동', jibun: '9' })).toMatchObject({ marketPrice: 840_000_000, confidence: 'low' });
  });
});

describe('capMarketPrice (시세 sanity 상한)', () => {
  it('빌라: 저신뢰 시세가 감정가 초과 → 감정가로 상한 + low', () => {
    const r = capMarketPrice(390_000_000, 'medium', 200_000_000, 'villa'); // 시세 195% of 감정
    expect(r.capped).toBe(true);
    expect(r.marketPrice).toBe(200_000_000);
    expect(r.confidence).toBe('low');
    expect(r.overPct).toBe(195);
  });
  it('빌라: 시세 ≤ 감정가면 그대로', () => {
    const r = capMarketPrice(180_000_000, 'medium', 200_000_000, 'villa');
    expect(r.capped).toBe(false);
    expect(r.marketPrice).toBe(180_000_000);
  });
  it('아파트: 감정가×1.3까지 허용(실제 상승 여지)', () => {
    expect(capMarketPrice(250_000_000, 'medium', 200_000_000, 'apartment').capped).toBe(false); // 125% 허용
    expect(capMarketPrice(280_000_000, 'medium', 200_000_000, 'apartment').marketPrice).toBe(260_000_000); // 140%→130% 상한
  });
  it('high 신뢰(동일건물·면적)는 상한 예외 — 진짜 상승 반영', () => {
    const r = capMarketPrice(400_000_000, 'high', 200_000_000, 'villa');
    expect(r.capped).toBe(false);
    expect(r.marketPrice).toBe(400_000_000);
  });
  it('오피스텔·상가·단독은 high 라도 상한', () => {
    expect(capMarketPrice(600_000_000, 'high', 60_000_000, 'commercial')).toMatchObject({ marketPrice: 78_000_000, confidence: 'low', capped: true });
    expect(capMarketPrice(250_000_000, 'high', 200_000_000, 'officetel').capped).toBe(false); // 125% 허용
    expect(capMarketPrice(250_000_000, 'high', 200_000_000, 'house').marketPrice).toBe(200_000_000);
  });
  it('감정가의 3배 초과는 high 빌라·아파트도 상한', () => {
    expect(capMarketPrice(700_000_000, 'high', 200_000_000, 'villa')).toMatchObject({ marketPrice: 200_000_000, confidence: 'low', capped: true, overPct: 350 });
    expect(capMarketPrice(700_000_000, 'high', 200_000_000, 'apartment').marketPrice).toBe(260_000_000);
  });
  it('감정가의 0.3배 미만은 값은 두고 low 로 내린다', () => {
    expect(capMarketPrice(50_000_000, 'high', 200_000_000, 'officetel')).toMatchObject({ marketPrice: 50_000_000, confidence: 'low', capped: false, underPct: 25 });
    expect(capMarketPrice(70_000_000, 'high', 200_000_000, 'villa')).toMatchObject({ confidence: 'high', underPct: null }); // 35%는 그대로
  });
  it('감정가 없으면 상한 불가(그대로)', () => {
    expect(capMarketPrice(400_000_000, 'low', undefined, 'villa').capped).toBe(false);
  });
});

describe('extractDong', () => {
  it('구 뒤 동', () => expect(extractDong('서울 강동구 천호동 123')).toBe('천호동'));
  it('읍 추출', () => expect(extractDong('경북 구미시 산동읍 1-2')).toBe('산동읍'));
});
