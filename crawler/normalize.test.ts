import { describe, it, expect } from 'vitest';
import { parseKoreanMoney, parseKoreanDate, mapPropertyType, mapRightKind, parseAreaToM2 } from './normalize.ts';

describe('parseKoreanMoney', () => {
  it('콤마 숫자', () => expect(parseKoreanMoney('530,000,000원')).toBe(530_000_000));
  it('억+만', () => expect(parseKoreanMoney('5억3,000만')).toBe(530_000_000));
  it('억만 단순', () => expect(parseKoreanMoney('5억')).toBe(500_000_000));
  it('만 단위', () => expect(parseKoreanMoney('8,500만원')).toBe(85_000_000));
  it('빈값', () => expect(parseKoreanMoney('')).toBeNull());
});

describe('parseKoreanDate', () => {
  it('점 구분', () => expect(parseKoreanDate('2024.05.01')).toBe('2024-05-01'));
  it('한글', () => expect(parseKoreanDate('2024년 5월 1일')).toBe('2024-05-01'));
  it('붙은 8자리', () => expect(parseKoreanDate('20240501')).toBe('2024-05-01'));
  it('실패', () => expect(parseKoreanDate('미정')).toBeUndefined());
});

describe('mapPropertyType', () => {
  it('아파트', () => expect(mapPropertyType('아파트')).toBe('apartment'));
  it('빌라', () => expect(mapPropertyType('다세대(빌라)')).toBe('villa'));
  it('오피스텔', () => expect(mapPropertyType('오피스텔')).toBe('officetel'));
  it('도시형생활주택→villa', () => expect(mapPropertyType('도시형생활주택')).toBe('villa'));
  it('상가', () => expect(mapPropertyType('근린상가')).toBe('commercial'));
});

describe('mapRightKind', () => {
  it('근저당', () => expect(mapRightKind('근저당권설정')).toBe('geunjeodang'));
  it('가압류', () => expect(mapRightKind('가압류')).toBe('gaapryu'));
  it('압류(가압류 아님)', () => expect(mapRightKind('압류')).toBe('apryu'));
  it('경매개시', () => expect(mapRightKind('임의경매개시결정')).toBe('gyeongmae_gaesi'));
  it('철거가처분', () => expect(mapRightKind('건물철거 및 토지인도 가처분')).toBe('cheolgeo_gacheobun'));
  it('가등기', () => expect(mapRightKind('소유권이전청구권가등기')).toBe('bowjeon_gadeungi'));
});

describe('parseAreaToM2', () => {
  it('㎡', () => expect(parseAreaToM2('84.95㎡')).toBe(84.95));
  it('평 환산', () => expect(parseAreaToM2('25평')).toBeCloseTo(82.64, 1));
});
