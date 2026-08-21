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

commit;
