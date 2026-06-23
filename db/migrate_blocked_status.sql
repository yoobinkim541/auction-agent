-- gm_crawl_runs에 'blocked' 상태 추가 + 인덱스
-- 멀티프록시 차단 감지 기능(crawler/index.ts) 지원
ALTER TABLE gm_crawl_runs DROP CONSTRAINT IF EXISTS gm_crawl_runs_status_check;
ALTER TABLE gm_crawl_runs ADD CONSTRAINT gm_crawl_runs_status_check
  CHECK (status IN ('running','ok','error','blocked'));
CREATE INDEX IF NOT EXISTS gm_crawl_runs_started_idx ON gm_crawl_runs (source, started_at DESC);
