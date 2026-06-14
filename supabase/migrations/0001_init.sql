-- gyeongmae-agent 초기 스키마
-- 기존 프로젝트(jipsuri-class 등)와 충돌 방지를 위해 모든 객체에 gm_ 접두사 사용.
-- public 스키마 사용(= supabase-js / PostgREST 기본 노출, Vercel 대시보드에서 바로 접근).

create extension if not exists vector;

-- ─────────────────────────────────────────────────────────────────
-- 매물 마스터
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.gm_listings (
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
  appraisal_value bigint,        -- 감정가(원)
  min_bid_price   bigint,        -- 최저매각가(원)
  min_bid_ratio   numeric,       -- 최저가/감정가(%)
  fail_count      int default 0, -- 유찰 횟수
  sale_date       date,          -- 매각기일
  demand_deadline date,          -- 배당요구종기
  area_m2         numeric,
  building_area_m2 numeric,
  is_collective_building boolean default false,
  source        text not null check (source in ('deonakchal','courtauction')),
  source_url    text,
  raw_json      jsonb,
  crawled_at    timestamptz not null default now(),
  unique (case_no, item_no, source)
);
create index if not exists gm_listings_type_region_idx
  on public.gm_listings (property_type, sale_date);

-- 매물 문서/원천 (권리분석 입력)
create table if not exists public.gm_listing_docs (
  id          bigint generated always as identity primary key,
  listing_id  bigint references public.gm_listings(id) on delete cascade,
  doc_type    text not null check (doc_type in
                ('rights_summary','registry_summary','sale_statement',
                 'survey_report','appraisal_report','registry_pdf')),
  parsed_json jsonb,
  pdf_path    text,
  created_at  timestamptz not null default now()
);
create index if not exists gm_listing_docs_listing_idx
  on public.gm_listing_docs (listing_id);

-- ─────────────────────────────────────────────────────────────────
-- 권리분석 결과
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.gm_rights_analysis (
  id              bigint generated always as identity primary key,
  listing_id      bigint references public.gm_listings(id) on delete cascade,
  malso_basis     jsonb,   -- {kind, date, note}
  classified      jsonb,   -- ClassifiedRight[]
  tenants         jsonb,   -- TenantAnalysis[]
  distribution    jsonb,   -- DistributionLine[]
  assumed_amount  bigint default 0,         -- 총 인수금액(원)
  assumed_breakdown jsonb,
  max_safe_bid    bigint,
  red_flags       jsonb,   -- RedFlag[]
  risk_grade      text check (risk_grade in
                    ('clean','caution','risky','review_required')),
  is_clean        boolean default false,
  citations       jsonb,   -- 법령/판례 인용 (Claude 검증 단계)
  warnings        jsonb,
  engine_version  text,
  model_version   text,
  analyzed_at     timestamptz not null default now(),
  unique (listing_id)
);

-- 입지분석 결과
create table if not exists public.gm_location_analysis (
  id            bigint generated always as identity primary key,
  listing_id    bigint references public.gm_listings(id) on delete cascade,
  market_price  bigint,        -- 추정 시세(원)
  comps         jsonb,         -- Comparable[]
  safety_margin numeric,       -- (시세-최저가)/시세
  transit       jsonb,
  schools       jsonb,
  amenities     jsonb,
  dev_signals   jsonb,
  analyzed_at   timestamptz not null default now(),
  unique (listing_id)
);

-- 선별 점수
create table if not exists public.gm_scores (
  id                  bigint generated always as identity primary key,
  listing_id          bigint references public.gm_listings(id) on delete cascade,
  safety_margin_score numeric,
  clean_rights_score  numeric,
  total_score         numeric,
  passed_filter       boolean default false,
  reason              text,
  scored_at           timestamptz not null default now(),
  unique (listing_id)
);
create index if not exists gm_scores_total_idx
  on public.gm_scores (passed_filter, total_score desc);

-- ─────────────────────────────────────────────────────────────────
-- 법률 RAG 코퍼스 (PII 없음 — 법령/판례)
-- 임베딩 차원 1536 (OpenAI text-embedding-3-large를 dimensions=1536로 요청; HNSW 인덱스 한도 내)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.gm_legal_chunks (
  id          bigint generated always as identity primary key,
  source      text not null check (source in ('law','precedent')),
  law_name    text,            -- 예: "주택임대차보호법"
  article     text,            -- 예: "제3조" / 판례 사건번호
  content     text not null,
  embedding   vector(1536),
  content_tsv tsvector generated always as (
                to_tsvector('simple',
                  coalesce(law_name,'') || ' ' || coalesce(article,'') || ' ' || coalesce(content,''))
              ) stored,
  created_at  timestamptz not null default now()
);
create index if not exists gm_legal_chunks_embedding_idx
  on public.gm_legal_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists gm_legal_chunks_tsv_idx
  on public.gm_legal_chunks using gin (content_tsv);

-- 하이브리드 검색 RPC (의미 + 키워드)
create or replace function public.match_legal_chunks(
  query_embedding vector(1536),
  query_text      text default '',
  match_count     int default 8
)
returns table (
  id bigint, source text, law_name text, article text,
  content text, similarity float
)
language sql stable
as $$
  select c.id, c.source, c.law_name, c.article, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.gm_legal_chunks c
  where query_text = '' or c.content_tsv @@ websearch_to_tsquery('simple', query_text)
     or c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- 크롤 실행 로그(멱등성/모니터링)
create table if not exists public.gm_crawl_runs (
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

-- ─────────────────────────────────────────────────────────────────
-- RLS: 개인용. service_role(백엔드)은 RLS 우회. 대시보드용 anon read 허용.
-- ─────────────────────────────────────────────────────────────────
alter table public.gm_listings          enable row level security;
alter table public.gm_listing_docs       enable row level security;
alter table public.gm_rights_analysis    enable row level security;
alter table public.gm_location_analysis  enable row level security;
alter table public.gm_scores             enable row level security;

drop policy if exists gm_anon_read_listings on public.gm_listings;
create policy gm_anon_read_listings on public.gm_listings for select using (true);
drop policy if exists gm_anon_read_docs on public.gm_listing_docs;
create policy gm_anon_read_docs on public.gm_listing_docs for select using (true);
drop policy if exists gm_anon_read_rights on public.gm_rights_analysis;
create policy gm_anon_read_rights on public.gm_rights_analysis for select using (true);
drop policy if exists gm_anon_read_location on public.gm_location_analysis;
create policy gm_anon_read_location on public.gm_location_analysis for select using (true);
drop policy if exists gm_anon_read_scores on public.gm_scores;
create policy gm_anon_read_scores on public.gm_scores for select using (true);
