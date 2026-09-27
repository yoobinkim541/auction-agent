/**
 * 예측 스냅샷(학습 Phase 0) — 매각 임박(D-0~D-LEAD) 매물의 현재 예측을 gm_prediction_snapshots에 동결.
 * analyze --all 이 점수/리포트를 매번 덮어쓰므로, 매각 직전 예측을 저장해야 사후 실제결과와 비교 가능.
 * on conflict 갱신 → 매일 돌면 '매각에 가장 가까운 예측'이 남고, 매각기일이 지나면 자동 동결.
 * 사용: npm run snapshot   (SNAPSHOT_LEAD_DAYS 기본 3)
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';

async function main(): Promise<void> {
  const lead = Number(process.env.SNAPSHOT_LEAD_DAYS) || 3;
  const rows = await query<{ n: number }>(
    `insert into gm_prediction_snapshots
       (case_no,item_no,sale_date,appraisal_value,expected_bid,market_price,min_bid_price,total_score,passed_filter,recommendation,true_margin,max_safe_bid,inq_cnt,interest_cnt,snapped_at)
     select l.case_no, coalesce(l.item_no,'1'), l.sale_date,
            l.appraisal_value::bigint, loc.expected_bid_price::bigint, loc.market_price::bigint, l.min_bid_price::bigint,
            s.total_score::int, s.passed_filter, loc.report->>'recommendation',
            (loc.acquisition_cost->>'trueSafetyMargin')::float8, r.max_safe_bid, l.inq_cnt, l.interest_cnt, now()
       from gm_listings l
       join gm_location_analysis loc on loc.listing_id = l.id
       join gm_scores s on s.listing_id = l.id
       left join gm_rights_analysis r on r.listing_id = l.id
      where l.sale_date >= current_date and l.sale_date <= current_date + $1::int
     on conflict (case_no,item_no,sale_date) do update set
       appraisal_value=excluded.appraisal_value, expected_bid=excluded.expected_bid, market_price=excluded.market_price, min_bid_price=excluded.min_bid_price,
       total_score=excluded.total_score, passed_filter=excluded.passed_filter, recommendation=excluded.recommendation,
       true_margin=excluded.true_margin, max_safe_bid=excluded.max_safe_bid, inq_cnt=excluded.inq_cnt, interest_cnt=excluded.interest_cnt, snapped_at=now()
     returning 1 as n`,
    [lead],
  );
  console.log(`[snapshot] 매각 임박(D-0~D-${lead}) 예측 ${rows.length}건 스냅샷`);
  await pool().end();
}

main().catch((e) => { console.error('snapshot 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
