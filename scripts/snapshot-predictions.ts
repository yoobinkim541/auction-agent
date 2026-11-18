/**
 * 예측 스냅샷(학습 Phase 0) — 매각 전 상태를 두 원장에 남긴다. 날짜는 모두 KST 기준이다.
 *   (법원 기일은 KST 날짜인데 일일 배치는 21:00 UTC = 다음 날 06:00 KST에 돈다. UTC 날짜로 창을 잡으면
 *    이미 끝난 기일의 스냅샷을 매각 뒤에 덮어쓴다.)
 *
 * 1) gm_prediction_snapshots — 매각 임박(D-0~D-LEAD) 매물의 현재 예측. on conflict 갱신이라 매일 돌면
 *    '매각에 가장 가까운 예측'(매각 당일 아침)이 남고, 기일이 지나면 동결된다.
 * 2) gm_feature_snapshots — 학습 입력의 시점 고정본. D-1(잔여 1일)과 D-7(잔여 2~7일 중 첫 기록)에
 *    한 번만 쓰고 덮어쓰지 않는다.
 * 사용: npm run snapshot   (SNAPSHOT_LEAD_DAYS 기본 3)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';

async function main(): Promise<void> {
  const lead = Number(process.env.SNAPSHOT_LEAD_DAYS) || 3;
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST
  const rows = await query<{ n: number }>(
    `insert into gm_prediction_snapshots
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
     returning 1 as n`,
    [lead, today],
  );
  console.log(`[snapshot] 매각 임박(D-0~D-${lead}) 예측 ${rows.length}건 스냅샷`);

  const features = await query<{ horizon_days: number }>(
    `insert into gm_feature_snapshots
       (case_no, item_no, sale_date, horizon_days, days_to_sale, listing_id,
        property_type, court, appraisal_value, min_bid_price, fail_count, area_m2, building_area_m2,
        is_collective_building, inq_cnt, interest_cnt, listing_crawled_at,
        risk_grade, assumed_amount, max_safe_bid, has_opposition_tenant, tenant_count, red_flag_count, rights_analyzed_at,
        market_price, market_confidence, comp_basis, comp_count, expected_bid, safety_margin, true_margin,
        recommendation, location_analyzed_at,
        total_score, passed_filter,
        precision_status, precision_confidence, conservative_value, recommended_bid, hard_cap_bid, reason_codes,
        trust_status)
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
            t.status
       from gm_listings l
       join gm_location_analysis loc on loc.listing_id = l.id
       join gm_scores s on s.listing_id = l.id
       left join gm_rights_analysis r on r.listing_id = l.id
       left join gm_precision_evaluations p on p.listing_id = l.id
       left join gm_data_trust t on t.listing_id = l.id
      where l.sale_date - $1::date between 1 and 7
      order by l.court, l.case_no, coalesce(nullif(l.item_no, ''), '1'), l.sale_date, l.crawled_at desc nulls last, l.id desc
     on conflict (court, case_no, item_no, sale_date, horizon_days) do nothing
     returning horizon_days`,
    [today],
  );
  const d1 = features.filter((f) => f.horizon_days === 1).length;
  console.log(`[snapshot] 시점 고정 입력 신규 ${features.length}건 (D-7 ${features.length - d1} · D-1 ${d1})`);
  await pool().end();
}

main().catch((e) => { console.error('snapshot 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
