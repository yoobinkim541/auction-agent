#!/usr/bin/env bash
# 집-IP SOCKS 터널(127.0.0.1:1080) 헬스체크 — egress가 터널을 안 타면(다운) 텔레그램 알림.
# 상태가 '바뀔 때만' 알림(다운 진입 / 복구) → 스팸 없음.
# cron 권장: 0 */3 * * *  (3시간마다). 새벽 크롤(21:00 UTC) 전에 다운을 미리 감지.
PORT=1080
STATE=/tmp/gm-tunnel-state
# 경매 전용 봇(GM_TELEGRAM_*) — cron이 어디서 실행하든 스크립트 기준 상대경로로 해석
NOTIFY="$(cd "$(dirname "$0")" && pwd)/notify-telegram.sh"

direct=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null)
egress=$(curl -s --socks5-hostname 127.0.0.1:"$PORT" --max-time 12 https://api.ipify.org 2>/dev/null)

# 터널 정상 = egress 성공 && VM 직접 IP와 다름(=집 회선으로 나감)
if [ -n "$egress" ] && [ "$egress" != "$direct" ]; then cur=up; else cur=down; fi

prev=$(cat "$STATE" 2>/dev/null || echo unknown)
echo "$cur" > "$STATE"

if [ "$cur" != "$prev" ]; then
  if [ "$cur" = down ]; then
    bash "$NOTIFY" "경매 터널" "실패" "집-IP SOCKS 터널 다운(egress=${egress:-실패}, VM직접=${direct:-?}). 집 PC AuctionTunnel 작업/네트워크 점검 필요." 2>/dev/null || true
  elif [ "$prev" = down ]; then
    bash "$NOTIFY" "경매 터널" "완료" "터널 복구(egress=$egress)." 2>/dev/null || true
  fi
fi
echo "[$(date '+%F %T')] tunnel=$cur egress=${egress:-fail} direct=${direct:-fail}"
