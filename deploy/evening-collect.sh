#!/usr/bin/env bash
# 저녁 2차 결과 수집 — 당일 오후 기일의 낙찰/유찰 결과를 같은 날 포착(collect:results 1차 활성 + 2차 소급).
#   pgj15A 소급이 있어 타이밍은 비필수지만, 같은 날 한 번 더 돌려 대시보드·학습 데이터를 더 신선하게 유지.
#   (06:00 daily-parse 와 별개. 2차 소급은 '6일 내 재수집 스킵' 가드로 저녁엔 대부분 스킵 → 중복 부하↓.)
cd /home/ubuntu/projects/gyeongmae-agent || exit 1
export PATH="/home/ubuntu/.local/bin:$PATH"
NOTIFY="scripts/notify-telegram.sh"   # 경매 전용 봇
echo "[$(date '+%F %T')] === evening collect start ==="
npm run collect:results
rc=$?
echo "[$(date '+%F %T')] === evening collect done (rc=$rc) ==="

# 관심물건(★) 변동 알림(발품절감 ②·⑤) — 당일 기일 결과(유찰/매각) 반영 직후가 가장 신선. 변동 시에만 발송.
WATCH=$(npm run --silent watch:favs 2>/dev/null)
if [ -n "$WATCH" ]; then
  bash "$NOTIFY" "관심물건 변동" "완료" "${WATCH}" 2>/dev/null || true
fi

# D-1 입찰 준비 패키지(발품절감 ③) — 내일 기일 매물의 보증금·법원·딥링크·준비물. 대상 있을 때만 발송.
PREP=$(npm run --silent bid:prep 2>/dev/null)
if [ -n "$PREP" ]; then
  bash "$NOTIFY" "내일 입찰 준비" "완료" "${PREP}" 2>/dev/null || true
fi
