/**
 * 결과 피드백 보정 리포트(학습 Phase 2) — raw 스냅샷으로 커버리지를 감사하고,
 * 신뢰된 결과로 가격·품질 보정과 "왜 비싸게/안좋은게 팔렸나" 서프라이즈를 출력.
 * 게이트 미달이면 축적 안내만. 사용: npm run eval:report [--summary]   (EVAL_GATE 기본 50)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import { formatReport, formatSummary, type EvalRow } from './eval-metrics.ts';

async function main(): Promise<void> {
  const gate = Number(process.env.EVAL_GATE) || 50;
  const summaryOnly = process.argv.includes('--summary');
  const coverageRows = await query<EvalRow>(
    `select case_no, item_no, sale_date::text, property_type, court, address,
            appraisal_value::float8, expected_bid::float8, market_price::float8, min_bid_price::float8,
            total_score, passed_filter, recommendation, true_margin, max_safe_bid::float8, inq_cnt, interest_cnt,
            sold, sold_amount::float8, result_cd, matched, residual::float8, residual_pct, sale_ratio,
            would_have_won_under_max_safe_bid, realized_bid_margin
       from gm_outcome_eval
      where sale_date < current_date`,
  );
  const trustedRows = await query<EvalRow>(
    `select case_no, item_no, sale_date::text, property_type, court, address,
            appraisal_value::float8, expected_bid::float8, market_price::float8, min_bid_price::float8,
            total_score, passed_filter, recommendation, true_margin, max_safe_bid::float8, inq_cnt, interest_cnt,
            sold, sold_amount::float8, result_cd, matched, residual::float8, residual_pct, sale_ratio,
            would_have_won_under_max_safe_bid, realized_bid_margin
       from gm_trusted_outcome_eval
      where sale_date < current_date`,
  );
  const trustCounts = await query<{ status: string; rows: number }>(
    `select t.status, count(*)::int as rows
       from gm_outcome_trust t
       join gm_outcome_eval e
         on e.case_no = t.case_no
        and coalesce(nullif(e.item_no, ''), '1') = t.item_no
        and e.sale_date = t.sale_date
      where e.sale_date < current_date
      group by t.status`,
  );
  const counts = new Map(trustCounts.map(({ status, rows }) => [status, rows]));
  const trustSummary = `🛡️ 결과 신뢰: raw ${coverageRows.length} · trusted ${trustedRows.length} · hold ${counts.get('hold') ?? 0} · quarantined ${counts.get('quarantined') ?? 0}`;
  console.log(summaryOnly
    ? formatSummary(coverageRows, gate)
    : `${formatReport(trustedRows, gate, coverageRows)}\n${trustSummary}`);
  await pool().end();
}

main().catch((e) => { console.error('eval-report 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
