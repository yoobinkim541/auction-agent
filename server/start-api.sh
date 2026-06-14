#!/usr/bin/env bash
# systemd용 API 기동 스크립트: .env에서 DB 비번 추출 후 jar 실행.
set -e
cd /home/ubuntu/projects/gyeongmae-agent/server
if [ -f ../.env ]; then
  export DB_PASSWORD="$(grep -E '^DATABASE_URL=' ../.env | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')"
fi
export PIPELINE_DIR="/home/ubuntu/projects/gyeongmae-agent"
export PATH="/home/ubuntu/.local/bin:$PATH"   # JobRunner의 npm 잡 실행용
export CORS_ORIGINS="${CORS_ORIGINS:-*}"        # Vercel 등 외부 오리진 허용(개인 API)
if [ -f ../.env ]; then
  export ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' ../.env | cut -d= -f2-)"   # 잡 트리거 보호
fi
JAVA=/usr/lib/jvm/java-17-openjdk-arm64/bin/java
exec "$JAVA" -jar target/gyeongmae-server-0.1.0.jar
