#!/usr/bin/env bash
# 저녁 2차 결과 수집 — 당일 오후 기일의 낙찰/유찰 결과를 같은 날 포착(collect:results 1차 활성 + 2차 소급).
#   pgj15A 소급이 있어 타이밍은 비필수지만, 같은 날 한 번 더 돌려 대시보드·학습 데이터를 더 신선하게 유지.
#   (06:00 daily-parse 와 별개. 2차 소급은 '6일 내 재수집 스킵' 가드로 저녁엔 대부분 스킵 → 중복 부하↓.)
cd /home/ubuntu/projects/gyeongmae-agent || exit 1
export PATH="/home/ubuntu/.local/bin:$PATH"
echo "[$(date '+%F %T')] === evening collect start ==="
npm run collect:results
echo "[$(date '+%F %T')] === evening collect done (rc=$?) ==="
