-- gyeongmae-agent 자체호스팅 PostgreSQL 스키마 (Supabase 미사용)
-- Spring Boot 앱이 유일한 DB 클라이언트이므로 RLS는 사용하지 않는다(앱이 접근 통제).
-- 적용: psql -d gyeongmae -f db/schema.sql

create extension if not exists vector;

-- 매물 마스터
create table if not exists gm_listings (
  id            bigint generated always as identity primary key,
  case_no       text not null,
  item_no       text not null default '1', -- NULL이면 unique(case_no,item_no,source)가 중복 허용 → 기본 물건번호 '1' 사용
  court         text not null,
  address       text not null,
  road_address  text,
  lat           double precision,
  lng           double precision,
  property_type text not null check (property_type in
                  ('apartment','villa','officetel','house','land','commercial','other')),
  appraisal_value bigint,
  min_bid_price   bigint,
  min_bid_ratio   numeric,
  fail_count      int default 0,
  sale_date       date,
  demand_deadline date,
  area_m2         numeric,
  building_area_m2 numeric,
  is_collective_building boolean default false,
  inq_cnt       int,  -- 조회수(경쟁 신호)
  interest_cnt  int,  -- 관심물건 등록수(경쟁 신호)
  is_favorite   boolean default false,
  source        text not null check (source in ('deonakchal','courtauction')),
  source_url    text,
  raw_json      jsonb,
  crawled_at    timestamptz not null default now(),
  unique (case_no, item_no, source)
);
create index if not exists gm_listings_type_sale_idx on gm_listings (property_type, sale_date);

create table if not exists gm_listing_docs (
  id          bigint generated always as identity primary key,
  listing_id  bigint references gm_listings(id) on delete cascade,
  doc_type    text not null check (doc_type in
                ('rights_summary','registry_summary','sale_statement',
                 'survey_report','appraisal_report','site_metrics','registry_pdf')),
  parsed_json jsonb,
  pdf_path    text,
  created_at  timestamptz not null default now()
);
create index if not exists gm_listing_docs_listing_idx on gm_listing_docs (listing_id);

create table if not exists gm_rights_analysis (
  id              bigint generated always as identity primary key,
  listing_id      bigint references gm_listings(id) on delete cascade,
  malso_basis     jsonb,
  classified      jsonb,
  tenants         jsonb,
  distribution    jsonb,
  assumed_amount  bigint default 0,
  assumed_breakdown jsonb,
  max_safe_bid    bigint,
  red_flags       jsonb,
  risk_grade      text check (risk_grade in ('clean','caution','risky','review_required')),
  is_clean        boolean default false,
  citations       jsonb,
  warnings        jsonb,
  engine_version  text,
  model_version   text,
  analyzed_at     timestamptz not null default now(),
  unique (listing_id)
);

create table if not exists gm_location_analysis (
  id            bigint generated always as identity primary key,
  listing_id    bigint references gm_listings(id) on delete cascade,
  market_price  bigint,
  comps         jsonb,
  market_confidence text,
  comp_basis    text,
  safety_margin numeric,
  transit       jsonb,
  schools       jsonb,
  amenities     jsonb,
  dev_signals   jsonb,
  expected_bid_price bigint,        -- 예상낙찰가(감정가×낙찰가율)
  expected_bid_basis text,
  acquisition_cost   jsonb,         -- 총취득비용 내역 + 진짜 안전마진
  site_comps         jsonb,         -- 사이트 동일건물 실거래
  sale_rounds        jsonb,         -- 매각기일 차수표
  building           jsonb,         -- 건축물 표제부
  land_use_flags     jsonb,         -- 토지이용 규제 flags
  admin_offices      jsonb,         -- 관할 행정기관
  report             jsonb,         -- 매물별 보고서 + 입찰 전 체크리스트
  photos             jsonb,         -- 매물 사진 URL
  income             jsonb,         -- 임대수익·출구 분석
  eviction           jsonb,         -- 명도 난이도 분석
  analyzed_at   timestamptz not null default now(),
  unique (listing_id)
);



create table if not exists gm_listing_photos (
  id           bigint generated always as identity primary key,
  listing_id   bigint references gm_listings(id) on delete cascade,
  case_no      text not null,
  item_no      text not null default '1',
  source       text not null default 'courtauction',
  source_url   text not null,
  cache_path   text not null,
  public_url   text not null,
  content_hash text not null,
  status       text not null default 'active' check (status in ('active','deleted','failed')),
  delete_reason text,
  captured_at  timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (listing_id, content_hash)
);
create index if not exists idx_gm_listing_photos_listing_active on gm_listing_photos (listing_id, status);
create index if not exists idx_gm_listing_photos_case_item on gm_listing_photos (case_no, item_no, status);

create table if not exists gm_scores (
  id                  bigint generated always as identity primary key,
  listing_id          bigint references gm_listings(id) on delete cascade,
  safety_margin_score numeric,
  clean_rights_score  numeric,
  total_score         numeric,
  passed_filter       boolean default false,
  reason              text,
  scored_at           timestamptz not null default now(),
  unique (listing_id)
);
create index if not exists gm_scores_total_idx on gm_scores (passed_filter, total_score desc);

-- 법률 RAG 코퍼스 (임베딩 1536차원)
create table if not exists gm_legal_chunks (
  id          bigint generated always as identity primary key,
  source      text not null check (source in ('law','precedent')),
  law_name    text,
  article     text,
  content     text not null,
  embedding   vector(1536),
  content_tsv tsvector generated always as (
                to_tsvector('simple',
                  coalesce(law_name,'') || ' ' || coalesce(article,'') || ' ' || coalesce(content,''))
              ) stored,
  created_at  timestamptz not null default now()
);
create index if not exists gm_legal_chunks_embedding_idx on gm_legal_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists gm_legal_chunks_tsv_idx on gm_legal_chunks using gin (content_tsv);

create or replace function match_legal_chunks(
  query_embedding vector(1536),
  query_text      text default '',
  match_count     int default 8
)
returns table (id bigint, source text, law_name text, article text, content text, similarity float)
language sql stable as $$
  select c.id, c.source, c.law_name, c.article, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from gm_legal_chunks c
  where query_text = '' or c.content_tsv @@ websearch_to_tsquery('simple', query_text)
     or c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- 모의경매 정답 사건 (평가셋 + 사례 RAG)
create table if not exists gm_solved_cases (
  id            bigint generated always as identity primary key,
  case_no       text,
  source        text not null,
  input_json    jsonb not null,
  expected_json jsonb not null,
  note          text,
  embedding     vector(1536),
  created_at    timestamptz not null default now(),
  unique (source, case_no)
);
create index if not exists gm_solved_cases_embedding_idx on gm_solved_cases using hnsw (embedding vector_cosine_ops);

-- 크롤 실행 로그
create table if not exists gm_crawl_runs (
  id         bigint generated always as identity primary key,
  source     text not null,
  region     text,
  n_found    int default 0,
  n_new      int default 0,
  status     text not null default 'running' check (status in ('running','ok','error','blocked')),
  error      text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists gm_crawl_runs_started_idx on gm_crawl_runs (source, started_at desc);

-- 국토부(MOLIT) 실거래 원자료 영구 캐시 — 법정동·월 단위. 개발계정 일일쿼터 소진 방지.
-- 과거 월의 신고는 사실상 불변 → 한 번 받으면 재호출 없이 income/시세 분석 재실행 가능.
create table if not exists gm_molit_cache (
  ep         text not null,           -- 엔드포인트(예: RTMSDataSvcRHRent)
  lawd_cd    text not null,           -- 법정동코드 앞 5자리(시군구)
  ym         text not null,           -- 거래년월(YYYYMM)
  items      jsonb not null default '[]'::jsonb,
  n          int not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (ep, lawd_cd, ym)
);

-- 현장 임장 체크리스트 — 사용자가 직접 체크/메모하는 데이터.
-- 주의: report(gm_location_analysis.report)는 매일 재분석 시 덮어쓰이므로 사용자 입력은 여기 별도 보관.
-- item_key = 발품 체크리스트 항목 라벨(매물별 고유·안정적). 재분석돼도 라벨이 같으면 메모 유지.
create table if not exists gm_fieldwork_notes (
  listing_id bigint not null references gm_listings(id) on delete cascade,
  item_key   text not null,                       -- 체크리스트 항목 식별자(라벨)
  checked    boolean not null default false,      -- 현장 확인 완료 여부
  note       text not null default '',            -- 현장 메모
  updated_at timestamptz not null default now(),
  primary key (listing_id, item_key)
);

-- 실제 경매 결과(결과 피드백 학습 Phase 1) — 상세 gdsDspslDxdyLst 회차별 결과·낙찰가.
-- sold = dspslAmt>0(매각). 응찰자수는 이 엔드포인트 미제공(추후). 회차가 확정되며 upsert 갱신.
create table if not exists gm_auction_results (
  id          serial primary key,
  case_no     text not null,
  item_no     text not null default '1',
  court       text,
  dxdy_date   date not null,                       -- 기일
  kind_cd     text,                                -- auctnDxdyKndCd (01 매각기일 / 02 매각결정기일)
  result_cd   text,                                -- auctnDxdyRsltCd 원본(002=유찰 등)
  min_price   bigint,                              -- 해당 기일 최저매각가
  sold_amount bigint,                              -- 매각가(낙찰가)
  sold        boolean not null default false,
  captured_at timestamptz not null default now(),
  unique (case_no, item_no, dxdy_date)
);
create index if not exists idx_gm_auction_results_date on gm_auction_results (dxdy_date);

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

-- 관심물건(★) 변동 감시 상태(발품절감 ②) — watch-favorites가 직전 상태와 diff 후 갱신.
create table if not exists gm_watch_state (
  listing_id    bigint primary key references gm_listings(id) on delete cascade,
  sale_date     date,
  min_bid_price bigint,
  fail_count    int,
  sold          boolean not null default false,   -- 매각됨 알림 1회만
  updated_at    timestamptz not null default now()
);

-- 문서(명세서·현황조사 등) 갱신 이력(발품절감 ⑤) — 크롤러가 재수집 시 내용 변화를 기록,
-- watch-favorites가 ★매물 것을 알림에 태우고 notified 마킹(중복 발송 방지).
create table if not exists gm_doc_changes (
  id          bigint generated always as identity primary key,
  listing_id  bigint references gm_listings(id) on delete cascade,
  case_no     text not null,
  doc_types   text,                               -- 변경된 문서 타입(쉼표 구분)
  changed_at  timestamptz not null default now(),
  notified    boolean not null default false
);
create index if not exists gm_doc_changes_pending_idx on gm_doc_changes (notified, listing_id);

-- 교차 보강(courtauction ↔ deonakchal): courtauction은 임차인 표를 못 파싱(명세서 PDF) → 명도판정 '점유관계 미상'.
-- deonakchal에서 사건번호로 조회한 임차인(대항력·확정일자·배당요구)을 여기 저장. analyze가 최우선으로 읽고(pipeline/run.ts),
-- courtauction 재크롤(gm_listing_docs 삭제)로 안 지워짐. found=false = 조회했으나 deonakchal에 없음(재시도 마커).
create table if not exists gm_deonak_tenants (
  listing_id  bigint primary key references gm_listings(id) on delete cascade,
  case_no     text not null,
  item_no     text not null default '1',
  tenants     jsonb not null default '[]'::jsonb,     -- Tenant[] (found=true일 때 채워짐)
  found       boolean not null default false,
  fetched_at  timestamptz not null default now()
);
create index if not exists gm_deonak_tenants_case_item_idx on gm_deonak_tenants (case_no, item_no);

-- 예측 스냅샷(Phase 0) — analyze가 점수를 덮어쓰므로, 매각 직전 예측을 동결해 사후 결과와 비교.
create table if not exists gm_prediction_snapshots (
  id             serial primary key,
  case_no        text not null,
  item_no        text not null default '1',
  sale_date      date,                             -- 이 예측이 겨눈 매각기일
  expected_bid   bigint,                           -- 예상낙찰가(loc.expected_bid_price)
  market_price   bigint,                           -- 추정시세
  min_bid_price  bigint,                           -- 스냅샷 시점 최저가
  total_score    int,
  passed_filter  boolean,
  recommendation text,
  true_margin    double precision,                 -- 진짜 안전마진
  max_safe_bid   bigint,                           -- 최대 안전 입찰가(스냅샷 시점)
  inq_cnt        int,
  interest_cnt   int,
  snapped_at     timestamptz not null default now(),
  unique (case_no, item_no, sale_date)
);

-- 라벨 데이터셋(Phase 2) — 예측 스냅샷 ⋈ 실제 결과 ⋈ 매물. 보정·서프라이즈 복기의 단일 소스.
-- matched=결과 매칭됨, sold/sold_amount=낙찰, residual=실제−예상, sale_ratio=낙찰가/감정가.
create or replace view gm_outcome_eval as
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

create or replace view gm_trusted_outcome_eval as
  select e.*
    from gm_outcome_eval e
    join gm_outcome_trust t
      on t.case_no = e.case_no
     and t.item_no = coalesce(nullif(e.item_no, ''), '1')
     and t.sale_date = e.sale_date
   where t.status = 'trusted';


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
    from gm_trusted_outcome_eval e
    left join latest_listing l on l.case_no = e.case_no and l.item_no = coalesce(nullif(e.item_no,''),'1')
    left join gm_rights_analysis r on r.listing_id = l.listing_id
   where e.sale_date < current_date;

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

create or replace view gm_today_actions as
with active_listings as (
  select l.id, l.case_no, coalesce(nullif(l.item_no, ''), '1') as item_no,
         l.source, l.source_url, l.sale_date, l.is_favorite,
         s.passed_filter, s.total_score,
         r.id as rights_id,
         loc.id as location_id,
         loc.report,
         loc.eviction,
         coalesce(jsonb_array_length(loc.report->'fieldwork'->'fieldChecklist'), 0) as field_total,
         coalesce((select count(*) from gm_fieldwork_notes fn where fn.listing_id = l.id and fn.checked), 0) as field_done
    from gm_listings l
    left join gm_scores s on s.listing_id = l.id
    left join gm_rights_analysis r on r.listing_id = l.id
    left join gm_location_analysis loc on loc.listing_id = l.id
   where l.sale_date is null or l.sale_date >= current_date - 2
), recrawl_needed as (
  select id as listing_id, case_no, item_no,
         'recrawl_needed'::text as action_type,
         110::int as priority,
         'danger'::text as severity,
         '재수집 필요'::text as title,
         case
           when report->>'headline' like '[데이터 불완전]%' then '등기/명세서 데이터가 불완전해 권리분석을 신뢰할 수 없습니다.'
           when rights_id is null then '권리분석 결과가 없어 재수집 또는 재분석이 필요합니다.'
           else '입지분석 결과가 없어 재분석이 필요합니다.'
         end as reason,
         null::date as due_date,
         current_date as sort_date,
         source_url
    from active_listings
   where report->>'headline' like '[데이터 불완전]%'
      or rights_id is null
      or location_id is null
), rights_enrichment as (
  select id as listing_id, case_no, item_no,
         'rights_enrichment'::text as action_type,
         75::int as priority,
         'warn'::text as severity,
         '권리 보강 필요'::text as title,
         '법원경매 원천의 점유관계가 미상입니다. deonakchal 임차인 보강 대상으로 올립니다.'::text as reason,
         null::date as due_date,
         coalesce(sale_date, current_date + 30) as sort_date,
         source_url
    from active_listings
   where source = 'courtauction'
     and eviction->>'occupantLabel' = '점유관계 미상'
     and (passed_filter = true or is_favorite = true or coalesce(total_score, 0) >= 70)
), bid_soon as (
  select id as listing_id, case_no, item_no,
         'bid_soon'::text as action_type,
         (case when sale_date = current_date then 120 else 90 - greatest(0, sale_date - current_date) end)::int as priority,
         (case when sale_date = current_date then 'danger' else 'warn' end)::text as severity,
         '입찰 임박'::text as title,
         ('매각기일이 ' || sale_date::text || '입니다. 보증금, 원본 문서, 최대입찰가를 확인하세요.')::text as reason,
         sale_date as due_date,
         sale_date as sort_date,
         source_url
    from active_listings
   where sale_date between current_date and current_date + 7
     and (passed_filter = true or is_favorite = true)
), fieldwork as (
  select id as listing_id, case_no, item_no,
         'fieldwork'::text as action_type,
         65::int as priority,
         'info'::text as severity,
         '현장 확인 남음'::text as title,
         ('임장 체크리스트 ' || field_done || '/' || field_total || ' 완료 상태입니다.')::text as reason,
         sale_date as due_date,
         coalesce(sale_date, current_date + 30) as sort_date,
         source_url
    from active_listings
   where field_total > 0
     and field_done < field_total
     and (passed_filter = true or is_favorite = true)
), review_result as (
  select l.id as listing_id, q.case_no, q.item_no,
         'review_result'::text as action_type,
         55::int as priority,
         'info'::text as severity,
         '결과 수집 복기'::text as title,
         ('매각기일이 ' || q.sale_date::text || '로 ' || q.days_overdue || '일 지났지만 결과 재시도가 남아 있습니다.')::text as reason,
         q.sale_date as due_date,
         q.sale_date as sort_date,
         l.source_url
    from gm_result_retry_queue q
    join gm_listings l on l.case_no = q.case_no and coalesce(nullif(l.item_no, ''), '1') = q.item_no
   where q.days_overdue > 0
  union all
  select l.id as listing_id, e.case_no, coalesce(nullif(e.item_no, ''), '1') as item_no,
         'review_result'::text as action_type,
         45::int as priority,
         'info'::text as severity,
         '낙찰 결과 복기'::text as title,
         case
           when e.sold and e.residual_pct > 0 then '예상보다 높은 가격에 낙찰된 케이스입니다.'
           when e.sold and (e.passed_filter = false or e.recommendation = 'avoid') then '회피/탈락 판단이었지만 낙찰된 케이스입니다.'
           when e.matched and not e.sold and e.passed_filter = true then '추천 통과였지만 유찰된 케이스입니다.'
           else '최근 결과 복기 대상입니다.'
         end as reason,
         e.sale_date as due_date,
         e.sale_date as sort_date,
         l.source_url
    from gm_outcome_eval e
    join gm_listings l on l.case_no = e.case_no and coalesce(nullif(l.item_no, ''), '1') = coalesce(nullif(e.item_no, ''), '1')
   where e.sale_date >= current_date - 14
     and (
       (e.sold and e.residual_pct > 0.15)
       or (e.sold and (e.passed_filter = false or e.recommendation = 'avoid'))
       or (e.matched and not e.sold and e.passed_filter = true)
     )
)
select * from recrawl_needed
union all select * from rights_enrichment
union all select * from bid_soon
union all select * from fieldwork
union all select * from review_result;
