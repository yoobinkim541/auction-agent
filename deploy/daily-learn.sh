#!/usr/bin/env bash
# 매일 학습 부가 배치 — daily-parse.sh에서 분리(2026-10-09).
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

REGISTRY_OPINION_LIMIT="${REGISTRY_OPINION_LIMIT:-30}" npm run registry-opinion:backfill 2>&1 || echo "[registry-opinion] 실패(무시)"
POSTMORTEM_LIMIT="${POSTMORTEM_LIMIT:-5}" npm run eval:postmortem 2>&1 || echo "[eval:postmortem] 실패(무시)"
npm run ml:eval 2>&1 || echo "[ml:eval] 실패(무시)"
ML_SHADOW_LEAD_DAYS="${ML_SHADOW_LEAD_DAYS:-30}" npm run ml:shadow 2>&1 || echo "[ml:shadow] 실패(무시)"

echo "[$(date '+%F %T')] === learn done ==="
