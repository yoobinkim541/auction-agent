alter table if exists gm_prediction_snapshots
  add column if not exists appraisal_value bigint;

alter table if exists gm_outcome_trust
  add column if not exists sold boolean not null default false,
  add column if not exists appraisal_value bigint,
  add column if not exists sold_amount bigint;

alter table if exists gm_shadow_scores
  add column if not exists conservative_sale_ratio double precision;

do $$
begin
  if to_regclass('gm_shadow_scores') is not null
     and not exists (
       select 1 from pg_constraint
        where conname = 'gm_shadow_scores_conservative_ratio_positive'
          and conrelid = 'gm_shadow_scores'::regclass
     ) then
    alter table gm_shadow_scores
      add constraint gm_shadow_scores_conservative_ratio_positive
      check (conservative_sale_ratio is null or conservative_sale_ratio > 0);
  end if;
end
$$;

create or replace view gm_outcome_eval as
  with L as (
    select distinct on (case_no, coalesce(item_no,'1')) case_no, coalesce(item_no,'1') item_no,
           property_type, court, address, appraisal_value
      from gm_listings order by case_no, coalesce(item_no,'1'), crawled_at desc nulls last
  )
  select s.case_no, s.item_no, s.sale_date,
         l.property_type, l.court, l.address, coalesce(s.appraisal_value, l.appraisal_value) as appraisal_value,
         s.expected_bid, s.market_price, s.min_bid_price, s.total_score, s.passed_filter,
         s.recommendation, s.true_margin, s.max_safe_bid, s.inq_cnt, s.interest_cnt,
         r.sold, r.sold_amount, r.result_cd, r.min_price as result_min_price,
         (r.dxdy_date is not null) as matched,
         case when r.sold then r.sold_amount - s.expected_bid end as residual,
         case when r.sold and s.expected_bid > 0 then (r.sold_amount - s.expected_bid)::float8 / s.expected_bid end as residual_pct,
         case when r.sold and coalesce(s.appraisal_value, l.appraisal_value) > 0
              then r.sold_amount::float8 / coalesce(s.appraisal_value, l.appraisal_value) end as sale_ratio,
         case when r.sold and s.max_safe_bid is not null then r.sold_amount <= s.max_safe_bid end as would_have_won_under_max_safe_bid,
         case when r.sold and s.market_price > 0 then (s.market_price - r.sold_amount)::float8 / s.market_price end as realized_bid_margin
    from gm_prediction_snapshots s
    join L l on l.case_no = s.case_no and l.item_no = s.item_no
    left join gm_auction_results r on r.case_no = s.case_no and r.item_no = s.item_no and r.dxdy_date = s.sale_date;

update gm_outcome_trust t
   set sold = coalesce(e.sold, false),
       appraisal_value = e.appraisal_value,
       sold_amount = e.sold_amount
  from gm_outcome_eval e
 where t.case_no = e.case_no
   and t.item_no = coalesce(nullif(e.item_no, ''), '1')
   and t.sale_date = e.sale_date;

update gm_prediction_snapshots s
   set appraisal_value = t.appraisal_value
  from gm_outcome_trust t
 where s.case_no = t.case_no
   and s.item_no = t.item_no
   and s.sale_date = t.sale_date
   and s.appraisal_value is null
   and t.appraisal_value is not null;

create or replace view gm_trusted_outcome_eval as
  select e.*
    from gm_outcome_eval e
    join gm_outcome_trust t
      on t.case_no = e.case_no
     and t.item_no = coalesce(nullif(e.item_no, ''), '1')
     and t.sale_date = e.sale_date
   where t.status = 'trusted'
     and t.sold is not distinct from e.sold
     and t.appraisal_value is not distinct from e.appraisal_value
     and t.sold_amount is not distinct from e.sold_amount;

create or replace view gm_shadow_score_eval as
  select s.id, s.case_no, s.item_no, s.sale_date, s.model_name, s.model_version,
         s.predicted_sale_ratio, s.confidence, s.feature_snapshot_hash, s.created_at,
         e.property_type, e.court, e.address, e.appraisal_value, e.matched, e.sold,
         e.sold_amount, e.sale_ratio, e.realized_bid_margin,
         case when e.sale_ratio is not null then s.predicted_sale_ratio - e.sale_ratio end as sale_ratio_error,
         case when e.sale_ratio is not null then abs(s.predicted_sale_ratio - e.sale_ratio) end as abs_sale_ratio_error,
         (e.sale_date <= current_date - 14) as eligible_for_review,
         s.conservative_sale_ratio
    from gm_shadow_scores s
    left join gm_trusted_outcome_eval e
      on e.case_no = s.case_no
     and coalesce(nullif(e.item_no,''),'1') = s.item_no
     and e.sale_date = s.sale_date;
