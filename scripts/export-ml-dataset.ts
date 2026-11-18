/**
 * Phase2 ML 오프라인 학습셋 export.
 * DB 접근은 기존 Node pg 경로를 재사용하고, Python 분석은 CSV만 읽게 분리한다.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { query, pool } from '../shared/db.ts';

const outPath = process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ?? 'artifacts/ml/outcome_eval.csv';

type Cell = string | number | boolean | null | undefined | Date;

function csvCell(value: Cell): string {
  if (value == null) return '';
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 학습 행 — 신뢰 결과 ⋈ 입력. 오프라인 export와 shadow 학습이 같은 쿼리를 쓴다.
 * 입력은 gm_feature_snapshots(D-7 우선, 없으면 D-1)의 시점 고정 값을 쓰고, 스냅샷이 없는 과거 행만
 * 최신 매물·분석 행으로 대체한다. feature_source('d7'|'d1'|'latest')로 어느 쪽인지 남긴다.
 * 'latest' 행의 fail_count·권리·입지 값은 매각 뒤에 갱신됐을 수 있다.
 * 매물·스냅샷은 lateral 인덱스 조회로 붙인다. 플래너가 뷰를 1행으로 추정해, distinct on 서브쿼리와
 * 조인하면 결과 행마다 전체 정렬을 다시 한다(38,217행 기준 128초 → 스냅샷 조인을 더하면 360초).
 * avm_* 는 report-only 시세 모델 값(gm_avm_estimates, 매각 7일 전 기준)이고, shadow_good_* 는 매각일
 * 0시(KST) 전에 마지막으로 저장된 좋은 매물 확률이다 — 사후 추적용이며 학습 입력이 아니다.
 */
export const TRAINING_ROWS_SQL = `
  select e.case_no, e.item_no, e.sale_date::text, e.property_type, e.court, e.address,
         e.appraisal_value::float8, e.expected_bid::float8, e.market_price::float8,
         -- 그 기일의 실제 최저가는 결과의 최저가다(과거 예측 스냅샷의 최저가는 한 회차 전 값).
         coalesce(e.result_min_price, e.min_bid_price)::float8 as min_bid_price,
         e.total_score::float8, e.passed_filter, e.recommendation, e.true_margin::float8, e.max_safe_bid::float8,
         (case when f.case_no is not null then f.inq_cnt else e.inq_cnt end)::float8 as inq_cnt,
         (case when f.case_no is not null then f.interest_cnt else e.interest_cnt end)::float8 as interest_cnt,
         (case when f.case_no is not null then f.fail_count else l.fail_count end)::float8 as fail_count,
         (case when f.case_no is not null then f.area_m2 else l.area_m2 end)::float8 as area_m2,
         (case when f.case_no is not null then f.building_area_m2 else l.building_area_m2 end)::float8 as building_area_m2,
         case when f.case_no is not null then f.is_collective_building else l.is_collective_building end as is_collective_building,
         case when f.case_no is not null then f.market_confidence else loc.market_confidence end as market_confidence,
         e.sold, e.sold_amount::float8, e.result_cd, e.matched, e.residual::float8, e.residual_pct, e.sale_ratio,
         e.would_have_won_under_max_safe_bid, e.realized_bid_margin,
         case when f.case_no is not null then f.risk_grade else rr.risk_grade end as risk_grade,
         (case when f.case_no is not null then f.assumed_amount else rr.assumed_amount end)::float8 as assumed_amount,
         case when f.case_no is not null then f.has_opposition_tenant else exists (
           select 1
             from jsonb_array_elements(coalesce(rr.tenants, '[]'::jsonb)) tenant
            where coalesce((tenant->>'hasOpposition')::boolean, false)
         ) end as has_opposition_tenant,
         case when f.case_no is null then 'latest' when f.horizon_days = 7 then 'd7' else 'd1' end as feature_source,
         a.value::float8 as avm_value, a.value_low::float8 as avm_low, a.value_high::float8 as avm_high,
         a.basis as avm_basis, a.building_comps::float8 as avm_building_comps,
         (loc.acquisition_cost->>'moveOutCost')::float8 as move_out_cost,
         (loc.acquisition_cost->>'bondCost')::float8 as bond_cost,
         sh.shadow_good_probability, sh.shadow_good_version
    from gm_trusted_outcome_eval e
    left join lateral (
      select id as listing_id, fail_count, area_m2, building_area_m2, is_collective_building
        from gm_listings
       where court = e.court
         and case_no = e.case_no
         and coalesce(nullif(item_no, ''), '1') = coalesce(nullif(e.item_no, ''), '1')
       order by crawled_at desc nulls last, id desc
       limit 1
    ) l on true
    left join gm_rights_analysis rr on rr.listing_id = l.listing_id
    left join gm_location_analysis loc on loc.listing_id = l.listing_id
    left join lateral (
      select *
        from gm_feature_snapshots
       where court = e.court
         and case_no = e.case_no
         and item_no = coalesce(nullif(e.item_no, ''), '1')
         and sale_date = e.sale_date
       order by horizon_days desc
       limit 1
    ) f on true
    left join gm_avm_estimates a
      on a.court = e.court
     and a.case_no = e.case_no
     and a.item_no = coalesce(nullif(e.item_no, ''), '1')
     and a.sale_date = e.sale_date
    left join lateral (
      select (features->'good_listing'->>'probability')::float8 as shadow_good_probability,
             features->'good_listing'->>'version' as shadow_good_version
        from gm_shadow_scores
       where court = e.court
         and case_no = e.case_no
         and item_no = coalesce(nullif(e.item_no, ''), '1')
         and sale_date = e.sale_date
         and features ? 'good_listing'
         and created_at < (e.sale_date::timestamp at time zone 'Asia/Seoul')
       order by created_at desc
       limit 1
    ) sh on true
   where e.sale_date < current_date
   order by e.sale_date, e.court, e.case_no, e.item_no`;

async function main(): Promise<void> {
  const rows = await query<Record<string, Cell>>(TRAINING_ROWS_SQL);
  mkdirSync(dirname(outPath), { recursive: true });
  const columns = rows.length
    ? Object.keys(rows[0]!)
    : ['case_no', 'item_no', 'sale_date', 'property_type', 'court', 'address', 'appraisal_value', 'expected_bid', 'market_price', 'min_bid_price', 'total_score', 'passed_filter', 'recommendation', 'true_margin', 'max_safe_bid', 'inq_cnt', 'interest_cnt', 'fail_count', 'area_m2', 'building_area_m2', 'is_collective_building', 'market_confidence', 'sold', 'sold_amount', 'result_cd', 'matched', 'residual', 'residual_pct', 'sale_ratio', 'would_have_won_under_max_safe_bid', 'realized_bid_margin', 'risk_grade', 'assumed_amount', 'has_opposition_tenant', 'feature_source', 'avm_value', 'avm_low', 'avm_high', 'avm_basis', 'avm_building_comps', 'move_out_cost', 'bond_cost', 'shadow_good_probability', 'shadow_good_version'];
  const csv = [columns.join(','), ...rows.map((row) => columns.map((col) => csvCell(row[col])).join(','))].join('\n') + '\n';
  writeFileSync(outPath, csv);
  console.log(`[ml:export] ${rows.length} rows -> ${outPath}`);
  await pool().end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('ml export 실패:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
