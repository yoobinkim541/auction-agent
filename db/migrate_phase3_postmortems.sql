-- Phase3: LLM 복기 결과 저장 테이블
-- 서프라이즈 케이스(overpriced / avoid_but_sold / passed_but_unsold)에 대해
-- Claude CLI로 "왜 이 결과?" 추론 후 태그+근거를 저장.
CREATE TABLE IF NOT EXISTS gm_postmortems (
  case_no           text        NOT NULL,
  item_no           text        NOT NULL,
  sale_date         date        NOT NULL,
  surprise_type     text        NOT NULL CHECK (surprise_type IN ('overpriced', 'avoid_but_sold', 'passed_but_unsold')),
  -- 복기 시점 스냅샷 (gm_trusted_outcome_eval 기준)
  property_type     text,
  address           text,
  region            text,
  appraisal_value   bigint,
  expected_bid      bigint,
  sold_amount       bigint,
  sale_ratio        numeric,
  residual_pct      numeric,
  total_score       int,
  recommendation    text,
  inq_cnt           int,
  interest_cnt      int,
  -- LLM 분석 결과
  tags              jsonb       NOT NULL DEFAULT '[]',
  reason            text,
  model_version     text        NOT NULL DEFAULT 'claude-cli',
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_no, item_no, sale_date, surprise_type)
);

COMMENT ON TABLE gm_postmortems IS 'Phase3 LLM 복기: 서프라이즈 케이스 "왜?" 분석 결과';
