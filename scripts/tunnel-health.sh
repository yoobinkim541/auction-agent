#!/usr/bin/env bash
# 집-IP SOCKS 터널(127.0.0.1:1080) 헬스체크 — 등록된 집 IP로 나갈 때만 정상 처리.
# 상태가 '바뀔 때만' 알림(다운 진입 / 복구) → 스팸 없음.
# cron 권장: 0 */3 * * *  (3시간마다). 새벽 크롤(21:00 UTC) 전에 다운을 미리 감지.
PORT=1080
STATE=/tmp/gm-tunnel-state
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 경매 전용 봇(GM_TELEGRAM_*) — cron이 어디서 실행하든 스크립트 기준 상대경로로 해석
NOTIFY="$ROOT/scripts/notify-telegram.sh"

# cron 환경에서도 등록 집 IP 목록을 읽는다. 환경변수가 이미 있으면 그 값을 우선한다.
if [ -z "${CRAWL_HOME_IPS:-}" ] && [ -f "$ROOT/.env" ]; then
  CRAWL_HOME_IPS=$(sed -n "s/^CRAWL_HOME_IPS=//p" "$ROOT/.env" | tail -n 1 | tr -d "'\"")
fi

contains_home_ip() {
  needle="$1"
  list="$2"
  old_ifs="$IFS"
  IFS=','
  for ip in $list; do
    ip=$(printf '%s' "$ip" | tr -d '[:space:]')
    if [ -n "$ip" ] && [ "$ip" = "$needle" ]; then
      IFS="$old_ifs"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

direct=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null)
egress=$(curl -s --socks5-hostname 127.0.0.1:"$PORT" --max-time 12 https://api.ipify.org 2>/dev/null)

# 터널 정상 = egress 성공 && VM 직접 IP와 다름 && 등록 집 IP와 정확히 일치.
if [ -n "$egress" ] && [ "$egress" != "$direct" ] && contains_home_ip "$egress" "${CRAWL_HOME_IPS:-}"; then
  cur=up
else
  cur=down
fi

prev=$(cat "$STATE" 2>/dev/null || echo unknown)
echo "$cur" > "$STATE"

if [ "$cur" != "$prev" ]; then
  if [ "$cur" = down ]; then
    bash "$NOTIFY" "경매 터널" "실패" "집-IP SOCKS 터널 검증 실패(egress=${egress:-실패}, VM직접=${direct:-?}, 등록집IP=${CRAWL_HOME_IPS:-미설정}). CRAWL_HOME_IPS/집 PC AuctionTunnel/네트워크 점검 필요." 2>/dev/null || true
  elif [ "$prev" = down ]; then
    bash "$NOTIFY" "경매 터널" "완료" "터널 복구(egress=$egress, 등록 집 IP 확인)." 2>/dev/null || true
  fi
fi
echo "[$(date '+%F %T')] tunnel=$cur egress=${egress:-fail} direct=${direct:-fail} home_ips=${CRAWL_HOME_IPS:-unset}"
