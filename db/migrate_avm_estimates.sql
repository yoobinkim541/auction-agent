begin;

-- 시세 모델(AVM) 추정값 — 국토부 매매 실거래로 학습한 report-only 시세. 운영 시세(gm_location_analysis.market_price)와 별개.
-- as_of = 평가 기준일(매각 7일 전, 아직 멀었으면 실행일). 그날로부터 신고 지연 30일 이전 거래만 썼다.
-- as_of 가 매각 7일 전에 닿은 행은 다시 쓰지 않는다(ml:avm --rebuild 제외).
create table if not exists gm_avm_estimates (
  case_no        text not null,
  item_no        text not null default '1',
  sale_date      date not null,
  as_of          date not null,
  kind           text not null,                    -- apt | rh | offi
  value          bigint,                           -- null = 추정 불가(basis 참고)
  value_low      bigint,                           -- 80% 구간 하한
  value_high     bigint,
  basis          text not null,                    -- building_area | building | dong_area | dong | sgg_area | sgg | no_area | no_comps
  building_comps int not null default 0,           -- 같은 건물 12개월 거래 수
  dong_comps     int not null default 0,
  model_version  text not null,
  created_at     timestamptz not null default now(),
  primary key (case_no, item_no, sale_date)
);

commit;
