#!/usr/bin/env bash
# 매일 자동 파싱: 더낙찰옥션 크롤(상세 정밀 파싱) → 전체 재분석.
#
# 크롤이 실패해도(접속차단·로그인 폼 변경·네트워크 등) 분석은 항상 수행한다.
#   분석은 DB(기존 등기/명세서 + gm_molit_cache 영구 캐시)만으로도 income·시세·리포트를 갱신하므로,
#   크롤 한 번의 실패가 전체 분석 갱신을 막아선 안 된다. (과거: set -e + crawl 실패 → analyze 통째 스킵 버그)
cd /home/ubuntu/projects/gyeongmae-agent || exit 1
export PATH="/home/ubuntu/.local/bin:$PATH"
echo "[$(date '+%F %T')] === parse start ==="

if npm run crawl; then
  echo "[$(date '+%F %T')] crawl ok"
else
  echo "[$(date '+%F %T')] ⚠ crawl 실패(rc=$?) — 분석은 계속 진행(DB·캐시 기반)"
fi

npm run analyze -- --all
rc=$?
echo "[$(date '+%F %T')] === parse done (analyze rc=$rc) ==="
exit $rc
