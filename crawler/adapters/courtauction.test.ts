import { describe, it, expect } from 'vitest';
import { filterCourts, parseCourtDate, parseMoney, mapUsgCd } from './courtauction.ts';

describe('filterCourts', () => {
  it('빈 regions → 수도권 전체(9개) 반환', () => {
    expect(filterCourts([])).toHaveLength(9);
  });
  it('서울 → 서울 법원 5개', () => {
    const res = filterCourts(['서울']);
    expect(res.every((c) => c.name.includes('서울'))).toBe(true);
    expect(res).toHaveLength(5);
  });
  it('인천 → 인천지방법원 1개', () => {
    const res = filterCourts(['인천']);
    expect(res).toHaveLength(1);
    expect(res[0]!.code).toBe('B000240');
  });
  it('경기 → 수원+성남+의정부 3개', () => {
    const res = filterCourts(['경기', '수원', '성남', '의정부']);
    expect(res.length).toBeGreaterThanOrEqual(3);
  });
  it('법원코드 직접 입력', () => {
    const res = filterCourts(['B000210']);
    expect(res).toHaveLength(1);
    expect(res[0]!.name).toBe('서울중앙지방법원');
  });
  it('매칭 없음 → 빈 배열', () => {
    expect(filterCourts(['부산'])).toHaveLength(0);
  });
  it('반환값 변형이 METRO_COURTS 원본에 영향 없음', () => {
    const r = filterCourts([]);
    r.push({ code: 'ZZZ', name: '테스트법원' });
    expect(filterCourts([])).toHaveLength(9); // 원본 불변
  });
});

describe('parseCourtDate', () => {
  it('YYYYMMDD 8자리 변환', () => {
    expect(parseCourtDate('20260708')).toBe('2026-07-08');
  });
  it('YYYY.MM.DD 변환', () => {
    expect(parseCourtDate('2026.07.08')).toBe('2026-07-08');
  });
  it('한자리 월/일도 처리', () => {
    expect(parseCourtDate('2026.7.8')).toBe('2026-07-08');
  });
  it('undefined/빈값 → undefined', () => {
    expect(parseCourtDate(undefined)).toBeUndefined();
    expect(parseCourtDate('')).toBeUndefined();
  });
  it('불가능한 날짜 → undefined', () => {
    expect(parseCourtDate('20261340')).toBeUndefined(); // 13월 40일
  });
});

describe('parseMoney', () => {
  it('콤마 금액 파싱', () => {
    expect(parseMoney('1,234,567,000')).toBe(1_234_567_000);
  });
  it('콤마 없는 정수', () => {
    expect(parseMoney('530000000')).toBe(530_000_000);
  });
  it('undefined → 0', () => {
    expect(parseMoney(undefined)).toBe(0);
  });
  it('빈 문자열 → 0', () => {
    expect(parseMoney('')).toBe(0);
  });
  it('숫자가 아닌 문자열 → 0', () => {
    expect(parseMoney('없음')).toBe(0);
  });
});

describe('mapUsgCd', () => {
  it('아파트 텍스트', () => {
    // 법원경매 API는 bigo(비고) 필드에 한글 용도명을 포함 — 숫자 코드만으로는 매핑 불가
    expect(mapUsgCd(undefined, '아파트')).toBe('apartment');
    expect(mapUsgCd('22100', '아파트')).toBe('apartment');
  });
  it('오피스텔', () => {
    expect(mapUsgCd(undefined, '오피스텔')).toBe('officetel');
  });
  it('다세대/연립 → villa', () => {
    expect(mapUsgCd(undefined, '다세대주택')).toBe('villa');
    expect(mapUsgCd(undefined, '연립주택')).toBe('villa');
  });
  it('단독주택 → house', () => {
    expect(mapUsgCd(undefined, '단독주택')).toBe('house');
  });
  it('상가/근린 → commercial', () => {
    expect(mapUsgCd(undefined, '근린생활시설')).toBe('commercial');
    expect(mapUsgCd(undefined, '상가')).toBe('commercial');
  });
  it('토지/임야 → land', () => {
    expect(mapUsgCd(undefined, '토지')).toBe('land');
    expect(mapUsgCd(undefined, '임야')).toBe('land');
  });
  it('미분류 → other', () => {
    expect(mapUsgCd(undefined, undefined)).toBe('other');
    expect(mapUsgCd('99999', '기타')).toBe('other');
  });
});
