package com.gyeongmae.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.filter.ShallowEtagHeaderFilter;

/**
 * ETag 자동 계산 — /api/listings 등의 응답 본문 MD5로 ETag를 생성.
 * 데이터가 바뀌지 않으면 브라우저가 304 Not Modified를 받아 대역폭 절약.
 */
@Configuration
public class WebConfig {

  @Bean
  public ShallowEtagHeaderFilter shallowEtagHeaderFilter() {
    return new ShallowEtagHeaderFilter();
  }
}
