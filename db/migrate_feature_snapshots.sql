begin;

-- 시점 고정 입력 스냅샷 — 매각 D-7·D-1(KST)에 한 번만 기록하고 덮어쓰지 않는다.
-- 학습 데이터가 권리·입지·매물 값을 '최신 행'이 아니라 판단 시점 값으로 읽기 위한 원장.
create table if not exists gm_feature_snapshots (
  case_no        text not null,
  item_no        text not null default '1',
  sale_date      date not null,                    -- 이 스냅샷이 겨눈 매각기일
  horizon_days   int not null check (horizon_days in (1, 7)),
  days_to_sale   int not null,                     -- 기록 시점의 실제 잔여 일수(KST). D-7 창에 늦게 들어오면 7보다 작다
  listing_id     bigint,
  property_type  text,
  court          text,
  appraisal_value bigint,
  min_bid_price  bigint,
  fail_count     int,
  area_m2        numeric,
  building_area_m2 numeric,
  is_collective_building boolean,
  inq_cnt        int,
  interest_cnt   int,
  listing_crawled_at timestamptz,
  risk_grade     text,
  assumed_amount bigint,
  max_safe_bid   bigint,
  has_opposition_tenant boolean,
  tenant_count   int,
  red_flag_count int,
  rights_analyzed_at timestamptz,
  market_price   bigint,
  market_confidence text,
  comp_basis     text,
  comp_count     int,
  expected_bid   bigint,
  safety_margin  numeric,
  true_margin    double precision,
  recommendation text,
  location_analyzed_at timestamptz,
  total_score    numeric,
  passed_filter  boolean,
  precision_status text,
  precision_confidence text,
  conservative_value bigint,
  recommended_bid bigint,
  hard_cap_bid   bigint,
  reason_codes   jsonb,
  trust_status   text,
  snapped_at     timestamptz not null default now(),
  primary key (case_no, item_no, sale_date, horizon_days)
);

commit;
