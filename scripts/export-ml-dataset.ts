/**
 * Phase2 ML 오프라인 학습셋 export.
 * DB 접근은 기존 Node pg 경로를 재사용하고, Python 분석은 CSV만 읽게 분리한다.
 *
 * npm run ml:export                       artifacts/ml/outcome_eval.csv + artifacts/ml/frozen_decisions.csv
 * npm run ml:export -- --frozen-only      동결 판단 CSV만
 * npm run ml:export -- --frozen-out=PATH  동결 CSV 경로
 * ml:eval 은 ml:export 를 그대로 호출하므로 동결 CSV도 같이 나온다.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { query, pool } from '../shared/db.ts';
import { FEATURE_SNAPSHOT_VERSION, fullyFrozenSql } from './snapshot-predictions.ts';

export const EXPLORATORY_EXPORT_PATH = 'artifacts/ml/outcome_eval.csv';
export const FROZEN_DECISIONS_PATH = 'artifacts/ml/frozen_decisions.csv';

/** 판단 확률의 유일한 모델 이름. 탐색용 shadow JSON 의 good_listing 과 다른 원장에만 쓴다. */
export const GOOD_LISTING_MODEL_NAME = 'good-listing';
export const GOOD_LISTING_DECISION_VERSION = 'good-listing-v3';
export const GOOD_LISTING_DECISION_LABEL = 'post-sale-margin-v3';

type Cell = string | number | boolean | null | undefined | Date;

function csvCell(value: Cell): string {
  if (value == null) return '';
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportSelection(argv: readonly string[]): { exploratory: boolean; frozen: boolean; exploratoryPath: string; frozenPath: string } {
  const frozenOnly = argv.includes('--frozen-only');
  const exploratoryPath = argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ?? EXPLORATORY_EXPORT_PATH;
  const frozenPath = argv.find((arg) => arg.startsWith('--frozen-out='))?.slice('--frozen-out='.length) ?? FROZEN_DECISIONS_PATH;
  return {
    exploratory: !frozenOnly,
    frozen: true,
    exploratoryPath,
    frozenPath,
  };
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
 * min_bid_price 는 기존 탐색용 결합값이다. 불일치 감사는 input_min_bid_price / result_min_price 를 쓴다.
 */
export const TRAINING_ROWS_SQL = `
  select e.case_no, e.item_no, e.sale_date::text, e.property_type, e.court, e.address,
         e.appraisal_value::float8, e.expected_bid::float8, e.market_price::float8,
         -- 그 기일의 실제 최저가는 결과의 최저가다(과거 예측 스냅샷의 최저가는 한 회차 전 값).
         coalesce(e.result_min_price, e.min_bid_price)::float8 as min_bid_price,
         e.min_bid_price::float8 as input_min_bid_price,
         e.result_min_price::float8 as result_min_price,
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

/** 동결 입력 열. 후보 채점과 주간 export 가 같은 별칭을 쓴다. */
export function frozenFeatureSelectSql(alias = 'f'): string {
  return `${alias}.court, ${alias}.case_no, ${alias}.item_no, ${alias}.sale_date::text as sale_date,
         ${alias}.horizon_days, ${alias}.days_to_sale, ${alias}.listing_id,
         ${alias}.observed_on::text as observed_on, ${alias}.snapped_at::text as snapped_at,
         (${alias}.snapped_at at time zone 'Asia/Seoul')::date::text as snapped_at_kst,
         ${alias}.snapshot_version,
         case when ${alias}.horizon_days = 7 then 'd7' when ${alias}.horizon_days = 1 then 'd1' else 'legacy' end as feature_source,
         ${fullyFrozenSql(alias)} as fully_frozen,
         ${alias}.address, ${alias}.property_type, ${alias}.appraisal_value::float8 as appraisal_value,
         ${alias}.price_floor::float8 as price_floor, ${alias}.min_bid_price::float8 as min_bid_price,
         ${alias}.recommended_bid::float8 as recommended_bid, ${alias}.hard_cap_bid::float8 as hard_cap_bid,
         ${alias}.conservative_value::float8 as conservative_value,
         ${alias}.precision_status, ${alias}.precision_confidence, ${alias}.precision_confidence as confidence,
         ${alias}.precision_evaluator_version,
         ${alias}.target_margin_pct::float8 as target_margin_pct, ${alias}.target_margin_source,
         ${alias}.assumed_amount::float8 as assumed_amount, ${alias}.fixed_costs::float8 as fixed_costs,
         ${alias}.acq_tax::float8 as acq_tax, ${alias}.acq_tax_rate_pct::float8 as acq_tax_rate_pct,
         ${alias}.move_out_cost::float8 as move_out_cost, ${alias}.bond_cost::float8 as bond_cost,
         ${alias}.etc_cost::float8 as etc_cost, ${alias}.cost_bid_price::float8 as cost_bid_price,
         ${alias}.cost_bid_basis, ${alias}.costs_captured, ${alias}.shortlist_eligible, ${alias}.comparison_eligible,
         ${alias}.trust_status, ${alias}.trust_score, ${alias}.trust_evaluator_version,
         ${alias}.area_m2::float8 as area_m2, ${alias}.building_area_m2::float8 as building_area_m2,
         ${alias}.is_collective_building, ${alias}.fail_count::float8 as fail_count,
         ${alias}.inq_cnt::float8 as inq_cnt, ${alias}.interest_cnt::float8 as interest_cnt,
         ${alias}.risk_grade, ${alias}.has_opposition_tenant, ${alias}.max_safe_bid::float8 as max_safe_bid,
         ${alias}.market_price::float8 as market_price, ${alias}.market_confidence,
         ${alias}.avm_value::float8 as avm_value, ${alias}.avm_low::float8 as avm_low,
         ${alias}.avm_high::float8 as avm_high, ${alias}.avm_basis, ${alias}.avm_kind,
         ${alias}.avm_model_version, ${alias}.avm_as_of::text as avm_as_of,
         ${alias}.avm_available, ${alias}.avm_building_comps::float8 as avm_building_comps,
         ${alias}.reason_codes::text as reason_codes`;
}

/**
 * 주간·오프라인용 동결 판단 원장. 파라미터 없음. 매칭되지 않은 행도 남긴다.
 * 라벨은 gm_trusted_outcome_eval 이다. 원시 결과는 kind_cd 01 의 커버리지와 미확정 코드만 쓴다.
 * price_floor 가 관측 시점 결정 최저가다. result_min_price 는 감사 전용이다.
 */
export const FROZEN_ROWS_SQL = `
  select ${frozenFeatureSelectSql('f')},
         ar.min_price::float8 as result_min_price,
         (ar.dxdy_date is not null) as matched,
         ar.result_cd,
         ar.captured_at::text as result_captured_at,
         ot.evaluated_at::text as trust_evaluated_at,
         case when te.case_no is not null then 'trusted' end as outcome_trust_status,
         (
           te.case_no is not null
           and f.appraisal_value is not null
           and ar.dxdy_date is not null
           and ar.sold is not distinct from te.sold
           and ar.sold_amount is not distinct from te.sold_amount
           and ar.result_cd is not distinct from te.result_cd
         ) as label_trusted,
         case
           when te.case_no is not null
            and f.appraisal_value is not null
            and ar.dxdy_date is not null
            and ar.sold is not distinct from te.sold
            and ar.sold_amount is not distinct from te.sold_amount
            and ar.result_cd is not distinct from te.result_cd
           then te.sold
         end as sold,
         case
           when te.case_no is not null
            and f.appraisal_value is not null
            and ar.dxdy_date is not null
            and ar.sold is not distinct from te.sold
            and ar.sold_amount is not distinct from te.sold_amount
            and ar.result_cd is not distinct from te.result_cd
           then te.sold_amount::float8
         end as sold_amount,
         case
           when te.case_no is not null
            and f.appraisal_value is not null
            and ar.dxdy_date is not null
            and ar.sold is not distinct from te.sold
            and ar.sold_amount is not distinct from te.sold_amount
            and ar.result_cd is not distinct from te.result_cd
           then te.sale_ratio
         end as sale_ratio,
         d.probability::float8 as shadow_good_probability,
         d.model_version as shadow_good_model_version,
         d.label_version as shadow_good_label_version,
         d.scored_at::text as shadow_good_scored_at,
         ps.value::float8 as post_sale_value,
         ps.confirms as post_sale_confirms,
         ps.window_days as post_sale_window_days,
         ps.method_version as post_sale_method
    from gm_feature_snapshots f
    left join gm_auction_results ar
      on ar.court = f.court
     and ar.case_no = f.case_no
     and coalesce(nullif(ar.item_no, ''), '1') = f.item_no
     and ar.dxdy_date = f.sale_date
     and ar.kind_cd = '01'
    left join gm_trusted_outcome_eval te
      on te.court = f.court
     and te.case_no = f.case_no
     and coalesce(nullif(te.item_no, ''), '1') = f.item_no
     and te.sale_date = f.sale_date
     and te.appraisal_value is not distinct from f.appraisal_value
    left join gm_outcome_trust ot
      on ot.court = f.court
     and ot.case_no = f.case_no
     and coalesce(nullif(ot.item_no, ''), '1') = f.item_no
     and ot.sale_date = f.sale_date
    left join gm_decision_probabilities d
      on d.court = f.court
     and d.case_no = f.case_no
     and d.item_no = f.item_no
     and d.sale_date = f.sale_date
     and d.horizon_days = f.horizon_days
     and d.model_name = '${GOOD_LISTING_MODEL_NAME}'
     and d.model_version = '${GOOD_LISTING_DECISION_VERSION}'
     and d.label_version = '${GOOD_LISTING_DECISION_LABEL}'
     and d.feature_snapped_at = f.snapped_at
     and (d.scored_at at time zone 'Asia/Seoul')::date = f.observed_on
     and d.scored_at >= f.snapped_at
    left join gm_post_sale_values ps
      on ps.court = f.court
     and ps.case_no = f.case_no
     and coalesce(nullif(ps.item_no, ''), '1') = f.item_no
     and ps.sale_date = f.sale_date
   order by f.sale_date, f.horizon_days, f.court, f.case_no, f.item_no`;

/** 판단 학습 행. $1 은 관측일(KST). 라벨은 label_trusted 만 본다. outcome_trust_status 로 넓히지 않는다. */
export function frozenTrainingSql(): string {
  return `
    select *
      from (
        ${FROZEN_ROWS_SQL}
      ) frozen_rows
     where fully_frozen is true
       and comparison_eligible is true
       and label_trusted is true
       and snapshot_version = '${FEATURE_SNAPSHOT_VERSION}'
       and (
         (feature_source = 'd7' and horizon_days = 7)
         or (feature_source = 'd1' and horizon_days = 1)
       )
       and coalesce(observed_on::date, snapped_at_kst::date) < sale_date::date
       and sale_date::date < $1::date
       and result_captured_at is not null
       and trust_evaluated_at is not null
       and assumed_amount is not null
       and recommended_bid is not null
       and sold is true
       and sold_amount > 0
       and result_cd = '001'`;
}

export const FROZEN_EXPORT_COLUMNS = [
  'court', 'case_no', 'item_no', 'sale_date', 'horizon_days', 'days_to_sale', 'listing_id',
  'observed_on', 'snapped_at', 'snapped_at_kst', 'snapshot_version', 'feature_source', 'fully_frozen',
  'address', 'property_type', 'appraisal_value', 'price_floor', 'min_bid_price', 'result_min_price',
  'recommended_bid', 'hard_cap_bid', 'conservative_value', 'precision_status', 'precision_confidence',
  'confidence', 'precision_evaluator_version', 'target_margin_pct', 'target_margin_source',
  'assumed_amount', 'fixed_costs', 'acq_tax', 'acq_tax_rate_pct', 'move_out_cost', 'bond_cost',
  'etc_cost', 'cost_bid_price', 'cost_bid_basis', 'costs_captured', 'shortlist_eligible', 'comparison_eligible',
  'trust_status', 'trust_score', 'trust_evaluator_version', 'area_m2', 'building_area_m2',
  'is_collective_building', 'fail_count', 'inq_cnt', 'interest_cnt', 'risk_grade',
  'has_opposition_tenant', 'max_safe_bid', 'market_price', 'market_confidence',
  'avm_value', 'avm_low', 'avm_high', 'avm_basis', 'avm_kind', 'avm_model_version', 'avm_as_of',
  'avm_available', 'avm_building_comps', 'reason_codes', 'matched', 'sold', 'sold_amount', 'result_cd',
  'result_captured_at', 'trust_evaluated_at',
  'outcome_trust_status', 'label_trusted', 'sale_ratio', 'shadow_good_probability',
  'shadow_good_model_version', 'shadow_good_label_version', 'shadow_good_scored_at',
  'post_sale_value', 'post_sale_confirms', 'post_sale_window_days', 'post_sale_method',
] as const;

const EXPLORATORY_EMPTY_COLUMNS = [
  'case_no', 'item_no', 'sale_date', 'property_type', 'court', 'address', 'appraisal_value',
  'expected_bid', 'market_price', 'min_bid_price', 'input_min_bid_price', 'result_min_price',
  'total_score', 'passed_filter', 'recommendation', 'true_margin', 'max_safe_bid', 'inq_cnt',
  'interest_cnt', 'fail_count', 'area_m2', 'building_area_m2', 'is_collective_building',
  'market_confidence', 'sold', 'sold_amount', 'result_cd', 'matched', 'residual', 'residual_pct',
  'sale_ratio', 'would_have_won_under_max_safe_bid', 'realized_bid_margin', 'risk_grade',
  'assumed_amount', 'has_opposition_tenant', 'feature_source', 'avm_value', 'avm_low', 'avm_high',
  'avm_basis', 'avm_building_comps', 'move_out_cost', 'bond_cost', 'shadow_good_probability',
  'shadow_good_version',
];

function writeDataset(path: string, rows: Record<string, Cell>[], emptyColumns: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const columns = rows.length ? Object.keys(rows[0]!) : [...emptyColumns];
  const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n';
  writeFileSync(path, csv);
}

async function main(): Promise<void> {
  const selection = exportSelection(process.argv);
  try {
    if (selection.exploratory) {
      const rows = await query<Record<string, Cell>>(TRAINING_ROWS_SQL);
      writeDataset(selection.exploratoryPath, rows, EXPLORATORY_EMPTY_COLUMNS);
      console.log(`[ml:export] ${rows.length} rows -> ${selection.exploratoryPath}`);
    }
    if (selection.frozen) {
      const rows = await query<Record<string, Cell>>(FROZEN_ROWS_SQL);
      writeDataset(selection.frozenPath, rows, FROZEN_EXPORT_COLUMNS);
      console.log(`[ml:export] frozen ${rows.length} rows -> ${selection.frozenPath}`);
    }
  } finally {
    await pool().end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('ml export 실패:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
