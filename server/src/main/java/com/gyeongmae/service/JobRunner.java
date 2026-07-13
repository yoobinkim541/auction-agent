package com.gyeongmae.service;

import java.io.File;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * TS 파이프라인(크롤/분석) 잡을 별도 프로세스로 실행한다.
 * 같은 잡의 동시 실행을 막고, 마지막 실행 상태를 보관한다.
 */
@Service
public class JobRunner {
  private static final Logger log = LoggerFactory.getLogger(JobRunner.class);

  @Value("${pipeline.dir}")
  private String pipelineDir;

  private final ExecutorService exec = Executors.newSingleThreadExecutor();
  private final Map<String, Object> status = new ConcurrentHashMap<>();

  /** 허용 잡 → 실행 명령 */
  private static final Map<String, String> SCRIPTS = Map.of(
      "crawl", "COURT_BID_DAYS=\"${COURT_BID_DAYS:-180}\" npm run crawl -- --source=courtauction --incremental --max=10000 --max-new=500 --all-types --region=서울,경기",
      "analyze", "npm run analyze",
      "eval", "npm run eval",
      "ingest-legal", "npm run ingest:legal");

  public synchronized boolean trigger(String job) {
    String script = SCRIPTS.get(job);
    if (script == null) throw new IllegalArgumentException("unknown job: " + job);
    if ("running".equals(statusOf(job).get("state"))) return false; // 이미 실행 중
    status.put(job, Map.of("state", "running", "startedAt", Instant.now().toString()));
    exec.submit(() -> run(job, script));
    return true;
  }

  private void run(String job, String script) {
    File dir = new File(pipelineDir).getAbsoluteFile();
    try {
      log.info("[job:{}] start: {} (dir={})", job, script, dir);
      Process p = new ProcessBuilder("bash", "-lc", script)
          .directory(dir)
          .redirectErrorStream(true)
          .inheritIO()
          .start();
      int code = p.waitFor();
      status.put(job, Map.of(
          "state", code == 0 ? "ok" : "error",
          "exitCode", code,
          "finishedAt", Instant.now().toString()));
      log.info("[job:{}] done exit={}", job, code);
    } catch (Exception e) {
      status.put(job, Map.of("state", "error", "error", String.valueOf(e), "finishedAt", Instant.now().toString()));
      log.error("[job:{}] failed", job, e);
    }
  }

  public Map<String, Object> statusOf(String job) {
    Object s = status.get(job);
    @SuppressWarnings("unchecked")
    Map<String, Object> m = (Map<String, Object>) s;
    return m == null ? Map.of("state", "idle") : m;
  }

  public Map<String, Object> allStatus() {
    return Map.copyOf(status);
  }
}
