-- 모의경매 등 '정답 있는' 사건 저장 (엔진 평가셋 + 해결사례 RAG)
create table if not exists public.gm_solved_cases (
  id            bigint generated always as identity primary key,
  case_no       text,
  source        text not null,          -- '모의경매' | 'site' | 'manual'
  input_json    jsonb not null,         -- RightsInput
  expected_json jsonb not null,         -- ExpectedAnswer (정답 라벨)
  note          text,
  embedding     vector(1536),           -- few-shot/RAG 검색용(선택)
  created_at    timestamptz not null default now(),
  unique (source, case_no)
);
create index if not exists gm_solved_cases_embedding_idx
  on public.gm_solved_cases using hnsw (embedding vector_cosine_ops);
