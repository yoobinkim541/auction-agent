import { describe, it, expect } from 'vitest';
import { buildCsv, type CsvRow } from './export-csv.ts';
import type { ListingItem } from './api.ts';
import type { ClientScore } from './scoring.ts';

const item = (over: Record<string, unknown> = {}): ListingItem => ({
  case_no: '2024타경1234', property_type: 'apartment', area_m2: 84.99, address: '서울시 강남구', court: '서울중앙',
  appraisal_value: 300_000_000, min_bid_price: 200_000_000, sale_date: '2026-07-01', fail_count: 0, is_favorite: false,
  rights: { risk_grade: 'clean', assumed_amount: 0 },
  location: { safety_margin: 0.2, acquisition_cost: { trueSafetyMargin: 0.18 }, report: { dangerCount: 0, warnCount: 1 } },
  ...over,
} as unknown as ListingItem);

const sc = (over: Partial<ClientScore> = {}): ClientScore =>
  ({ totalScore: 75, passed: true, reasons: [], safetyScore: 50, cleanScore: 100, ...over } as ClientScore);

const row = (over: Record<string, unknown> = {}, score: Partial<ClientScore> = {}): CsvRow =>
  ({ item: item(over), sc: sc(score) });

describe('buildCsv', () => {
  it('BOM + 헤더 행만(빈 입력) — 26개 컬럼', () => {
    const out = buildCsv([]);
    expect(out.startsWith('﻿')).toBe(true); // Excel 한글 UTF-8 BOM
    const lines = out.replace('﻿', '').split('\r\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.split(',')).toHaveLength(26);
    expect(lines[0]).toContain('"사건번호"');
    expect(lines[0]).toContain('"관심"');
  });

  it('금액은 만원 단위 반올림, 통과 ○ / 종류 라벨', () => {
    const out = buildCsv([row()]);
    const dataLine = out.split('\r\n')[1]!;
    const cells = dataLine.split(',');
    expect(cells[0]).toBe('"2024타경1234"');
    expect(cells[1]).toBe('"아파트"');           // TYPE_LABEL
    expect(cells[2]).toBe('"84.99"');           // 면적 toFixed(2)
    expect(cells[5]).toBe('"30000"');           // 감정가 3억 → 30000만원
    expect(cells[6]).toBe('"20000"');           // 최저가 2억
    expect(cells[7]).toBe('"20.0"');            // 안전마진 0.2 → 20.0%
    expect(dataLine).toContain('"○"');          // passed
  });

  it('미통과 ✕ + 사유 " · " 결합', () => {
    const out = buildCsv([row({}, { passed: false, reasons: ['안전마진 부족', '인수금액 있음'] })]);
    const dataLine = out.split('\r\n')[1]!;
    expect(dataLine).toContain('"✕"');
    expect(dataLine).toContain('"안전마진 부족 · 인수금액 있음"');
  });

  it('CSV escaping — 쉼표·큰따옴표 포함 주소', () => {
    const out = buildCsv([row({ address: '서울 "강남", 1번지' })]);
    const dataLine = out.split('\r\n')[1]!;
    // 따옴표는 ""로 이스케이프되고 전체가 "..."로 감싸짐 → 쉼표가 셀 구분과 충돌하지 않음
    expect(dataLine).toContain('"서울 ""강남"", 1번지"');
  });

  it('null 금액/면적은 빈 셀', () => {
    const out = buildCsv([row({ area_m2: null, appraisal_value: null, location: null })]);
    const cells = out.split('\r\n')[1]!.split(',');
    expect(cells[2]).toBe('""'); // 면적
    expect(cells[5]).toBe('""'); // 감정가
  });
});
