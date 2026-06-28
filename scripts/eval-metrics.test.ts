import { describe, it, expect } from 'vitest';
import { coverage, priceStats, qualityStats, surprises, formatSummary, type EvalRow } from './eval-metrics.ts';

const row = (o: Partial<EvalRow> = {}): EvalRow => ({
  case_no: 'x', item_no: '1', sale_date: '2026-06-01', property_type: 'apartment',
  court: '서울중앙지방법원', address: '서울특별시 강남구 역삼동', appraisal_value: 3e8,
  expected_bid: 2e8, market_price: 3e8, min_bid_price: 2e8, total_score: 80, passed_filter: true,
  recommendation: 'consider', true_margin: 0.3, inq_cnt: 0, interest_cnt: 0,
  sold: false, sold_amount: null, result_cd: null, matched: true, residual: null, residual_pct: null, sale_ratio: null,
  ...o,
});

const overpriced = row({ case_no: 'A', sold: true, sold_amount: 2.6e8, residual_pct: 0.3, sale_ratio: 0.86 });
const avoidSold = row({ case_no: 'B', passed_filter: false, recommendation: 'avoid', sold: true, sold_amount: 2.7e8, residual_pct: 0.1, sale_ratio: 0.9 });
const passedUnsold = row({ case_no: 'C', sold: false, matched: true, result_cd: '002', passed_filter: true });
const missed = row({ case_no: 'D', matched: false, sold: false });
const rows = [overpriced, avoidSold, passedUnsold, missed];

describe('coverage', () => {
  it('매칭/낙찰/유찰/미매칭 집계', () => {
    expect(coverage(rows)).toMatchObject({ pastSnapshots: 4, matched: 3, sold: 2, unsold: 1 });
    expect(coverage(rows).missRate).toBeCloseTo(0.25);
  });
  it('빈 입력 안전', () => {
    expect(coverage([])).toMatchObject({ pastSnapshots: 0, matched: 0, missRate: 0 });
  });
});

describe('priceStats', () => {
  it('낙찰건 잔차 기반 편향(+면 과소예측)', () => {
    const p = priceStats(rows)!;
    expect(p.n).toBe(2);
    expect(p.biasPct).toBeCloseTo(20); // mean(30,10)
    expect(p.mapePct).toBeCloseTo(20);
  });
  it('낙찰 없으면 null', () => {
    expect(priceStats([passedUnsold, missed])).toBeNull();
  });
});

describe('qualityStats', () => {
  it('통과 vs 미통과 낙찰률', () => {
    const q = qualityStats(rows)!;
    expect(q.passedSoldRate).toBeCloseTo(0.5); // 통과 2건(A,C) 중 1건(A) 낙찰
    expect(q.notPassedSoldRate).toBeCloseTo(1); // 미통과 1건(B) 낙찰
  });
});

describe('surprises', () => {
  it('예상보다 비쌈 · 안좋은데 팔림 · 추천했는데 유찰', () => {
    const s = surprises(rows);
    expect(s.overpriced[0]!.case_no).toBe('A');
    expect(s.avoidButSold[0]!.case_no).toBe('B');
    expect(s.passedButUnsold[0]!.case_no).toBe('C');
  });
});

describe('formatSummary', () => {
  it('매칭 건수 + 게이트 상태', () => {
    expect(formatSummary(rows, 50)).toContain('매칭 3건(낙찰 2');
    expect(formatSummary(rows, 50)).toContain('축적 중');
    expect(formatSummary(rows, 2)).toContain('시작 가능');
  });
});
