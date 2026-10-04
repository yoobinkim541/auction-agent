package com.gyeongmae.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class CorsConfig implements WebMvcConfigurer {
  @Value("${cors.allowed-origins}")
  private String[] allowedOrigins;

  @Override
  public void addCorsMappings(CorsRegistry registry) {
    // 개인 API(쿠키/자격증명 미사용) — Vercel 등 임의 오리진에서 호출 가능하도록 패턴 허용.
    // 설정값이 "*"이면 전체 허용, 아니면 지정 오리진만.
    boolean all = allowedOrigins.length == 1 && "*".equals(allowedOrigins[0]);
    var mapping = registry.addMapping("/api/**")
        .allowedMethods("GET", "POST", "PUT", "OPTIONS")
        .allowedHeaders("*");
    if (all) mapping.allowedOriginPatterns("*");
    else mapping.allowedOrigins(allowedOrigins);
  }
}
