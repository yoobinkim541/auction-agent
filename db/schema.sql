-- gyeongmae-agent 자체호스팅 PostgreSQL 스키마 (Supabase 미사용)
-- Spring Boot 앱이 유일한 DB 클라이언트이므로 RLS는 사용하지 않는다(앱이 접근 통제).
-- 적용: psql -d gyeongmae -f db/schema.sql

create extension if not exists vector;

-- 매물 마스터
create table if not exists gm_listings (
  id            bigint generated always as identity primary key,
  case_no       text not null,
  item_no       text not null default '',  -- NULL이면 unique(case_no,item_no,source)가 중복 허용 → '' 사용
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
         s.recommendation, s.true_margin, s.inq_cnt, s.interest_cnt,
         r.sold, r.sold_amount, r.result_cd, r.min_price as result_min_price,
         (r.dxdy_date is not null) as matched,
         case when r.sold then r.sold_amount - s.expected_bid end as residual,
         case when r.sold and s.expected_bid > 0 then (r.sold_amount - s.expected_bid)::float8 / s.expected_bid end as residual_pct,
         case when r.sold and l.appraisal_value > 0 then r.sold_amount::float8 / l.appraisal_value end as sale_ratio
    from gm_prediction_snapshots s
    join L l on l.case_no = s.case_no and l.item_no = s.item_no
    left join gm_auction_results r on r.case_no = s.case_no and r.item_no = s.item_no and r.dxdy_date = s.sale_date;
