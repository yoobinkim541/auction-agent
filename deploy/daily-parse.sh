#!/usr/bin/env bash
# 매일 자동 파싱: 법원경매(courtauction) 크롤(메인, 풀 수집) → 전체 재분석.
#   더낙찰옥션은 계정 단위 차단(데이터센터 IP 로그인이 트리거)이라 일일 배치에서 제외 — 필요 시 수동 실행.
#   (과거: 옵션 없는 `npm run crawl` = 더낙찰 메인 → 차단으로 매일 굶거나 폴백 축소수집(200건)만 됨)
#
# 크롤이 실패해도(접속차단·로그인 폼 변경·네트워크 등) 분석은 항상 수행한다.
#   분석은 DB(기존 등기/명세서 + gm_molit_cache 영구 캐시)만으로도 income·시세·리포트를 갱신하므로,
#   크롤 한 번의 실패가 전체 분석 갱신을 막아선 안 된다. (과거: set -e + crawl 실패 → analyze 통째 스킵 버그)
GYEONGMAE_PROJECT_DIR="${GYEONGMAE_PROJECT_DIR:-/home/ubuntu/projects/gyeongmae-agent}"
cd "$GYEONGMAE_PROJECT_DIR" || exit 1
export PATH="/home/ubuntu/.local/bin:$PATH"
NOTIFY="scripts/notify-telegram.sh"   # 경매 전용 봇(GM_TELEGRAM_*) — 스톡봇(.hermes) 공용 스크립트 대체
source deploy/precision-daily-gate.sh
echo "[$(date '+%F %T')] === parse start ==="

COURT_BID_DAYS="${COURT_BID_DAYS:-180}" npm run crawl -- --source=courtauction --incremental --max=10000 --max-new=500 --all-types --region=서울,경기
CRAWL_RC=$?
if [ "$CRAWL_RC" = "0" ]; then
  echo "[$(date '+%F %T')] crawl ok"
else
  echo "[$(date '+%F %T')] ⚠ crawl 실패(rc=$CRAWL_RC) — 분석은 계속 진행(DB·캐시 기반)"
  # 침묵 방지: 크롤 실패는 if/else로 삼켜져 스크립트가 exit 0 → systemd OnFailure가 안 뜬다.
  # 당일 즉시 알림(crawl:health의 48h 신선도 경보보다 빠른 조기경보). 분석 rc는 보존.
  bash "$NOTIFY" "경매 크롤 실패" "실패" \
    "일일 크롤 비정상 종료(rc=$CRAWL_RC) — 직접접속/네트워크·프록시 점검 필요. 분석은 DB·캐시로 계속." 2>/dev/null || true
fi

npm run analyze -- --all
rc=$?
echo "[$(date '+%F %T')] === parse done (analyze rc=$rc) ==="

# 학습 데이터 적재(결과 피드백 루프) — 실패해도 본 분석 rc는 보존.
#  Phase 0: 매각 임박 예측 동결(analyze 직후라 최신). Phase 1: 최근 매각결과(낙찰가/유찰) 수집.
npm run snapshot 2>&1 || echo "[snapshot] 실패(무시)"
npm run collect:results 2>&1 || echo "[collect:results] 실패(무시)"

# 미매칭 스냅샷 재수집(Phase2 미매칭률 감소) — bounded batch, 24h 쿨다운·항목간 지연은 스크립트 내부에서 관리.
#   400 = 2026-08-26 버스트 차단 사건 이전 단일 실행 기준 무지연 500건까지 무차단 확인됨 + 이후 항목간 300ms 지연 추가로 여유 확보.
OUTCOME_RETRY_LIMIT="${OUTCOME_RETRY_LIMIT:-400}" npm run retry:outcomes 2>&1 || echo "[retry:outcomes] 실패(무시)"

# 최근 2일에 실제 갱신된 원천만 제한 처리하고, 정밀 안전 감사를 통과해야 정밀 다이제스트를 허용한다.
# 실패해도 analyze rc와 레거시 분석/사진 데이터는 그대로 보존한다.
PRECISION_DIGEST_ALLOWED=1
if ! run_precision_refresh_and_audit; then
  PRECISION_DIGEST_ALLOWED=0
fi

# 관심물건(★) 변동 알림(발품절감 ②·⑤) — 기일/유찰/최저가/문서갱신 diff. 변동 있을 때만 stdout → 발송.
WATCH=$(npm run --silent watch:favs 2>/dev/null)
if [ -n "$WATCH" ]; then
  bash "$NOTIFY" "관심물건 변동" "완료" "${WATCH}" 2>/dev/null || true
fi

# 수집 헬스: status=ok·0건(굶음) 감지 → 비정상이면 텔레그램 알림. 분석 rc는 보존.
HEALTH_OUT=$(npm run crawl:health 2>&1); HRC=$?
echo "$HEALTH_OUT"
if [ "$HRC" != "0" ]; then
  SUMMARY=$(echo "$HEALTH_OUT" | grep -E "마지막 실수집|연속 0건|사유" | tr '\n' ' ' | cut -c1-350)
  bash "$NOTIFY" "경매 크롤 헬스" "실패" \
    "신규 수집 굶음 — 차단/계정플래그/프록시 점검. ${SUMMARY}" 2>/dev/null || true
fi

# 일일 정밀 추천 다이제스트 + 복기(학습) 커버리지 한 줄. 감사 실패 시 정밀 다이제스트만 생략한다.
EVAL=$(npm run --silent eval:report -- --summary 2>/dev/null)
run_precision_digest "$PRECISION_DIGEST_ALLOWED" "$EVAL"

# 학습 게이트 도달(매칭≥EVAL_GATE) 첫날 1회 — 전체 복기 리포트 + "이어서 진행" 알림. 마커로 재발송 방지.
GATE_MARK="$HOME/.gyeongmae-phase2-alerted"
if echo "$EVAL" | grep -q "시작 가능" && [ ! -f "$GATE_MARK" ]; then
  FULL=$(npm run --silent eval:report 2>/dev/null)
  bash "$NOTIFY" "경매 학습 Phase2 준비" "완료" \
    "복기 데이터 게이트 도달 — Claude 세션에서 '진행해'로 Phase 2(복기·모델) 이어가세요.

${FULL}" 2>/dev/null && touch "$GATE_MARK" || true
fi

exit $rc
