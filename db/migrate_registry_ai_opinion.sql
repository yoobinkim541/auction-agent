-- 등기 미확보(EMPTY_REGISTRY) 물건 전용 AI 1차 소견 저장.
-- 결정형 엔진이 말소기준권리를 못 정했을 때(courtauction API가 해당 필드를 비워둔 경우)
-- 원문(명세서 비고+감정평가서)과 법령 RAG로 Claude 1차 소견을 받아 저장한다.
-- 이 소견은 절대 최종 판정이 아니며, precision 평가에서 hold를 conditional로만
-- 완화할 수 있다(recommended 승격 불가 — pipeline/precision/evaluate.ts 참고).
CREATE TABLE IF NOT EXISTS gm_registry_opinions (
  listing_id        bigint      NOT NULL PRIMARY KEY REFERENCES gm_listings(id) ON DELETE CASCADE,
  has_clue          boolean     NOT NULL,
  tentative_kind    text,
  tentative_date    text,
  explanation       text        NOT NULL DEFAULT '',
  citations         jsonb       NOT NULL DEFAULT '[]',
  required_checks   jsonb       NOT NULL DEFAULT '[]',
  confidence        text        NOT NULL CHECK (confidence IN ('high','medium','low')),
  model_version     text        NOT NULL,
  input_hash        text        NOT NULL,
  evaluated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE gm_registry_opinions IS 'EMPTY_REGISTRY 물건 전용 AI 1차 소견(미확정) — precision hold→conditional 완화용, recommended 승격 불가';
