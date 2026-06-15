-- gyeongmae-agent 자체호스팅 PostgreSQL 스키마 (Supabase 미사용)
-- Spring Boot 앱이 유일한 DB 클라이언트이므로 RLS는 사용하지 않는다(앱이 접근 통제).
-- 적용: psql -d gyeongmae -f db/schema.sql

create extension if not exists vector;

-- 매물 마스터
create table if not exists gm_listings (
  id            bigint generated always as identity primary key,
  case_no       text not null,
  item_no       text,
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
                 'survey_report','appraisal_report','registry_pdf')),
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
  status     text not null default 'running' check (status in ('running','ok','error')),
  error      text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
