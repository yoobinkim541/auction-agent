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

# 수집 헬스: status=ok·0건(굶음) 감지 → 비정상이면 텔레그램 알림. 분석 rc는 보존.
HEALTH_OUT=$(npm run crawl:health 2>&1); HRC=$?
echo "$HEALTH_OUT"
if [ "$HRC" != "0" ]; then
  SUMMARY=$(echo "$HEALTH_OUT" | grep -E "마지막 실수집|연속 0건|사유" | tr '\n' ' ' | cut -c1-350)
  bash /home/ubuntu/.hermes/scripts/notify-telegram.sh "경매 크롤 헬스" "실패" \
    "신규 수집 굶음 — 차단/계정플래그/프록시 점검. ${SUMMARY}" 2>/dev/null || true
fi

exit $rc
