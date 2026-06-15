#!/usr/bin/env bash
# 매일 자동 파싱: 더낙찰옥션 크롤(상세 정밀 파싱) → 전체 재분석.
set -e
cd /home/ubuntu/projects/gyeongmae-agent
export PATH="/home/ubuntu/.local/bin:$PATH"
echo "[$(date '+%F %T')] === parse start ==="
npm run crawl
npm run analyze -- --all
echo "[$(date '+%F %T')] === parse done ==="
