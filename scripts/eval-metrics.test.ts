import { describe, it, expect } from 'vitest';
import { coverage, priceStats, qualityStats, profitStats, surprises, formatReport, formatSummary, type EvalRow } from './eval-metrics.ts';

const row = (o: Partial<EvalRow> = {}): EvalRow => ({
  case_no: 'x', item_no: '1', sale_date: '2026-06-01', property_type: 'apartment',
  court: '서울중앙지방법원', address: '서울특별시 강남구 역삼동', appraisal_value: 3e8,
  expected_bid: 2e8, market_price: 3e8, min_bid_price: 2e8, total_score: 80, passed_filter: true,
  recommendation: 'consider', true_margin: 0.3, max_safe_bid: 2.4e8, inq_cnt: 0, interest_cnt: 0,
  sold: false, sold_amount: null, result_cd: null, matched: true, residual: null, residual_pct: null, sale_ratio: null,
  would_have_won_under_max_safe_bid: null, realized_bid_margin: null,
  ...o,
});

const overpriced = row({ case_no: 'A', sold: true, sold_amount: 2.6e8, residual_pct: 0.3, sale_ratio: 0.86, max_safe_bid: 2.7e8, would_have_won_under_max_safe_bid: true, realized_bid_margin: (3e8 - 2.6e8) / 3e8 });
const avoidSold = row({ case_no: 'B', passed_filter: false, recommendation: 'avoid', sold: true, sold_amount: 2.7e8, residual_pct: 0.1, sale_ratio: 0.9, max_safe_bid: 2.4e8, would_have_won_under_max_safe_bid: false, realized_bid_margin: (3e8 - 2.7e8) / 3e8 });
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
  it('missRate는 매각 후 2일 이내 건을 분모에서 제외한다(courtauction 게시 지연)', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const settledMiss = row({ sale_date: '2026-09-01', matched: false });   // 확실히 놓침
    const recentMiss = row({ sale_date: '2026-09-09', matched: false });    // 아직 안 올라온 것일 뿐
    const c = coverage([settledMiss, recentMiss], now);
    expect(c.pastSnapshots).toBe(2);       // 전체 카운트는 유지
    expect(c.settledSnapshots).toBe(1);    // 버퍼 제외하면 1건
    expect(c.missRate).toBe(1);            // 그 1건이 미매칭 → 100% (recentMiss는 분모에서 빠져 희석 안 됨)
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


describe('profitStats', () => {
  it('안전입찰가와 실현마진 기준 품질을 집계', () => {
    const p = profitStats(rows)!;
    expect(p.soldRows).toBe(2);
    expect(p.safeBidRows).toBe(2);
    expect(p.wonUnderSafeBidRate).toBeCloseTo(0.5);
    expect(p.positiveRealizedMarginRate).toBeCloseTo(1);
    expect(p.passedPositiveMarginRate).toBeCloseTo(1);
    expect(p.notPassedPositiveMarginRate).toBeCloseTo(1);
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

describe('formatReport', () => {
  it('keeps raw coverage while calculating price metrics from trusted rows', () => {
    const trustedRows = [overpriced];
    const report = formatReport(trustedRows, 50, rows);

    expect(report).toContain('매칭 3건(낙찰 2');
    expect(report).toContain('[가격] 낙찰 1건');
    expect(report).not.toContain('2025타경908');
  });
});
