/**
 * 예측 스냅샷(학습 Phase 0) — 매각 전 상태를 두 원장에 남긴다. 날짜는 모두 KST 기준이다.
 *   (법원 기일은 KST 날짜인데 일일 배치는 21:00 UTC = 다음 날 06:00 KST에 돈다. UTC 날짜로 창을 잡으면
 *    이미 끝난 기일의 스냅샷을 매각 뒤에 덮어쓴다.)
 *
 * 1) gm_prediction_snapshots — 매각 임박(D-0~D-LEAD) 매물의 현재 예측. on conflict 갱신이라 매일 돌면
 *    '매각에 가장 가까운 예측'(매각 당일 아침)이 남고, 기일이 지나면 동결된다.
 * 2) gm_feature_snapshots — 학습 입력의 시점 고정본. D-1(잔여 1일)과 D-7(잔여 2~7일 중 첫 기록)에
 *    한 번만 쓰고 덮어쓰지 않는다. feature-v2 는 그날의 입찰·상한·목표 마진·숏리스트·비용·AVM 출처를
 *    같이 얼린다. snapshot_version 이 비어 있는 과거 행은 승격하지 않고, 나중 모델로 메우지 않는다.
 *
 * 사용:
 *   npm run snapshot                         예측 + 시점 고정 (수동 기본값)
 *   npm run snapshot -- --predictions-only   예측만. 일일 파싱이 결과 수집 전에 호출한다
 *   npm run snapshot -- --features-only      시점 고정만. 정밀 갱신·감사 성공 뒤에 호출한다
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { query, pool } from '../shared/db.ts';
import { EVALUATOR_DEFAULT_TARGET_MARGIN_PCT } from '../pipeline/precision/evaluate.ts';

/** 새로 얼리는 행의 출처. 과거 행은 null 이고, 이 값으로 소급하지 않는다. */
export const FEATURE_SNAPSHOT_VERSION = 'feature-v2';

export function kstToday(now = Date.now()): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function parseSnapshotMode(argv: readonly string[]): { predictions: boolean; features: boolean } {
  const predictionsOnly = argv.includes('--predictions-only');
  const featuresOnly = argv.includes('--features-only');
  if (predictionsOnly && featuresOnly) {
    throw new Error('snapshot: --predictions-only 와 --features-only 는 함께 쓸 수 없습니다');
  }
  if (predictionsOnly) return { predictions: true, features: false };
  if (featuresOnly) return { predictions: false, features: true };
  return { predictions: true, features: true };
}

/**
 * 새로 얼리는 목표 마진. 라이브 평가기는 PRECISION_TARGET_MARGIN_PCT 를 읽지 않는다.
 * 호출자가 마진을 넘기지 않으면 pipeline/precision/evaluate.ts 의 공유 기본값을 쓴다.
 */
export { EVALUATOR_DEFAULT_TARGET_MARGIN_PCT };

/** 동결에 쓰는 AVM. 이 버전만, 관측일 이전 as_of 와 현재 시각 이전 created_at 만 복사한다. */
export const FROZEN_AVM_MODEL_VERSION = 'avm-v3';

const MONEY_KEY = '^-?[0-9]+(\\.[0-9]+)?$';

function jsonMoney(key: string): string {
  const raw = `nullif(loc.acquisition_cost->>'${key}', '')`;
  return `case when ${raw} ~ '${MONEY_KEY}' then round((${raw})::numeric)::bigint end`;
}

function jsonRate(key: string): string {
  const raw = `nullif(loc.acquisition_cost->>'${key}', '')`;
  return `case when ${raw} ~ '${MONEY_KEY}' then (${raw})::numeric end`;
}

function costsCapturedSql(): string {
  const keys = ['acqTax', 'acqTaxRatePct', 'moveOutCost', 'bondCost', 'etcCost', 'bidPrice'];
  return keys.map((key) => `nullif(loc.acquisition_cost->>'${key}', '') ~ '${MONEY_KEY}'`).join('\n     and ');
}

/** v2 승격 조건. 하나라도 비면 과거 행이다. 비용은 '조회함'이 true 여야 하고, 금액이 0이어도 된다. */
export function fullyFrozenSql(alias = 'f'): string {
  return `(${alias}.snapshot_version = '${FEATURE_SNAPSHOT_VERSION}'
    and ${alias}.observed_on is not null
    and ${alias}.target_margin_pct is not null
    and ${alias}.target_margin_source is not null
    and ${alias}.shortlist_eligible is not null
    and ${alias}.comparison_eligible is not null
    and ${alias}.avm_available is not null
    and ${alias}.costs_captured is true)`;
}

export const PREDICTION_SNAPSHOT_SQL = `
  insert into gm_prediction_snapshots
    (court,case_no,item_no,sale_date,appraisal_value,expected_bid,market_price,min_bid_price,total_score,passed_filter,recommendation,true_margin,max_safe_bid,inq_cnt,interest_cnt,snapped_at)
  select distinct on (l.court, l.case_no, coalesce(nullif(l.item_no,''),'1'), l.sale_date)
         l.court, l.case_no, coalesce(nullif(l.item_no,''),'1'), l.sale_date,
         l.appraisal_value::bigint, loc.expected_bid_price::bigint, loc.market_price::bigint, l.min_bid_price::bigint,
         s.total_score::int, s.passed_filter, loc.report->>'recommendation',
         (loc.acquisition_cost->>'trueSafetyMargin')::float8, r.max_safe_bid, l.inq_cnt, l.interest_cnt, now()
    from gm_listings l
    join gm_location_analysis loc on loc.listing_id = l.id
    join gm_scores s on s.listing_id = l.id
    left join gm_rights_analysis r on r.listing_id = l.id
   where l.sale_date >= $2::date and l.sale_date <= $2::date + $1::int
   order by l.court, l.case_no, coalesce(nullif(l.item_no,''),'1'), l.sale_date, l.crawled_at desc nulls last, l.id desc
  on conflict (court,case_no,item_no,sale_date) do update set
    appraisal_value=excluded.appraisal_value, expected_bid=excluded.expected_bid, market_price=excluded.market_price, min_bid_price=excluded.min_bid_price,
    total_score=excluded.total_score, passed_filter=excluded.passed_filter, recommendation=excluded.recommendation,
    true_margin=excluded.true_margin, max_safe_bid=excluded.max_safe_bid, inq_cnt=excluded.inq_cnt, interest_cnt=excluded.interest_cnt, snapped_at=now()
  returning 1 as n`;

/**
 * 순위 비교·섀도 학습 후보군. gm_precision_shortlist 의 eligible 게이트와 같고, 상태만 conditional 도 받는다.
 * 사건 대표 1건 선택(case_rank)은 하지 않는다. 운영 뷰는 바꾸지 않는다.
 */
export const COMPARISON_ELIGIBLE_SQL = `coalesce((
           p.status in ('recommended', 'conditional')
           and t.status = 'trusted'
           and p.evaluated_at >= l.crawled_at
           and t.evaluated_at >= l.crawled_at
           and r.analyzed_at >= l.crawled_at
           and loc.analyzed_at >= l.crawled_at
           and r.assumed_amount = 0
           and coalesce(loc.report->>'recommendation', '') <> 'avoid'
           and p.hard_cap_bid >= l.min_bid_price
           and p.recommended_bid is not null
           and p.recommended_bid >= l.min_bid_price
           and p.recommended_bid <= p.hard_cap_bid
         ), false)`;

/**
 * D-1/D-7 입력 동결. 충돌하면 아무것도 하지 않는다.
 * 비용은 취득세+명도+채권+기타만 얼린다. 입찰가와 인수금액은 빠지고, 비용 객체가 없으면 null 이다.
 * AVM 은 그 순간의 model_version·as_of 만 복사한다. 나중 버전으로 다시 쓰지 않는다.
 * 숏리스트는 그날의 gm_precision_shortlist(신선도 포함)에 listing_id 가 있는지로 얼린다.
 * 비교 후보군은 COMPARISON_ELIGIBLE_SQL 로 같은 순간에 얼린다.
 */
export const FEATURE_SNAPSHOT_SQL = `
  insert into gm_feature_snapshots
    (case_no, item_no, sale_date, horizon_days, days_to_sale, listing_id,
     property_type, court, appraisal_value, min_bid_price, fail_count, area_m2, building_area_m2,
     is_collective_building, inq_cnt, interest_cnt, listing_crawled_at,
     risk_grade, assumed_amount, max_safe_bid, has_opposition_tenant, tenant_count, red_flag_count, rights_analyzed_at,
     market_price, market_confidence, comp_basis, comp_count, expected_bid, safety_margin, true_margin,
     recommendation, location_analyzed_at,
     total_score, passed_filter,
     precision_status, precision_confidence, conservative_value, recommended_bid, hard_cap_bid, reason_codes,
     trust_status,
     address, source, snapshot_version, observed_on, target_margin_pct, target_margin_source,
     price_floor, shortlist_eligible, comparison_eligible, precision_evaluator_version, trust_score, trust_evaluator_version,
     fixed_costs, acq_tax, acq_tax_rate_pct, move_out_cost, bond_cost, etc_cost, cost_bid_price, cost_bid_basis,
     costs_captured,
     avm_value, avm_low, avm_high, avm_basis, avm_kind, avm_model_version, avm_as_of, avm_available,
     avm_building_comps, avm_dong_comps)
  select distinct on (l.court, l.case_no, coalesce(nullif(l.item_no, ''), '1'), l.sale_date)
         l.case_no, coalesce(nullif(l.item_no, ''), '1'), l.sale_date,
         case when l.sale_date - $1::date = 1 then 1 else 7 end, l.sale_date - $1::date, l.id,
         l.property_type, l.court, l.appraisal_value, l.min_bid_price, l.fail_count, l.area_m2, l.building_area_m2,
         l.is_collective_building, l.inq_cnt, l.interest_cnt, l.crawled_at,
         r.risk_grade, r.assumed_amount, r.max_safe_bid,
         exists (
           select 1
             from jsonb_array_elements(case when jsonb_typeof(r.tenants) = 'array' then r.tenants else '[]'::jsonb end) tenant
            where coalesce((tenant->>'hasOpposition')::boolean, false)
         ),
         case when jsonb_typeof(r.tenants) = 'array' then jsonb_array_length(r.tenants) end,
         case when jsonb_typeof(r.red_flags) = 'array' then jsonb_array_length(r.red_flags) end,
         r.analyzed_at,
         loc.market_price, loc.market_confidence, loc.comp_basis,
         case when jsonb_typeof(loc.comps) = 'array' then jsonb_array_length(loc.comps) end,
         loc.expected_bid_price, loc.safety_margin, (loc.acquisition_cost->>'trueSafetyMargin')::float8,
         loc.report->>'recommendation', loc.analyzed_at,
         s.total_score, s.passed_filter,
         p.status, p.confidence, p.conservative_value, p.recommended_bid, p.hard_cap_bid, p.reason_codes,
         t.status,
         l.address,
         case when l.sale_date - $1::date = 1 then 'd1' else 'd7' end,
         $4,
         $1::date,
         $2::numeric,
         $3,
         l.min_bid_price,
         exists (select 1 from gm_precision_shortlist sl where sl.listing_id = l.id),
         ${COMPARISON_ELIGIBLE_SQL},
         p.evaluator_version,
         t.score,
         t.evaluator_version,

         case
           when nullif(loc.acquisition_cost->>'acqTax', '') ~ '${MONEY_KEY}'
            and nullif(loc.acquisition_cost->>'moveOutCost', '') ~ '${MONEY_KEY}'
            and nullif(loc.acquisition_cost->>'bondCost', '') ~ '${MONEY_KEY}'
            and nullif(loc.acquisition_cost->>'etcCost', '') ~ '${MONEY_KEY}'
           then round((
             (loc.acquisition_cost->>'acqTax')::numeric
             + (loc.acquisition_cost->>'moveOutCost')::numeric
             + (loc.acquisition_cost->>'bondCost')::numeric
             + (loc.acquisition_cost->>'etcCost')::numeric
           ))::bigint
         end,
         ${jsonMoney('acqTax')},
         ${jsonRate('acqTaxRatePct')},
         ${jsonMoney('moveOutCost')},
         ${jsonMoney('bondCost')},
         ${jsonMoney('etcCost')},
         ${jsonMoney('bidPrice')},
         loc.acquisition_cost->>'bidBasis',
         (${costsCapturedSql()}),
         a.value, a.value_low, a.value_high, a.basis, a.kind, a.model_version, a.as_of,
         (a.court is not null),
         a.building_comps, a.dong_comps
    from gm_listings l
    join gm_location_analysis loc on loc.listing_id = l.id
    join gm_scores s on s.listing_id = l.id
    left join gm_rights_analysis r on r.listing_id = l.id
    left join gm_precision_evaluations p on p.listing_id = l.id
    left join gm_data_trust t on t.listing_id = l.id
    left join gm_avm_estimates a
      on a.court = l.court
     and a.case_no = l.case_no
     and a.item_no = coalesce(nullif(l.item_no, ''), '1')
     and a.sale_date = l.sale_date
     and a.model_version = '${FROZEN_AVM_MODEL_VERSION}'
     and a.as_of <= $1::date
     and a.created_at <= now()
   where l.sale_date - $1::date between 1 and 7
   order by l.court, l.case_no, coalesce(nullif(l.item_no, ''), '1'), l.sale_date,
            (exists (select 1 from gm_precision_shortlist sl where sl.listing_id = l.id)) desc,
            ${COMPARISON_ELIGIBLE_SQL} desc,
            l.crawled_at desc nulls last, l.id desc,
            p.evaluated_at desc nulls last,
            a.as_of desc nulls last
  on conflict (court, case_no, item_no, sale_date, horizon_days) do nothing
  returning horizon_days`;

async function main(): Promise<void> {
  const mode = parseSnapshotMode(process.argv);
  const today = kstToday();
  try {
    if (mode.predictions) {
      const lead = Number(process.env.SNAPSHOT_LEAD_DAYS) || 3;
      const rows = await query<{ n: number }>(PREDICTION_SNAPSHOT_SQL, [lead, today]);
      console.log(`[snapshot] 매각 임박(D-0~D-${lead}) 예측 ${rows.length}건 스냅샷`);
    }
    if (mode.features) {
      const features = await query<{ horizon_days: number }>(FEATURE_SNAPSHOT_SQL, [
        today,
        EVALUATOR_DEFAULT_TARGET_MARGIN_PCT,
        'evaluator-default',
        FEATURE_SNAPSHOT_VERSION,
      ]);
      const d1 = features.filter((row) => row.horizon_days === 1).length;
      console.log(`[snapshot] 시점 고정 입력 신규 ${features.length}건 (D-7 ${features.length - d1} · D-1 ${d1}, margin evaluator-default ${EVALUATOR_DEFAULT_TARGET_MARGIN_PCT})`);
    }
  } finally {
    await pool().end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('snapshot 실패:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
