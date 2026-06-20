import { describe, it, expect } from 'vitest';
import type { Comparable } from '../../shared/types.ts';
import { parseMolitDealAmount, dongMatches, extractDong, estimateMarketPrice } from './comps.ts';

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
});

describe('extractDong', () => {
  it('구 뒤 동', () => expect(extractDong('서울 강동구 천호동 123')).toBe('천호동'));
  it('읍 추출', () => expect(extractDong('경북 구미시 산동읍 1-2')).toBe('산동읍'));
});
