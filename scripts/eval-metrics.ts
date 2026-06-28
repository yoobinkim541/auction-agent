/**
 * 결과 피드백 보정 지표(순수 — DB/IO 없음, 테스트 가능). eval-report.ts가 gm_outcome_eval 행을 넘겨 호출.
 * 입력 rows = "지난 매각기일 스냅샷"(sale_date < today). matched=결과 매칭, sold=낙찰.
 */
export interface EvalRow {
  case_no: string; item_no: string; sale_date: string;
  property_type: string; court: string | null; address: string; appraisal_value: number | null;
  expected_bid: number | null; market_price: number | null; min_bid_price: number | null;
  total_score: number | null; passed_filter: boolean | null; recommendation: string | null;
  true_margin: number | null; inq_cnt: number | null; interest_cnt: number | null;
  sold: boolean | null; sold_amount: number | null; result_cd: string | null;
  matched: boolean; residual: number | null; residual_pct: number | null; sale_ratio: number | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** 매칭/커버리지 감사 — Phase 2a. 매일 폴링이 결과를 충분히 잡는지(missRate) = 전용캡처 필요여부 판단. */
export function coverage(rows: EvalRow[]) {
  const matched = rows.filter((r) => r.matched);
  const sold = matched.filter((r) => r.sold);
  return {
    pastSnapshots: rows.length,
    matched: matched.length,
    sold: sold.length,
    unsold: matched.length - sold.length, // 유찰/변경 등
    missRate: rows.length ? 1 - matched.length / rows.length : 0,
  };
}

/** 가격 보정 — 예상낙찰가 vs 실제(낙찰건만). residual_pct 기반 MAPE/편향 + 낙찰가율. */
export function priceStats(rows: EvalRow[]) {
  const s = rows.filter((r) => r.sold && r.residual_pct != null);
  if (!s.length) return null;
  return {
    n: s.length,
    mapePct: (mean(s.map((r) => Math.abs(r.residual_pct!))) ?? 0) * 100,
    biasPct: (mean(s.map((r) => r.residual_pct!)) ?? 0) * 100, // +면 우리가 과소예측(시장이 더 비싸게)
    saleRatioMedPct: (median(s.filter((r) => r.sale_ratio != null).map((r) => r.sale_ratio!)) ?? 0) * 100,
  };
}

/** 품질 보정 — 우리 통과/점수가 실제 낙찰을 예측하나. */
export function qualityStats(rows: EvalRow[]) {
  const m = rows.filter((r) => r.matched);
  if (!m.length) return null;
  const passed = m.filter((r) => r.passed_filter === true);
  const notPassed = m.filter((r) => r.passed_filter === false);
  const rate = (xs: EvalRow[]) => (xs.length ? xs.filter((r) => r.sold).length / xs.length : null);
  return {
    matched: m.length,
    passedSoldRate: rate(passed), // 통과 매물이 실제 낙찰된 비율
    notPassedSoldRate: rate(notPassed), // 미통과인데 낙찰된 비율(높으면 기준이 헛다리)
  };
}

/** 서프라이즈 = 사용자의 두 질문. */
export function surprises(rows: EvalRow[], topN = 5) {
  const sold = rows.filter((r) => r.sold);
  return {
    // "예상보다 비싸게 팔림" — 양(+) 잔차 상위
    overpriced: [...sold].filter((r) => r.residual_pct != null).sort((a, b) => b.residual_pct! - a.residual_pct!).slice(0, topN),
    // "안좋다고 본 게 팔림" — 미통과/회피인데 낙찰(낙찰가율 높은 순)
    avoidButSold: sold.filter((r) => r.passed_filter === false || r.recommendation === 'avoid')
      .sort((a, b) => (b.sale_ratio ?? 0) - (a.sale_ratio ?? 0)).slice(0, topN),
    // (역) 추천했는데 유찰
    passedButUnsold: rows.filter((r) => r.matched && !r.sold && r.passed_filter === true).slice(0, topN),
  };
}

const eok = (n: number | null | undefined) => (n == null ? '-' : `${(n / 1e8).toFixed(1)}억`);

/** 한 줄 커버리지(다이제스트/일일 신호용). */
export function formatSummary(rows: EvalRow[], gate: number): string {
  const c = coverage(rows);
  const ready = c.matched >= gate;
  return `📊 복기 데이터: 매칭 ${c.matched}건(낙찰 ${c.sold}·유찰 ${c.unsold}) / 지난매각 ${c.pastSnapshots} · Phase2 기준 ${gate} ${ready ? '✅ 시작 가능' : '(축적 중)'}`;
}

/** 전체 보정·복기 리포트(stdout/대시보드). 게이트 미달이면 축적 안내. */
export function formatReport(rows: EvalRow[], gate: number): string {
  const c = coverage(rows);
  const out: string[] = ['=== 결과 피드백 보정 리포트 ===', formatSummary(rows, gate)];
  if (c.pastSnapshots === 0) {
    out.push('', '아직 매각기일이 지난 예측 스냅샷이 없습니다. 매일 축적 중 — 매각이 발생하면 채워집니다.');
    return out.join('\n');
  }
  if (c.missRate > 0.3) out.push(`⚠️ 결과 미매칭률 ${(c.missRate * 100).toFixed(0)}% — 매각결과를 자주 놓치면 '매각결과 전용검색' 캡처 검토(plan 2a).`);
  const p = priceStats(rows);
  if (p) out.push('', `[가격] 낙찰 ${p.n}건 · 예상오차(MAPE) ${p.mapePct.toFixed(1)}% · 편향 ${p.biasPct >= 0 ? '+' : ''}${p.biasPct.toFixed(1)}%(+면 과소예측) · 낙찰가율(중앙) ${p.saleRatioMedPct.toFixed(0)}%`);
  const q = qualityStats(rows);
  if (q) out.push(`[품질] 통과 매물 낙찰률 ${q.passedSoldRate != null ? (q.passedSoldRate * 100).toFixed(0) + '%' : '-'} vs 미통과 낙찰률 ${q.notPassedSoldRate != null ? (q.notPassedSoldRate * 100).toFixed(0) + '%' : '-'}`);
  if (c.sold > 0) {
    const s = surprises(rows, 3);
    if (s.overpriced.length) {
      out.push('', '🔺 예상보다 비싸게 팔림:');
      for (const r of s.overpriced) out.push(`  ${r.case_no} ${r.address.slice(0, 18)} — 예상 ${eok(r.expected_bid)}→실제 ${eok(r.sold_amount)} (+${((r.residual_pct ?? 0) * 100).toFixed(0)}%)`);
    }
    if (s.avoidButSold.length) {
      out.push('', '🟠 안좋다고 봤는데 낙찰:');
      for (const r of s.avoidButSold) out.push(`  ${r.case_no} ${r.address.slice(0, 18)} — 점수 ${r.total_score}·${r.recommendation ?? ''} · 낙찰가율 ${((r.sale_ratio ?? 0) * 100).toFixed(0)}%`);
    }
    if (s.passedButUnsold.length) {
      out.push('', '🔻 추천했는데 유찰:');
      for (const r of s.passedButUnsold) out.push(`  ${r.case_no} ${r.address.slice(0, 18)} — 점수 ${r.total_score}`);
    }
  }
  return out.join('\n');
}
