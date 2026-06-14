package com.gyeongmae.web;

import com.gyeongmae.service.JobRunner;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * 크롤/분석 잡 수동 트리거 + 상태 조회.
 *   POST /api/jobs/crawl, /api/jobs/analyze, /api/jobs/eval, /api/jobs/ingest-legal
 *   GET  /api/jobs/status
 *
 * 공개 배포 시 잡 트리거 남용 방지: ADMIN_TOKEN이 설정돼 있으면 X-Admin-Token 헤더 일치 필요.
 */
@RestController
@RequestMapping("/api/jobs")
public class JobController {
  private final JobRunner runner;

  @Value("${admin.token:}")
  private String adminToken;

  public JobController(JobRunner runner) {
    this.runner = runner;
  }

  @PostMapping("/{job}")
  public ResponseEntity<Map<String, Object>> trigger(
      @PathVariable String job,
      @RequestHeader(value = "X-Admin-Token", required = false) String token) {
    if (adminToken != null && !adminToken.isBlank() && !adminToken.equals(token)) {
      return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "admin token required"));
    }
    try {
      boolean started = runner.trigger(job);
      return ResponseEntity.status(started ? HttpStatus.ACCEPTED : HttpStatus.CONFLICT)
          .body(Map.of("job", job, "started", started, "status", runner.statusOf(job)));
    } catch (IllegalArgumentException e) {
      return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
    }
  }

  @GetMapping("/status")
  public Map<String, Object> status() {
    return runner.allStatus();
  }
}
