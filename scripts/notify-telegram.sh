#!/usr/bin/env bash
# 경매 전용 텔레그램 알림 — .hermes(스톡봇) 공용 스크립트 의존 제거.
#   사용: bash scripts/notify-telegram.sh "제목" "상태(완료|실패)" "본문"
#   설정: GM_TELEGRAM_BOT_TOKEN · GM_TELEGRAM_CHAT_ID (환경변수 또는 리포 루트 .env)
#   폴백: 둘 다 미설정이면 기존 .hermes 스크립트로 폴백 — 새 봇 설정 전에도 알림 유실 방지.
#         (경매 봇을 만들었으면 .env에 GM_TELEGRAM_* 두 줄만 추가하면 그쪽으로만 발송됨)
set -u

TITLE=${1:-알림}
STATUS=${2:-완료}
BODY=${3:-}

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)

# .env에서 GM_TELEGRAM_* 두 키만 읽는다(다른 변수로 환경 오염 방지)
if [ -f "$REPO_DIR/.env" ]; then
  [ -z "${GM_TELEGRAM_BOT_TOKEN:-}" ] && GM_TELEGRAM_BOT_TOKEN=$(sed -n 's/^GM_TELEGRAM_BOT_TOKEN=//p' "$REPO_DIR/.env" | tail -1)
  [ -z "${GM_TELEGRAM_CHAT_ID:-}" ] && GM_TELEGRAM_CHAT_ID=$(sed -n 's/^GM_TELEGRAM_CHAT_ID=//p' "$REPO_DIR/.env" | tail -1)
fi

LEGACY=/home/ubuntu/.hermes/scripts/notify-telegram.sh
if [ -z "${GM_TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${GM_TELEGRAM_CHAT_ID:-}" ]; then
  if [ -f "$LEGACY" ]; then
    echo "[notify] GM_TELEGRAM_* 미설정 — 임시로 기존(.hermes) 봇으로 폴백. .env에 경매 봇 토큰/챗ID를 추가하세요." >&2
    exec bash "$LEGACY" "$TITLE" "$STATUS" "$BODY"
  fi
  echo "[notify] GM_TELEGRAM_BOT_TOKEN/GM_TELEGRAM_CHAT_ID 미설정 — 발송 생략" >&2
  exit 1
fi

case "$STATUS" in
  실패*) ICON="🚨" ;;
  완료*) ICON="✅" ;;
  *)     ICON="ℹ️" ;;
esac

TEXT="${ICON} [${TITLE}] ${STATUS}
${BODY}"
TEXT=${TEXT:0:3900} # 텔레그램 메시지 한도(4096자) 여유 컷

RES=$(curl -sS --max-time 15 --retry 2 -X POST \
  "https://api.telegram.org/bot${GM_TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${GM_TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${TEXT}" \
  --data-urlencode "disable_web_page_preview=true" 2>&1)

if ! echo "$RES" | grep -q '"ok":true'; then
  echo "[notify] 텔레그램 발송 실패: ${RES:0:300}" >&2
  exit 1
fi
