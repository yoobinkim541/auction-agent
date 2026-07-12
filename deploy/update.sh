#!/usr/bin/env bash
# 원클릭 배포 — git pull → (변경된 것만) 의존성/웹빌드 → 스키마 적용 → 서비스 재시작 → 텔레그램 완료 알림.
#   사용: bash deploy/update.sh        (또는 경매봇에서 /update)
#   요구: ubuntu 계정에 systemctl 재시작 sudo 허용(NOPASSWD). 없으면:
#     echo 'ubuntu ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart gyeongmae-*' | sudo tee /etc/sudoers.d/gyeongmae
set -u
cd /home/ubuntu/projects/gyeongmae-agent || exit 1
export PATH="/home/ubuntu/.local/bin:$PATH"
NOTIFY="scripts/notify-telegram.sh"
LOG="deploy/update.log"

say() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
fail() { say "✖ $*"; bash "$NOTIFY" "배포" "실패" "$* — deploy/update.log 확인" 2>/dev/null || true; exit 1; }

say "=== update start ==="
OLD=$(git rev-parse HEAD)
git pull --ff-only 2>&1 | tee -a "$LOG" || fail "git pull 실패(로컬 변경/충돌?)"
NEW=$(git rev-parse HEAD)

if [ "$OLD" = "$NEW" ]; then
  say "변경 없음 (${NEW:0:7})"
  bash "$NOTIFY" "배포" "완료" "이미 최신입니다 (${NEW:0:7})" 2>/dev/null || true
  exit 0
fi

CHANGED=$(git diff --name-only "$OLD" "$NEW")
say "변경 파일 $(echo "$CHANGED" | wc -l)건 (${OLD:0:7}→${NEW:0:7})"
DONE=""

# 의존성 — 락파일이 바뀐 쪽만
if echo "$CHANGED" | grep -q '^package-lock.json'; then
  npm ci >>"$LOG" 2>&1 || fail "npm ci 실패"
  DONE="$DONE deps"
fi
if echo "$CHANGED" | grep -q '^web/package-lock.json'; then
  (cd web && npm ci) >>"$LOG" 2>&1 || fail "web npm ci 실패"
  DONE="$DONE web-deps"
fi

# 스키마 — idempotent(create table if not exists)라 변경 시 재적용만으로 안전
if echo "$CHANGED" | grep -q '^db/schema.sql'; then
  psql -d gyeongmae -f db/schema.sql >>"$LOG" 2>&1 || fail "schema 적용 실패"
  DONE="$DONE schema"
fi

# 웹 — 빌드 후 재시작(vite preview는 dist 서빙)
if echo "$CHANGED" | grep -q '^web/'; then
  (cd web && npm run build) >>"$LOG" 2>&1 || fail "web build 실패"
  sudo -n systemctl restart gyeongmae-web 2>>"$LOG" || fail "gyeongmae-web 재시작 실패(sudo 권한?)"
  DONE="$DONE web"
fi

# API — start-api.sh(mvn spring-boot:run)가 기동 시 재빌드
if echo "$CHANGED" | grep -q '^server/'; then
  sudo -n systemctl restart gyeongmae-api 2>>"$LOG" || fail "gyeongmae-api 재시작 실패(sudo 권한?)"
  DONE="$DONE api"
fi

# 완료 알림을 봇 재시작보다 먼저 — 봇이 이 스크립트를 띄운 경우에도 알림 유실 없음
SUMMARY="배포 완료 ${OLD:0:7}→${NEW:0:7}${DONE:+ · 적용:$DONE}"
say "$SUMMARY"
bash "$NOTIFY" "배포" "완료" "$SUMMARY
$(git log --oneline "$OLD".."$NEW" | head -5)" 2>/dev/null || true

# 봇/파이프라인 — TS는 tsx 실행이라 빌드 불필요, 재시작만. 봇은 맨 마지막(자기 자신을 죽이므로).
if echo "$CHANGED" | grep -Eq '^(scripts/|shared/|crawler/|pipeline/|package)'; then
  sudo -n systemctl restart gyeongmae-bot 2>>"$LOG" || say "⚠ gyeongmae-bot 재시작 실패(sudo 권한?) — 수동 재시작 필요"
fi
say "=== update done ==="
