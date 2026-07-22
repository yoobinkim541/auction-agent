-- Phase2 profit-aware feedback fields.

alter table gm_prediction_snapshots
  add column if not exists max_safe_bid bigint;

drop view if exists gm_outcome_eval;

create view gm_outcome_eval as
  with L as (
    select distinct on (case_no, coalesce(item_no,'1')) case_no, coalesce(item_no,'1') item_no,
           property_type, court, address, appraisal_value
      from gm_listings order by case_no, coalesce(item_no,'1'), crawled_at desc nulls last
  )
  select s.case_no, s.item_no, s.sale_date,
         l.property_type, l.court, l.address, l.appraisal_value,
         s.expected_bid, s.market_price, s.min_bid_price, s.total_score, s.passed_filter,
         s.recommendation, s.true_margin, s.max_safe_bid, s.inq_cnt, s.interest_cnt,
         r.sold, r.sold_amount, r.result_cd, r.min_price as result_min_price,
         (r.dxdy_date is not null) as matched,
         case when r.sold then r.sold_amount - s.expected_bid end as residual,
         case when r.sold and s.expected_bid > 0 then (r.sold_amount - s.expected_bid)::float8 / s.expected_bid end as residual_pct,
         case when r.sold and l.appraisal_value > 0 then r.sold_amount::float8 / l.appraisal_value end as sale_ratio,
         case when r.sold and s.max_safe_bid is not null then r.sold_amount <= s.max_safe_bid end as would_have_won_under_max_safe_bid,
         case when r.sold and s.market_price > 0 then (s.market_price - r.sold_amount)::float8 / s.market_price end as realized_bid_margin
    from gm_prediction_snapshots s
    join L l on l.case_no = s.case_no and l.item_no = s.item_no
    left join gm_auction_results r on r.case_no = s.case_no and r.item_no = s.item_no and r.dxdy_date = s.sale_date;
