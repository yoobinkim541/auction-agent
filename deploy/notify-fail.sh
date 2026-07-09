#!/usr/bin/env bash
# systemd OnFailure 훅 — 배치(파싱/수집) 유닛이 죽으면 경매봇으로 알림(완전 무음 방지).
# 인자 %1 = 실패한 유닛명(예: gyeongmae-parse.service).
cd /home/ubuntu/projects/gyeongmae-agent || exit 0
export PATH="/home/ubuntu/.local/bin:$PATH"
UNIT="${1:-?}"
TAIL=$(journalctl -u "$UNIT" --no-pager -n 8 2>/dev/null | tail -8)
bash scripts/notify-telegram.sh "경매 배치 실패" "실패" "유닛 ${UNIT} 비정상 종료 — 로그 확인 필요.
${TAIL}" || true
