import { describe, it, expect } from 'vitest';
import { formatDigest, formatResultsRecap, type DigestRow, type DigestResult } from './digest-format.ts';

const row = (over: Partial<DigestRow> = {}): DigestRow => ({
  case_no: '2024타경1', property_type: 'apartment', address: '서울특별시 강남구 역삼동 1-2',
  appraisal_value: 3e8, min_bid_price: 2e8, sale_date: '2026-07-01',
  source_url: 'https://x', inq_cnt: 3, interest_cnt: 0, crawled_at: '2026-06-27T00:00:00Z',
  risk_grade: 'clean', safety_margin: 0.33, true_margin: 0.28, total_score: 82, memo: null, ...over,
});

describe('formatDigest', () => {
  it('빈 목록 → 안내', () => {
    expect(formatDigest([], { today: '2026-06-27', totalPassed: 0 })).toContain('매물이 없습니다');
  });

  it('항목 포맷 — 점수·마진·저경쟁·링크·신규수', () => {
    const s = formatDigest([row()], { today: '2026-06-27', totalPassed: 5 });
    expect(s).toContain('추천 1건 (통과 5건');
    expect(s).toContain('🆕 신규');
    expect(s).toContain('⭐82');
    expect(s).toContain('안전마진 33%');
    expect(s).toContain('진짜 28%');
    expect(s).toContain('🔥저경쟁(조회3)');
    expect(s).toContain('https://x');
  });

  it('데이터 신선도 스탬프 — 오래되면 ⚠️', () => {
    const s = formatDigest([row()], { today: '2026-07-09', totalPassed: 5, dataAsOf: '2026-06-27', dataAgeDays: 12 });
    expect(s).toContain('데이터 기준 2026-06-27');
    expect(s).toContain('12일 전');
    expect(s).toContain('⚠️ 오래됨');
  });

  it('당일 데이터면 경고 없음', () => {
    const s = formatDigest([row()], { today: '2026-07-09', totalPassed: 5, dataAsOf: '2026-07-09', dataAgeDays: 0 });
    expect(s).not.toContain('오래됨');
  });

  it('극단마진(최저가<감정40%) → 경고 배지', () => {
    const s = formatDigest([row({ appraisal_value: 2.6e8, min_bid_price: 0.3e8 })], { today: '2026-06-27', totalPassed: 1 });
    expect(s).toContain('⚠️극단마진');
  });

  it('의견서 있으면 첫 문장 동봉', () => {
    const s = formatDigest([row({ memo: '권리관계 깨끗하고 입지 양호. 두 번째 문장은 생략.' })], { today: '2026-06-27', totalPassed: 1 });
    expect(s).toContain('💬 권리관계 깨끗하고 입지 양호.');
    expect(s).not.toContain('두 번째 문장');
  });
});

describe('formatResultsRecap', () => {
  const res = (o: Partial<DigestResult> = {}): DigestResult => ({
    case_no: '2023타경9', property_type: 'apartment', address: '서울 강남', appraisal_value: 4e8,
    sold: true, sold_amount: 4.5e8, sale_ratio: 1.125, was_recommended: false, ...o,
  });
  it('낙찰/유찰 집계 + 추천했던 물건 하이라이트', () => {
    const s = formatResultsRecap([res(), res({ case_no: '2023타경8', sold: false, sold_amount: null, sale_ratio: null }), res({ case_no: '2023타경7', was_recommended: true })], '최근');
    expect(s).toContain('낙찰 2 · 유찰 1');
    expect(s).toContain('낙찰가율(중앙)');
    expect(s).toContain('⭐추천했던 2023타경7');
  });
  it('빈 결과 → 빈 문자열(섹션 생략)', () => {
    expect(formatResultsRecap([], '최근')).toBe('');
  });
});
