import { describe, it, expect } from 'vitest';
import { formatDigest, type DigestRow } from './digest-format.ts';

const row = (over: Partial<DigestRow> = {}): DigestRow => ({
  case_no: '2024타경1', property_type: 'apartment', address: '서울특별시 강남구 역삼동 1-2',
  appraisal_value: 3e8, min_bid_price: 2e8, sale_date: '2026-07-01',
  source_url: 'https://x', inq_cnt: 3, interest_cnt: 0, crawled_at: '2026-06-27T00:00:00Z',
  risk_grade: 'clean', safety_margin: 0.33, true_margin: 0.28, total_score: 82, ...over,
});

describe('formatDigest', () => {
  it('빈 목록 → 안내', () => {
    expect(formatDigest([], { today: '2026-06-27', totalPassed: 0 })).toContain('매물이 없습니다');
  });

  it('항목 포맷 — 점수·마진·저경쟁·링크', () => {
    const s = formatDigest([row()], { today: '2026-06-27', totalPassed: 5 });
    expect(s).toContain('추천 1건 (통과 5건');
    expect(s).toContain('2024타경1');
    expect(s).toContain('아파트');
    expect(s).toContain('⭐82');
    expect(s).toContain('안전마진 33%');
    expect(s).toContain('진짜 28%');
    expect(s).toContain('🔥저경쟁(조회3)'); // 압력 3 ≤ 10
    expect(s).toContain('https://x');
  });

  it('고경쟁(조회 많음) → 저경쟁 태그 없음', () => {
    const s = formatDigest([row({ inq_cnt: 50, interest_cnt: 5 })], { today: '2026-06-27', totalPassed: 1 });
    expect(s).not.toContain('🔥저경쟁');
  });

  it('당일 수집 → 🆕', () => {
    expect(formatDigest([row({ crawled_at: '2026-06-27T01:00:00Z' })], { today: '2026-06-27', totalPassed: 1 })).toContain('🆕');
  });
});
