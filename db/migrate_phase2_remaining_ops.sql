create table if not exists gm_result_retry_status (
  case_no text not null,
  item_no text not null default '1',
  sale_date date not null,
  attempts int not null default 0,
  last_status text not null default 'pending',
  last_phase text,
  last_error text,
  last_http_status int,
  captcha_detected boolean not null default false,
  blocked_reason text,
  last_round_count int not null default 0,
  last_attempted_at timestamptz,
  succeeded_at timestamptz,
  primary key (case_no, item_no, sale_date),
  check (last_status in ('pending','success','empty','blocked','error'))
);

create index if not exists gm_result_retry_status_status_idx on gm_result_retry_status (last_status, last_attempted_at desc);

create table if not exists gm_shadow_scores (
  id bigint generated always as identity primary key,
  case_no text not null,
  item_no text not null default '1',
  sale_date date not null,
  model_name text not null,
  model_version text not null,
  predicted_sale_ratio double precision not null,
  confidence double precision,
  feature_snapshot_hash text not null,
  features jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (case_no, item_no, sale_date, model_name, model_version),
  check (predicted_sale_ratio > 0),
  check (confidence is null or (confidence >= 0 and confidence <= 1))
);

create index if not exists gm_shadow_scores_case_sale_idx on gm_shadow_scores (case_no, item_no, sale_date);
create index if not exists gm_shadow_scores_model_idx on gm_shadow_scores (model_name, model_version, created_at desc);

create or replace view gm_result_retry_queue as
  select e.case_no, coalesce(nullif(e.item_no,''),'1') as item_no, e.sale_date, e.court, e.property_type, e.address,
         (current_date - e.sale_date)::int as days_overdue,
         e.total_score, e.passed_filter, e.recommendation, e.expected_bid, e.min_bid_price, e.inq_cnt, e.interest_cnt,
         coalesce(rs.attempts, 0) as retry_attempts,
         rs.last_status as retry_last_status,
         rs.last_attempted_at as retry_last_attempted_at,
         case
           when e.sale_date < current_date - 14 then 100
           when e.passed_filter then 80
           when e.total_score >= 70 then 70
           else 50
         end as retry_priority
    from gm_outcome_eval e
    left join gm_result_retry_status rs
      on rs.case_no = e.case_no
     and rs.item_no = coalesce(nullif(e.item_no,''),'1')
     and rs.sale_date = e.sale_date
   where e.sale_date < current_date
     and e.matched = false
     and coalesce(rs.last_status, 'pending') <> 'success'
     and (rs.last_attempted_at is null or rs.last_attempted_at < now() - interval '24 hours')
   order by retry_priority desc, e.sale_date desc, e.case_no, item_no;

create or replace view gm_shadow_score_eval as
  select s.id, s.case_no, s.item_no, s.sale_date, s.model_name, s.model_version,
         s.predicted_sale_ratio, s.confidence, s.feature_snapshot_hash, s.created_at,
         e.property_type, e.court, e.address, e.appraisal_value, e.matched, e.sold,
         e.sold_amount, e.sale_ratio, e.realized_bid_margin,
         case when e.sale_ratio is not null then s.predicted_sale_ratio - e.sale_ratio end as sale_ratio_error,
         case when e.sale_ratio is not null then abs(s.predicted_sale_ratio - e.sale_ratio) end as abs_sale_ratio_error,
         (e.sale_date <= current_date - 14) as eligible_for_review
    from gm_shadow_scores s
    left join gm_trusted_outcome_eval e
      on e.case_no = s.case_no
     and coalesce(nullif(e.item_no,''),'1') = s.item_no
     and e.sale_date = s.sale_date;
