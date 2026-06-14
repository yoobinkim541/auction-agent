package com.gyeongmae.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 자동 스케줄(기본 비활성). jobs.scheduling.enabled=true 일 때만 빈 등록.
 * 매일 정해진 시각에 크롤 → (이후 별도로) 분석 실행.
 */
@Component
@ConditionalOnProperty(name = "jobs.scheduling.enabled", havingValue = "true")
public class ScheduledJobs {
  private static final Logger log = LoggerFactory.getLogger(ScheduledJobs.class);
  private final JobRunner runner;

  public ScheduledJobs(JobRunner runner) {
    this.runner = runner;
  }

  @Scheduled(cron = "${jobs.scheduling.cron}")
  public void dailyCrawl() {
    log.info("[schedule] daily crawl 트리거");
    runner.trigger("crawl");
    // 분석은 크롤 완료 후 수동/별도 스케줄로 실행 권장(동시 단일 실행기 제약).
  }
}
