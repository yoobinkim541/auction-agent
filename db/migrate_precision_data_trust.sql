begin;

create table if not exists gm_data_trust (
  listing_id bigint primary key references gm_listings(id) on delete cascade,
  status text not null check (status in ('trusted','hold','quarantined')),
  score int not null check (score between 0 and 100),
  reason_codes jsonb not null default '[]'::jsonb,
  checks jsonb not null default '{}'::jsonb,
  evaluator_version text not null,
  input_hash text not null,
  evaluated_at timestamptz not null default now()
);

create table if not exists gm_outcome_trust (
  case_no text not null, item_no text not null, sale_date date not null,
  status text not null check (status in ('trusted','hold','quarantined')),
  sale_ratio numeric, reason_codes jsonb not null default '[]'::jsonb,
  checks jsonb not null default '{}'::jsonb, evaluator_version text not null,
  evaluated_at timestamptz not null default now(),
  primary key (case_no,item_no,sale_date)
);

create or replace view gm_trusted_outcome_eval as
  select e.*
    from gm_outcome_eval e
    join gm_outcome_trust t
      on t.case_no = e.case_no
     and t.item_no = coalesce(nullif(e.item_no, ''), '1')
     and t.sale_date = e.sale_date
   where t.status = 'trusted';

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
      from gm_trusted_outcome_eval
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

commit;
