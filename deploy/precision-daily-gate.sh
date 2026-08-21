#!/usr/bin/env bash

precision_gate_failure_notify() {
  local details="$1"
  if [ -n "${NOTIFY:-}" ]; then
    bash "$NOTIFY" "정밀 추천 감사" "실패" "$details" 2>/dev/null || true
  fi
}

run_precision_refresh_and_audit() {
  local trust_limit="${PRECISION_TRUST_BACKFILL_LIMIT:-500}"
  local precision_limit="${PRECISION_BACKFILL_LIMIT:-500}"
  local since_days=2
  local trust_rc=0
  local precision_rc=0
  local audit_rc=0
  local audit_out

  npm run trust:backfill -- --limit="$trust_limit" --since-days="$since_days" || trust_rc=$?
  npm run precision:backfill -- --limit="$precision_limit" --since-days="$since_days" || precision_rc=$?
  audit_out=$(npm run --silent precision:audit 2>&1) || audit_rc=$?
  printf '%s\n' "$audit_out"

  if [ "$trust_rc" -ne 0 ] || [ "$precision_rc" -ne 0 ] || [ "$audit_rc" -ne 0 ]; then
    precision_gate_failure_notify "정밀 추천 일일 게이트 실패 — trust rc=$trust_rc, precision rc=$precision_rc, audit rc=$audit_rc. 레거시 분석·사진은 유지하고 정밀 다이제스트만 중단합니다. ${audit_out:0:700}"
    return 1
  fi
  return 0
}

run_precision_digest() {
  local gate_open="$1"
  local evaluation_summary="$2"
  local digest

  if [ "${PRECISION_DIGEST_ENABLED:-1}" != "1" ]; then
    echo "[precision:digest] PRECISION_DIGEST_ENABLED 비활성 — 정밀 다이제스트 생략"
    return 0
  fi
  if [ "$gate_open" != "1" ]; then
    echo "[precision:digest] 안전 감사 실패 — 정밀 다이제스트 생략"
    return 0
  fi

  digest=$(npm run --silent digest 2>/dev/null)
  if [ -n "$digest" ]; then
    bash "$NOTIFY" "경매 추천" "완료" "${digest}
${evaluation_summary}" 2>/dev/null || true
  fi
}
