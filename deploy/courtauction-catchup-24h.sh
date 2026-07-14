#!/usr/bin/env bash
# 법원경매 24h 캐치업: 단일 장기 실행은 종료 전까지 DB 저장이 안 되므로 법원 단위로 쪼개 저장한다.
set -u
cd /home/ubuntu/projects/gyeongmae-agent || exit 1
export PATH="/home/ubuntu/.local/bin:$PATH"

TOTAL_SECONDS="${COURT_CATCHUP_SECONDS:-86400}"
COURTS=(
  B000210 B000211 B000212 B000213 B000215
  B000214 B214804 B214807
  B000250 B000251 B000252 B000253 B250826 B000254
)

export COURT_BID_START_OFFSET_DAYS="${COURT_BID_START_OFFSET_DAYS:-0}"
export COURT_BID_DAYS="${COURT_BID_DAYS:-365}"
export COURT_PAGE_SIZE="${COURT_PAGE_SIZE:-40}"
export COURT_MIN_REQ_INTERVAL_MS="${COURT_MIN_REQ_INTERVAL_MS:-500}"
export COURT_PAGE_DWELL_MIN_MS="${COURT_PAGE_DWELL_MIN_MS:-150}"
export COURT_PAGE_DWELL_MAX_MS="${COURT_PAGE_DWELL_MAX_MS:-500}"
export COURT_DETAIL_DWELL_MIN_MS="${COURT_DETAIL_DWELL_MIN_MS:-350}"
export COURT_DETAIL_DWELL_MAX_MS="${COURT_DETAIL_DWELL_MAX_MS:-900}"
export COURT_DETAIL_LONG_DWELL_CHANCE="${COURT_DETAIL_LONG_DWELL_CHANCE:-0.005}"
export COURT_DETAIL_LONG_DWELL_MIN_MS="${COURT_DETAIL_LONG_DWELL_MIN_MS:-2500}"
export COURT_DETAIL_LONG_DWELL_MAX_MS="${COURT_DETAIL_LONG_DWELL_MAX_MS:-5000}"
export COURT_BREAK_EVERY_MIN="${COURT_BREAK_EVERY_MIN:-100000}"
export COURT_BREAK_EVERY_MAX="${COURT_BREAK_EVERY_MAX:-120000}"
export COURT_BREAK_DWELL_MIN_MS="${COURT_BREAK_DWELL_MIN_MS:-0}"
export COURT_BREAK_DWELL_MAX_MS="${COURT_BREAK_DWELL_MAX_MS:-0}"

MAX_NEW_PER_COURT="${COURT_CATCHUP_MAX_NEW_PER_COURT:-5000}"
MAX_REFRESH_PER_COURT="${COURT_CATCHUP_MAX_REFRESH_PER_COURT:-3000}"
MAX_ITEMS_PER_COURT="${COURT_CATCHUP_MAX_ITEMS_PER_COURT:-20000}"
PER_COURT_TIMEOUT="${COURT_CATCHUP_PER_COURT_TIMEOUT:-3600}"
END_AT=$(( $(date +%s) + TOTAL_SECONDS ))

echo "[$(date '+%F %T')] courtauction 24h catchup start (${TOTAL_SECONDS}s)"
echo "settings: bidStart=${COURT_BID_START_OFFSET_DAYS}, bidDays=${COURT_BID_DAYS}, pageSize=${COURT_PAGE_SIZE}, minReqMs=${COURT_MIN_REQ_INTERVAL_MS}"

while [ "$(date +%s)" -lt "$END_AT" ]; do
  for court in "${COURTS[@]}"; do
    now=$(date +%s)
    if [ "$now" -ge "$END_AT" ]; then break; fi
    remain=$(( END_AT - now ))
    court_timeout="$remain"
    if [ "$court_timeout" -gt "$PER_COURT_TIMEOUT" ]; then court_timeout="$PER_COURT_TIMEOUT"; fi
    echo "[$(date '+%F %T')] >>> court=${court} remain=${remain}s courtTimeout=${court_timeout}s"
    timeout "$court_timeout" npm run crawl -- \
      --source=courtauction \
      --incremental \
      --max="${MAX_ITEMS_PER_COURT}" \
      --max-new="${MAX_NEW_PER_COURT}" \
      --max-refresh="${MAX_REFRESH_PER_COURT}" \
      --refresh-days=365 \
      --all-types \
      --region="${court}"
    rc=$?
    echo "[$(date '+%F %T')] <<< court=${court} rc=${rc}"
    if [ "$rc" = "124" ]; then
      echo "[$(date '+%F %T')] court timeout reached — next court"
    fi
    sleep 3
  done
done

echo "[$(date '+%F %T')] courtauction 24h catchup done"
