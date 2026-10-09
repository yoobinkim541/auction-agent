#!/usr/bin/env bash
# 매일 학습 부가 배치 — daily-parse.sh에서 분리(2026-10-09). 결과 재수집(retry:outcomes)도 여기서 돈다.
#   이전에는 파싱 배치 끝에서 돌아 4시간 TimeoutStartSec를 함께 소진했고, 크롤이 길어진 날(10/1·10/2·10/7)
#   파싱 서비스째 SIGTERM으로 죽어 관심물건 알림·크롤 헬스·다이제스트까지 빠졌다.
#   파싱 창(06:00 KST + 최대 4h)이 닫힌 뒤 gyeongmae-learn.timer가 실행한다.
#
# 전부 bounded·claude CLI는 스크립트 내부 백오프. 단계별 실패는 무시하고 다음 단계로 간다(본 배치 무관).
#  - registry-opinion: EMPTY_REGISTRY 단독 hold 물건에 AI 1차 소견(다음날 analyze가 조회해 hold→conditional 완화).
#  - eval:postmortem: 서프라이즈 케이스 정성 복기(Phase3) 점진 축적.
#  - ml:eval: 오프라인 ML 리포트 갱신(report-only, 운영 미반영).
#  - ml:shadow: trusted 결과로 앙상블 재학습 후 예정 매물 shadow 점수만 갱신.
# claude CLI 호출량 억제(memo 단계와 합산): registry 30 + postmortem 최대 15(타입3×5) + 3s 간격.
GYEONGMAE_PROJECT_DIR="${GYEONGMAE_PROJECT_DIR:-/home/ubuntu/projects/gyeongmae-agent}"
cd "$GYEONGMAE_PROJECT_DIR" || exit 1
export PATH="/home/ubuntu/.local/bin:$PATH"
echo "[$(date '+%F %T')] === learn start ==="

# 미매칭 스냅샷 재수집(Phase2 미매칭률 감소) — 법원 사이트를 치는 유일한 단계라 맨 앞에서 끝내
# 사진 보강(12:37 KST)과 겹치지 않게 한다. 24h 쿨다운·항목간 지연은 스크립트 내부에서 관리.
#   400 = 2026-08-26 버스트 차단 사건 이전 단일 실행 기준 무지연 500건까지 무차단 확인됨 + 이후 항목간 300ms 지연 추가로 여유 확보.
#   예산 100분 = 400건 × 실측 약 11초(≈75분) + 여유.
OUTCOME_RETRY_LIMIT="${OUTCOME_RETRY_LIMIT:-400}" \
OUTCOME_RETRY_TIME_BUDGET_MS="${OUTCOME_RETRY_TIME_BUDGET_MS:-6000000}" \
  npm run retry:outcomes 2>&1 || echo "[retry:outcomes] 실패(무시)"

REGISTRY_OPINION_LIMIT="${REGISTRY_OPINION_LIMIT:-30}" npm run registry-opinion:backfill 2>&1 || echo "[registry-opinion] 실패(무시)"
POSTMORTEM_LIMIT="${POSTMORTEM_LIMIT:-5}" npm run eval:postmortem 2>&1 || echo "[eval:postmortem] 실패(무시)"
npm run ml:eval 2>&1 || echo "[ml:eval] 실패(무시)"
ML_SHADOW_LEAD_DAYS="${ML_SHADOW_LEAD_DAYS:-30}" npm run ml:shadow 2>&1 || echo "[ml:shadow] 실패(무시)"

echo "[$(date '+%F %T')] === learn done ==="
