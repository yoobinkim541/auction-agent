import { describe, it, expect } from 'vitest';
import { parseKoreanMoney, parseKoreanDate, mapPropertyType, mapRightKind, parseAreaToM2, extractAmountFromText, extractLabeledKoreanMoney } from './normalize.ts';

describe('parseKoreanMoney', () => {
  it('콤마 숫자', () => expect(parseKoreanMoney('530,000,000원')).toBe(530_000_000));
  it('억+만', () => expect(parseKoreanMoney('5억3,000만')).toBe(530_000_000));
  it('억만 단순', () => expect(parseKoreanMoney('5억')).toBe(500_000_000));
  it('만 단위', () => expect(parseKoreanMoney('8,500만원')).toBe(85_000_000));
  it('억+천만(천 표기)', () => expect(parseKoreanMoney('5억3천만')).toBe(530_000_000));
  it('천만 단독', () => expect(parseKoreanMoney('3천만원')).toBe(30_000_000));
  it('억+천만+백만 혼합', () => expect(parseKoreanMoney('5억3천만')).toBe(530_000_000));
  it('단위만 있고 숫자 없음→null', () => expect(parseKoreanMoney('억')).toBeNull());
  it('빈값', () => expect(parseKoreanMoney('')).toBeNull());
});

describe('extractAmountFromText (등기 한 줄에서 금액만)', () => {
  it('날짜·순위번호 무시하고 채권액만', () =>
    expect(extractAmountFromText('1 2023.09.06 근저당권설정 우리은행 530,000,000원')).toBe(530_000_000));
  it('억/천만 표기', () =>
    expect(extractAmountFromText('2 2020-01-15 전세권 김철수 5억3천만원')).toBe(530_000_000));
  it('금액 없는 줄→null', () =>
    expect(extractAmountFromText('3 2020.01.01 가압류 서울중앙지법')).toBeNull());
  it('여러 금액이면 최댓값(채권최고액)', () =>
    expect(extractAmountFromText('근저당 채권최고액 660,000,000 (원금 550,000,000)')).toBe(660_000_000));
});

describe('extractLabeledKoreanMoney', () => {
  it('임차인 보증금 억/만원 단위', () =>
    expect(extractLabeledKoreanMoney('보증금 : 1억2,000만원 전입일자 : 2024-01-02', '보증금', ['전입일자'])).toBe(120_000_000));
  it('임차권등기 노트의 임대차보증금 단위', () =>
    expect(extractLabeledKoreanMoney('임대차보증금 금 3억5천만원, 주민등록일자 2020.01.01', '(?:임차보증금|임대차보증금)', ['주민등록일자'])).toBe(350_000_000));
  it('다음 날짜 숫자를 금액에 섞지 않음', () =>
    expect(extractLabeledKoreanMoney('보증금 120,000,000 전입일자 2024-01-02', '보증금', ['전입일자'])).toBe(120_000_000));
});

describe('parseKoreanDate', () => {
  it('점 구분', () => expect(parseKoreanDate('2024.05.01')).toBe('2024-05-01'));
  it('한글', () => expect(parseKoreanDate('2024년 5월 1일')).toBe('2024-05-01'));
  it('붙은 8자리', () => expect(parseKoreanDate('20240501')).toBe('2024-05-01'));
  it('접두 텍스트 있어도 추출', () => expect(parseKoreanDate('설정 2023.09.06')).toBe('2023-09-06'));
  it('실패', () => expect(parseKoreanDate('미정')).toBeUndefined());
  it('불가능한 월/일 거부', () => expect(parseKoreanDate('2023.13.45')).toBeUndefined());
  it('2월 30일 거부', () => expect(parseKoreanDate('2023.02.30')).toBeUndefined());
  it('더 긴 숫자열 안에서는 매칭 안 함', () => expect(parseKoreanDate('120230906')).toBeUndefined());
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
  it('저당(근저당 아님)', () => expect(mapRightKind('저당권설정')).toBe('jeodang'));
  it('가압류', () => expect(mapRightKind('가압류')).toBe('gaapryu'));
  it('압류(가압류 아님)', () => expect(mapRightKind('압류')).toBe('apryu'));
  it('담보가등기 → dambo_gadeungi(보전가등기와 구별)', () => expect(mapRightKind('담보가등기')).toBe('dambo_gadeungi'));
  it('경매개시', () => expect(mapRightKind('임의경매개시결정')).toBe('gyeongmae_gaesi'));
  it('전세권', () => expect(mapRightKind('전세권설정')).toBe('jeonse'));
  it('철거가처분', () => expect(mapRightKind('건물철거 및 토지인도 가처분')).toBe('cheolgeo_gacheobun'));
  it('가등기(보전) → bowjeon_gadeungi', () => expect(mapRightKind('소유권이전청구권가등기')).toBe('bowjeon_gadeungi'));
  it('임차권등기', () => expect(mapRightKind('임차권등기명령')).toBe('imchagwon'));
  it('빈값 → other', () => expect(mapRightKind('')).toBe('other'));
});

describe('parseAreaToM2', () => {
  it('㎡', () => expect(parseAreaToM2('84.95㎡')).toBe(84.95));
  it('m2 ASCII', () => expect(parseAreaToM2('84.95m2')).toBe(84.95));
  it('m² 유니코드', () => expect(parseAreaToM2('59.94m²')).toBe(59.94));
  it('평 환산', () => expect(parseAreaToM2('25평')).toBeCloseTo(82.64, 1));
  it('빈값 → undefined', () => expect(parseAreaToM2('')).toBeUndefined());
  it('null → undefined', () => expect(parseAreaToM2(null)).toBeUndefined());
});
