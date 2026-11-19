begin;

-- 시점 고정 입력 v2 — 기존 행은 비워 둔다. snapshot_version 을 소급하지 않는다.
-- 나중 AVM(avm-v3 포함)이나 나중 모델로 과거 동결 행을 메우지 않는다.
alter table gm_feature_snapshots
  add column if not exists address text,
  add column if not exists source text,
  add column if not exists snapshot_version text,
  add column if not exists observed_on date,
  add column if not exists target_margin_pct numeric,
  add column if not exists target_margin_source text,
  add column if not exists price_floor bigint,
  add column if not exists shortlist_eligible boolean,
  add column if not exists comparison_eligible boolean,
  add column if not exists precision_evaluator_version text,
  add column if not exists trust_score int,
  add column if not exists trust_evaluator_version text,
  add column if not exists fixed_costs bigint,
  add column if not exists acq_tax bigint,
  add column if not exists acq_tax_rate_pct numeric,
  add column if not exists move_out_cost bigint,
  add column if not exists bond_cost bigint,
  add column if not exists etc_cost bigint,
  add column if not exists cost_bid_price bigint,
  add column if not exists cost_bid_basis text,
  add column if not exists costs_captured boolean,
  add column if not exists avm_value bigint,
  add column if not exists avm_low bigint,
  add column if not exists avm_high bigint,
  add column if not exists avm_basis text,
  add column if not exists avm_kind text,
  add column if not exists avm_model_version text,
  add column if not exists avm_as_of date,
  add column if not exists avm_available boolean,
  add column if not exists avm_building_comps int,
  add column if not exists avm_dong_comps int;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'gm_feature_snapshots_target_margin_pct'
       and conrelid = 'gm_feature_snapshots'::regclass
  ) then
    alter table gm_feature_snapshots
      add constraint gm_feature_snapshots_target_margin_pct
      check (target_margin_pct is null or (target_margin_pct >= 0 and target_margin_pct < 1));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'gm_feature_snapshots_target_margin_source'
       and conrelid = 'gm_feature_snapshots'::regclass
  ) then
    alter table gm_feature_snapshots
      add constraint gm_feature_snapshots_target_margin_source
      check (target_margin_source is null or target_margin_source in ('configured', 'evaluator-default'));
  end if;
end
$$;

create index if not exists gm_feature_snapshots_observed_idx
  on gm_feature_snapshots (observed_on)
  where snapshot_version is not null;

-- 매각 전 D-7/D-1 판단 확률. 키는 법원/사건/물건/기일/관측지평/모델 버전.
-- insert only. 나중 모델이 같은 키를 갱신하거나, 관측일이 지난 스냅샷을 소급 채점하지 않는다.
create table if not exists gm_decision_probabilities (
  court text not null,
  case_no text not null,
  item_no text not null default '1',
  sale_date date not null,
  horizon_days int not null check (horizon_days in (1, 7)),
  model_name text not null,
  model_version text not null,
  label_version text not null,
  probability double precision not null check (probability >= 0 and probability <= 1),
  feature_snapshot_hash text not null,
  feature_snapped_at timestamptz not null,
  scored_at timestamptz not null default now(),
  primary key (court, case_no, item_no, sale_date, horizon_days, model_name, model_version)
);

create index if not exists gm_decision_probabilities_model_idx
  on gm_decision_probabilities (model_name, model_version, horizon_days, sale_date);

-- 매각 후 실거래 시세. 라벨 전용, insert only. 창(180일)+신고 지연(30일)이 지난 기일만 기록한다.
create table if not exists gm_post_sale_values (
  court text not null,
  case_no text not null,
  item_no text not null default '1',
  sale_date date not null,
  value bigint,
  confirms int not null,
  window_days int not null,
  method_version text not null,
  computed_at timestamptz not null default now(),
  primary key (court, case_no, item_no, sale_date)
);

commit;
