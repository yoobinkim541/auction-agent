import { describe, it, expect } from 'vitest';
import { NOTE_RULES } from './checklist.ts';

const ruleById = (id: string) => NOTE_RULES.find((r) => r.id === id)!;
const fires = (id: string, text: string) => ruleById(id).re.test(text);

describe('NOTE_RULES 키워드 스캔', () => {
  it('현금청산/권리산정기준일', () => {
    expect(fires('cash-settlement', '권리산정기준일 이후 취득으로 현금청산 대상')).toBe(true);
    expect(fires('cash-settlement', '일반 아파트 입찰 물건')).toBe(false);
  });
  it('공유지분 매각(N분의 M 포함)', () => {
    expect(fires('gongyu-jibun', '본건은 3분의 1 지분 매각')).toBe(true);
    expect(fires('gongyu-jibun', '단독 소유 전체 매각')).toBe(false);
  });
  it('명세서 인수 권리 기재', () => {
    expect(fires('non-extinguished-noted', '매각으로 소멸되지 않는 권리: ...')).toBe(true);
    expect(fires('non-extinguished-noted', '매수인이 인수하는 권리 있음')).toBe(true);
  });
  it('도시계획시설 저촉', () => {
    expect(fires('city-facility', '근린공원 저촉')).toBe(true);
    expect(fires('city-facility', '도시계획시설 저촉')).toBe(true);
  });
  it('군사보호구역 / 전 소유자 가압류', () => {
    expect(fires('military', '통제보호구역에 해당')).toBe(true);
    expect(fires('prev-owner-gaaprryu', '전 소유자에 대한 가압류 인수 조건')).toBe(true);
  });
  it('평범한 텍스트엔 어떤 위험 규칙도 안 걸림(오탐 회귀 가드)', () => {
    const benign = '제2종일반주거지역, 역세권, 깨끗한 권리관계, 단독 소유';
    expect(NOTE_RULES.filter((r) => r.re.test(benign))).toEqual([]);
  });
  it('규칙 id는 모두 고유', () => {
    expect(new Set(NOTE_RULES.map((r) => r.id)).size).toBe(NOTE_RULES.length);
  });
});
