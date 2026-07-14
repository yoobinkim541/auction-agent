#!/usr/bin/env bash
# 밤샘 교차 보강 — courtauction 점유미상 통과물건을 deonakchal 임차인(대항력·확정일자·배당요구)으로 보강 → 타겟 재분석.
#   자는 동안 천천히·직렬로만. egress가 집 IP가 아니면(터널 꺼짐/데이터센터) enrich 스크립트가 스스로 중단(계정 안전).
cd /home/ubuntu/projects/gyeongmae-agent || exit 1
export PATH="/home/ubuntu/.local/bin:$PATH"
export CRAWL_PROXY="socks5://127.0.0.1:1080"   # 집 IP SSH SOCKS 터널 경유(필수)
echo "[$(date '+%F %T')] === nightly enrich start ==="
npm run enrich:deonakchal -- --limit=30 --target-limit=300
echo "[$(date '+%F %T')] === nightly enrich done (rc=$?) ==="
