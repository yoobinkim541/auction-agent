/**
 * Phase2 ML 오프라인 학습셋 export.
 * DB 접근은 기존 Node pg 경로를 재사용하고, Python 분석은 CSV만 읽게 분리한다.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { query, pool } from '../shared/db.ts';

const outPath = process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ?? 'artifacts/ml/outcome_eval.csv';

type Cell = string | number | boolean | null | undefined | Date;

function csvCell(value: Cell): string {
  if (value == null) return '';
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main(): Promise<void> {
  const rows = await query<Record<string, Cell>>(
    `with latest_listing as (
       select distinct on (case_no, coalesce(nullif(item_no, ''), '1'))
              id as listing_id, case_no, coalesce(nullif(item_no, ''), '1') as item_no,
              fail_count, area_m2, building_area_m2, is_collective_building
         from gm_listings
        order by case_no, coalesce(nullif(item_no, ''), '1'), crawled_at desc nulls last
     ), trusted as (
       select e.*, l.fail_count, l.area_m2, l.building_area_m2, l.is_collective_building,
              loc.market_confidence, rr.risk_grade, rr.assumed_amount,
              exists (
                select 1
                  from jsonb_array_elements(coalesce(rr.tenants, '[]'::jsonb)) tenant
                 where coalesce((tenant->>'hasOpposition')::boolean, false)
              ) as has_opposition_tenant
         from gm_trusted_outcome_eval e
         left join latest_listing l
           on l.case_no = e.case_no
          and l.item_no = coalesce(nullif(e.item_no, ''), '1')
         left join gm_rights_analysis rr on rr.listing_id = l.listing_id
         left join gm_location_analysis loc on loc.listing_id = l.listing_id
        where e.sale_date < current_date
     )
     select case_no, item_no, sale_date::text, property_type, court, address,
            appraisal_value::float8, expected_bid::float8, market_price::float8, min_bid_price::float8,
            total_score::float8, passed_filter, recommendation, true_margin::float8, max_safe_bid::float8,
            inq_cnt::float8, interest_cnt::float8,
            fail_count::float8, area_m2::float8, building_area_m2::float8,
            is_collective_building, market_confidence,
            sold, sold_amount::float8, result_cd, matched, residual::float8, residual_pct, sale_ratio,
            would_have_won_under_max_safe_bid, realized_bid_margin,
            risk_grade, assumed_amount::float8, has_opposition_tenant
       from trusted
      order by sale_date, case_no, item_no`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  const columns = rows.length
    ? Object.keys(rows[0]!)
    : ['case_no', 'item_no', 'sale_date', 'property_type', 'court', 'address', 'appraisal_value', 'expected_bid', 'market_price', 'min_bid_price', 'total_score', 'passed_filter', 'recommendation', 'true_margin', 'max_safe_bid', 'inq_cnt', 'interest_cnt', 'fail_count', 'area_m2', 'building_area_m2', 'is_collective_building', 'market_confidence', 'sold', 'sold_amount', 'result_cd', 'matched', 'residual', 'residual_pct', 'sale_ratio', 'would_have_won_under_max_safe_bid', 'realized_bid_margin', 'risk_grade', 'assumed_amount', 'has_opposition_tenant'];
  const csv = [columns.join(','), ...rows.map((row) => columns.map((col) => csvCell(row[col])).join(','))].join('\n') + '\n';
  writeFileSync(outPath, csv);
  console.log(`[ml:export] ${rows.length} rows -> ${outPath}`);
  await pool().end();
}

main().catch((err) => {
  console.error('ml export 실패:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
