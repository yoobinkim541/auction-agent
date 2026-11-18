import { describe, expect, it } from 'vitest';
import { parseExclusiveArea } from '../crawler/normalize.ts';
import { avmTarget, parseFloor } from './ml-avm.ts';

describe('AVM target parsing', () => {
  it('reads the exclusive area from the court building text', () => {
    expect(parseExclusiveArea('철근콘크리트구조 59.88㎡')).toBe(59.88);
    expect(parseExclusiveArea('철근콘크리트조\n84.96㎡')).toBe(84.96);
    expect(parseExclusiveArea('1,084.5㎡')).toBe(1084.5);
    expect(parseExclusiveArea('철근콘크리트구조')).toBeNull();
    expect(parseExclusiveArea(null)).toBeNull();
  });

  it('adds up a unit that spans several floors', () => {
    expect(parseExclusiveArea('철근콘크리트구조 \n1층 32.89㎡ \n2층 31.13㎡ \n3층 18.88㎡')).toBe(82.9);
  });

  it('reads the floor, with basements below zero', () => {
    expect(parseFloor('103동 1층102호')).toBe(1);
    expect(parseFloor('107동 12층1203호')).toBe(12);
    expect(parseFloor('지하1층 비01호')).toBe(-1);
    expect(parseFloor('1층 2층 3층')).toBe(1);
    expect(parseFloor('가동')).toBeNull();
  });

  it('builds the keys trades are matched on', () => {
    const target = avmTarget({
      court: '수원지방법원', case_no: '2025타경3117', item_no: '1', sale_date: '2026-12-02', as_of: '2026-11-16',
      property_type: 'villa', address: '경기도 양평군 개군면 하자포리 220-17 우윤빌리지 주건축물제1동 4층401호', area_m2: null,
      hjgu_dong: '개군면', hjgu_rd: '하자포리', lot_no: '220-17', building_name: '우윤빌리지 주건축물제1동',
      building_text: '철근콘크리트구조 59.88㎡', unit_text: '4층401호',
    });
    expect(target).toMatchObject({ kind: 'rh', sgg: '41830', dong: '개군면 하자포리', jibun: '220-17', area_m2: 59.88, floor: 4 });
  });

  it('falls back to the address when the court fields are missing', () => {
    const target = avmTarget({
      court: '인천지방법원', case_no: '2024타경1', item_no: '1', sale_date: '2026-12-02', as_of: '2026-11-16',
      property_type: 'apartment', address: '인천광역시 남동구 구월동 258 구월팬더아파트 4동 13층1310호', area_m2: 77.84,
      hjgu_dong: null, hjgu_rd: null, lot_no: null, building_name: null, building_text: null, unit_text: null,
    });
    expect(target).toMatchObject({ kind: 'apt', sgg: '28200', dong: '구월동', jibun: '258', area_m2: 77.84, floor: 13 });
  });
});
