import { describe, it, expect } from 'vitest';
import { parseResultRowText, splitDeonakCaseNo } from './parse-row.ts';

const OPTS = { sourceUrl: 'https://example/list' };
const ACTIVE = '서울중앙지방법원 본원 3계 2024-12345 [아파트] 서울특별시 강동구 천호동 123 건물 84.95㎡ 감정가 530,000,000 최저가 371,000,000 유찰 1회 (70%) 2025-07-01';

describe('parseResultRowText — 상태 필터(#4)', () => {
  it('진행(유찰) 매물은 수집', () => {
    const r = parseResultRowText(ACTIVE, OPTS);
    expect(r).not.toBeNull();
    expect(r!.listing.minBidRatio).toBe(70);
  });
  it('낙찰((%)있음)은 제외', () => {
    const r = parseResultRowText(ACTIVE.replace('유찰 1회 (70%)', '낙찰 (95%)'), OPTS);
    expect(r).toBeNull();
  });
  it('비율(%) 없는 낙찰 행도 제외 — 과거 통과되던 버그', () => {
    const r = parseResultRowText(ACTIVE.replace('유찰 1회 (70%)', '낙찰'), OPTS);
    expect(r).toBeNull();
  });
  it('비율 없는 취하 행도 제외', () => {
    const r = parseResultRowText(ACTIVE.replace('유찰 1회 (70%)', '취하'), OPTS);
    expect(r).toBeNull();
  });
});

describe('parseResultRowText — 감정가/최저가(#3)', () => {
  it('콤마 표기 정상 추출', () => {
    const r = parseResultRowText(ACTIVE, OPTS)!;
    expect(r.listing.appraisalValue).toBe(530_000_000);
    expect(r.listing.minBidPrice).toBe(371_000_000);
  });
  it('억/만 표기도 추출(과거: 0으로 떨어져 안전마진 100% 오탐)', () => {
    const r = parseResultRowText(ACTIVE.replace('감정가 530,000,000 최저가 371,000,000', '감정가 5억3천만 최저가 3억7,100만'), OPTS)!;
    expect(r.listing.appraisalValue).toBe(530_000_000);
    expect(r.listing.minBidPrice).toBe(371_000_000);
  });
  it('파싱 실패 시 0 + 경고노트', () => {
    const r = parseResultRowText(ACTIVE.replace('감정가 530,000,000 최저가 371,000,000', '감정가 최저가'), OPTS)!;
    expect(r.listing.appraisalValue).toBe(0);
    expect(r.notes.some((n) => n.includes('자동파싱 실패'))).toBe(true);
  });
});

describe('parseResultRowText — 기타', () => {
  it('헤더 형식 아니면 null', () => expect(parseResultRowText('의미없는 텍스트', OPTS)).toBeNull());
  it('특수권리 [..] 표기는 노트로', () => {
    const r = parseResultRowText(ACTIVE.replace('[아파트]', '[아파트] [유치권]'), OPTS)!;
    expect(r.notes.some((n) => n.includes('유치권'))).toBe(true);
  });
  it('다물건 사건번호를 caseNo/itemNo로 분리', () => {
    const r = parseResultRowText(ACTIVE.replace('2024-12345', '2024-12345-2'), OPTS)!;
    expect(r.listing.caseNo).toBe('2024-12345');
    expect(r.listing.itemNo).toBe('2');
  });
});

describe('splitDeonakCaseNo', () => {
  it('물건번호 없으면 1', () => expect(splitDeonakCaseNo('2025-103018')).toEqual({ baseCaseNo: '2025-103018', itemNo: '1' }));
  it('물건번호 있으면 분리', () => expect(splitDeonakCaseNo('2025-103018-3')).toEqual({ baseCaseNo: '2025-103018', itemNo: '3' }));
  it('물건번호 앞자리 0은 제거', () => expect(splitDeonakCaseNo('2025-103018-03')).toEqual({ baseCaseNo: '2025-103018', itemNo: '3' }));
});
