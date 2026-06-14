#!/usr/bin/env bash
# Spring Boot 실행: ../.env의 DATABASE_URL에서 DB 비밀번호를 추출해 주입.
set -e
cd "$(dirname "$0")"
if [ -f ../.env ]; then
  export DB_PASSWORD="$(grep -E '^DATABASE_URL=' ../.env | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')"
fi
export PIPELINE_DIR="${PIPELINE_DIR:-$(cd .. && pwd)}"
exec mvn -q spring-boot:run
