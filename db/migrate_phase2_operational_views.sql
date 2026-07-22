-- Phase2 operational review/cache views.

create or replace view gm_ml_price_calibration as
  with sold as (
    select property_type,
           case
             when split_part(address, ' ', 1) in ('서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시')
               then split_part(address, ' ', 1) || ' ' || split_part(address, ' ', 2)
             when split_part(address, ' ', 1) like '%도'
               then split_part(address, ' ', 1) || ' ' || split_part(address, ' ', 2)
             else split_part(address, ' ', 1)
           end as region,
           sale_ratio,
           realized_bid_margin
      from gm_outcome_eval
     where sale_date < current_date
       and sold
       and sale_ratio is not null
  )
  select property_type, region,
         count(*)::int as sample_size,
         percentile_cont(0.5) within group (order by sale_ratio) as median_sale_ratio,
         percentile_cont(0.5) within group (order by realized_bid_margin) as median_realized_margin
    from sold
   group by property_type, region
  having count(*) >= 5;

create or replace view gm_result_retry_queue as
  select case_no, coalesce(nullif(item_no,''),'1') as item_no, sale_date, court, property_type, address,
         (current_date - sale_date)::int as days_overdue,
         total_score, passed_filter, recommendation, expected_bid, min_bid_price, inq_cnt, interest_cnt,
         case
           when sale_date < current_date - 14 then 100
           when passed_filter then 80
           when total_score >= 70 then 70
           else 50
         end as retry_priority
    from gm_outcome_eval
   where sale_date < current_date
     and matched = false
   order by retry_priority desc, sale_date desc, case_no, item_no;

create or replace view gm_rights_risk_eval as
  with latest_listing as (
    select distinct on (case_no, coalesce(nullif(item_no,''),'1'))
           id as listing_id, case_no, coalesce(nullif(item_no,''),'1') as item_no
      from gm_listings
     order by case_no, coalesce(nullif(item_no,''),'1'), crawled_at desc nulls last
  )
  select e.case_no, coalesce(nullif(e.item_no,''),'1') as item_no, e.sale_date, e.matched, e.sold,
         e.sold_amount, e.sale_ratio, e.realized_bid_margin, e.would_have_won_under_max_safe_bid,
         r.risk_grade, r.assumed_amount, r.max_safe_bid,
         jsonb_array_length(coalesce(r.tenants, '[]'::jsonb)) as tenant_count,
         exists (
           select 1 from jsonb_array_elements(coalesce(r.tenants, '[]'::jsonb)) t
            where coalesce((t->>'hasOpposition')::boolean, false)
         ) as has_opposition_tenant,
         jsonb_array_length(coalesce(r.red_flags, '[]'::jsonb)) as red_flag_count
    from gm_outcome_eval e
    left join latest_listing l on l.case_no = e.case_no and l.item_no = coalesce(nullif(e.item_no,''),'1')
    left join gm_rights_analysis r on r.listing_id = l.listing_id
   where e.sale_date < current_date;
