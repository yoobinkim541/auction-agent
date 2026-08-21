# 정밀 추천 운영 절차

## 1. 배포 순서

운영 DB를 백업하고 아래 마이그레이션을 반드시 순서대로 적용한다. 모든 명령은 `DATABASE_URL`을 출력하지 않는 셸에서 실행한다.

```bash
pg_dump "$DATABASE_URL" --format=custom --file="/tmp/gyeongmae-precision-$(date +%F-%H%M%S).dump"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrate_precision_data_trust.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrate_precision_recommendations.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrate_decision_journal.sql
```

신뢰성 테이블과 `gm_trusted_outcome_eval`이 먼저 있어야 정밀 평가가 안전하게 저장되고, 정밀 평가가 있어야 결정 이벤트가 정확한 판정 스냅샷을 보존한다. 마이그레이션 실패 시 다음 단계로 진행하지 않는다.

## 2. 백필

초기 전체 백필은 대상 행 수 이상인 명시적 한도를 한 번에 지정한다. 현재 명령은 offset/cursor 페이지네이션이 없으므로 작은 한도를 반복하면 같은 최신 행을 다시 처리한다. `--since-days`를 생략하면 최신순 전체 범위에서 `--limit`까지만 처리한다.

```bash
npm run trust:backfill -- --limit=50000
npm run precision:backfill -- --limit=50000
```

일일 배치는 다음 명령을 실행한다. 두 명령 모두 행 수와 실제 시간 범위를 동시에 제한하며 추천 슬롯을 채우기 위해 게이트를 완화하지 않는다.

```bash
npm run trust:backfill -- --limit=500 --since-days=2
npm run precision:backfill -- --limit=500 --since-days=2
```

- `PRECISION_TRUST_BACKFILL_LIMIT`: 일일 신뢰성 백필 한도, 기본 `500`.
- `PRECISION_BACKFILL_LIMIT`: 일일 정밀 평가 백필 한도, 기본 `500`.
- `--since-days=2`: `1` 이상의 정수만 허용한다. `--limit`만 사용하는 것은 최근 2일 선택을 의미하지 않는다.
- `--since-days` 모드에서는 원천 최신 시각이 범위 안에 있고 현재 신뢰/정밀 평가가 없거나 원천보다 오래된 행만 처리한다. 평가를 마친 상위 N건은 다음 실행에서 제외되므로 같은 2일 창 안의 나머지 행이 후속 실행에서 따라잡는다.
- `--since-days`를 생략한 전체 백필은 평가 최신성과 무관하게 모든 행을 최신순으로 다시 처리하므로 평가기 버전 교체에도 사용할 수 있다.
- 매물 신뢰성 범위는 `gm_listings.crawled_at`, 권리·입지 `analyzed_at`, 문서 `created_at` 중 최신 시각으로 선택한다.
- 정밀 평가 범위는 매물 수집, 권리·입지 분석, `gm_data_trust.evaluated_at` 중 최신 시각으로 선택한다.
- 결과 신뢰성 범위는 결과 자체의 관측 시각인 `gm_prediction_snapshots.snapped_at` 또는 `gm_auction_results.captured_at`으로 선택한다. 매물 분석 시각으로 결과 행을 대신 선택하지 않는다.

## 3. 감사

```bash
npm run precision:audit
```

감사는 DB를 수정하지 않고 정확한 SQL 집계만 JSON으로 출력한다.

- `ok`: 모든 안전 불변조건 통과 여부.
- `failures`: 추천인데 비신뢰 데이터, 인수금액 존재, 절대 상한이 최저가보다 낮음, 동일 사건 대표 중복, 후보 7건 초과.
- `warnings`: 추천 0건. 이는 경고일 뿐 실패가 아니며 후보 수를 채우려고 게이트를 완화해서는 안 된다.
- `metrics`: 정밀·매물 신뢰·결과 신뢰 상태 분포, 상위 보류/격리 사유, 현재 후보의 결정 전환, 신뢰 결과 커버리지.

종료코드는 `0`(안전, 경고 가능), `1`(안전 불변조건 실패), `2`(DB/실행 오류)다. `1` 또는 `2`이면 정밀 다이제스트를 보내지 않는다. 기존 분석, 레거시 목록, 사진 파일과 사진 메타데이터는 삭제하거나 되돌리지 않는다.

## 4. 일일 배치와 기능 플래그

`deploy/daily-parse.sh`는 분석과 결과 수집 뒤, 다이제스트 전에 최근 2일 신뢰성 백필 → 정밀 백필 → 감사를 실행한다. 갱신 또는 감사가 실패하면 기존 텔레그램 실패 경로로 알리고 정밀 다이제스트만 생략한다. 마지막 종료코드는 기존 `analyze` 반환값을 유지한다.

정밀 다이제스트 기능 플래그는 기본 활성이다.

```bash
PRECISION_DIGEST_ENABLED=0 deploy/daily-parse.sh
```

systemd에서는 `gyeongmae-parse.service` override에 `Environment=PRECISION_DIGEST_ENABLED=0`을 넣고 `sudo systemctl daemon-reload` 후 다음 실행부터 적용한다. 이 플래그는 정밀 다이제스트만 끄며 레거시 수집·분석·복기 작업은 유지한다.

현재 웹 번들은 별도 런타임 환경변수 플래그를 읽지 않는다. 대시보드 롤백은 정밀 API 경로를 비활성화해 기존 오류 fallback의 `전체 사건 목록 보기`를 사용하거나, 검증된 이전 웹 번들을 재배포한다. 기존 점수를 정밀 추천으로 표시해서는 안 된다.

## 5. 서비스 재시작과 스모크 체크

```bash
sudo systemctl restart gyeongmae-api.service gyeongmae-web.service
systemctl is-active gyeongmae-api.service gyeongmae-web.service
systemctl is-enabled gyeongmae-parse.timer
systemctl list-timers gyeongmae-parse.timer --no-pager
```

```bash
curl -fsS http://localhost:8080/api/health
curl -fsS 'http://localhost:8080/api/recommendations/precision?limit=5' \
  | jq -e 'length <= 5 and all(.[]; .precision.status == "recommended")'
curl -fsS 'http://localhost:8080/api/listings?limit=1' | jq -e 'type == "array"'
curl -fsS 'http://localhost:8080/api/review/decisions' | jq -e 'type == "object"'
npm run precision:audit
```

정밀 API가 실패해도 레거시 `/api/listings`가 정상이고 웹에서 정밀 추천으로 오인하지 않는지 확인한다. 운영 재시작과 실제 결정 POST는 Task 10 배포 QA에서 수행한다.

## 6. 롤백

1. `PRECISION_DIGEST_ENABLED=0`으로 정밀 텔레그램 발송을 즉시 중단한다.
2. 정밀 API 경로를 끄거나 검증된 이전 웹 번들을 배포해 사용자를 기존 전체 목록으로 돌린다.
3. `gm_data_trust`, `gm_outcome_trust`, `gm_precision_evaluations`, `gm_decision_events`는 삭제하지 않는다.
4. `npm run precision:audit` 결과와 상위 보류/격리 사유를 보존한 뒤 원인을 수정한다.
5. 수정 후 최근 2일 제한 백필과 감사를 다시 통과한 경우에만 정밀 다이제스트를 활성화한다.

추천 수가 0~2건이어도 하드 게이트, 신뢰 상태, 입찰 상한 또는 주간 7건 제한을 완화하지 않는다.

## 7. 학습 데이터 안전 규칙

`gm_outcome_eval`은 원시 커버리지와 누락률 감사에만 사용한다. 모델 학습, 가격 보정, 오차 지표, 섀도우 모델 평가는 반드시 `gm_trusted_outcome_eval`을 사용한다. `gm_outcome_eval`에서 직접 학습 파일이나 피처를 만들지 않는다.
