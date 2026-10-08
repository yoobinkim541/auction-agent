# 정밀 추천 운영 배포 최종 QA

- 검증일: 2026-08-21 UTC
- 배포 대상: `/home/ubuntu/projects/gyeongmae-agent`
- 배포 소스: `codex/precision-first-auction-agent`의 `591fcc270fbba93c7a85a677784d7b704a9ae232`
- 운영 브랜치: `codex/courtauction-photo-lifecycle`

## 1. 배포 전 보호 조치

- 운영 체크아웃의 `artifacts/listing-photos` 삭제·추가 196건은 런타임 상태로 간주해 stage, reset, commit하지 않았다.
- 전체 데이터 덤프는 실행 환경 정책상 허용되지 않아 재시도하거나 우회하지 않았다.
- 대신 스키마 전용 백업 `/tmp/gyeongmae-pre-precision-schema-20260821T1619Z.sql`을 생성했다.
  - 크기: 54 KiB
  - SHA-256: `f4c54e0fcd2652a6787a5084ade3ece87a6bb8f5abab07e1d82c838ef53a74e3`
- 정밀 추천·신뢰도 테이블은 원천을 수정하지 않는 파생 데이터이며 전체 백필로 재생성할 수 있다. 다만 실제 운영에서는 데이터 백업 권한이 있는 계정으로 전체 백업을 추가 확보한 뒤 배포해야 한다.

## 2. 마이그레이션과 데이터 검증

다음 마이그레이션을 `ON_ERROR_STOP=1`로 재실행해 멱등성을 확인했다.

```text
db/migrate_precision_data_trust.sql
db/migrate_precision_recommendations.sql
db/migrate_decision_journal.sql
```

최종 운영 행 수:

| 항목 | 행 수 |
|---|---:|
| 전체 매물 | 19,813 |
| 활성 매물 | 9,551 |
| 매물 신뢰 평가 | 19,813 |
| 결과 신뢰 평가 | 16,779 |
| 정밀 평가 | 19,813 |
| 정밀 추천 | 0 |
| 결정 이벤트 | 2 |
| 사진 메타 | 2,157 |
| 활성 사진 | 1,845 |
| 삭제 사진 | 312 |

결과 신뢰 백필은 중복 결과 fan-out 수정 후 정확히 16,779건을 평가했다. 분포는 `trusted=2,397`, `hold=7,871`, `quarantined=6,511`이다.

## 3. 정밀 안전 감사

`npm run precision:audit`는 종료코드 0과 `ok=true`를 반환했다.

- 비신뢰 추천: 0
- 인수금액이 있는 추천: 0
- 동일 사건 대표 중복: 0
- 절대 입찰상한이 최저가보다 낮은 추천: 0
- 현재 추천: 0
- 상태 분포: `conditional=133`, `hold=5,718`, `rejected=13,962`
- 경고: `ZERO_RECOMMENDATIONS`

추천 0건은 실패가 아니다. 데이터 보강이 끝날 때까지 일반 점수 매물을 정밀 추천으로 승격하거나 하드 게이트를 완화하지 않는다.

## 4. 자동 검증

| 검증 | 결과 |
|---|---|
| 루트 테스트 | 56 files 통과, 1 file skip, 573 tests 통과, DB 5 tests 기본 skip |
| PostgreSQL 통합 테스트 | 5/5 통과 (`RUN_PRECISION_DB_TESTS=1`) |
| TypeScript 타입체크 | 통과 |
| 웹 테스트 | 78/78 통과 |
| 웹 프로덕션 빌드 | 통과, Vite 48 modules |
| Spring 테스트 | 통과 |
| Spring 패키지 빌드 | 통과 |
| 배치 셸 구문 검사 | 통과 |

주요 P1 회귀는 한국어 `억/만원` 임차보증금 파싱, 다물건 사건의 `item_no` 격리, VM 여부만이 아니라 주거용 회선 증거를 요구하는 egress 검증 테스트로 고정했다.

## 5. 운영 적용과 API 스모크

운영 체크아웃을 `bd94e56`에서 `591fcc2`로 fast-forward하고 백엔드·프론트를 빌드한 뒤 2026-08-21 16:35:15 UTC에 두 서비스를 재시작했다.

- `gyeongmae-api.service`: active, enabled
- `gyeongmae-web.service`: active, enabled
- `/api/health`: 200, `ok=true`
- `/api/recommendations/precision?limit=5`: 200, 0건
- `/api/listings`: 200, 10,702건
- `/api/listings/2025타경102989`: 200
- `/api/listings/2181/decisions`: 200, reviewing 이벤트 2건
- `/api/review/decisions`: 200
- 운영 QA 결정 POST: 201, `reviewing`, 메모 `프로덕션 QA 2026-08-21`
- 활성 사진 `/api/listings/397494/photos/1e0969fa34785d4007f1be42886e5246031602f0ef5d0c68f9832ab52ec79d59.jpg`: 200, `image/jpeg`, 50,274 bytes, `Cache-Control: no-store`

비교 화면 QA를 위해 2개 매물을 일시 관심 등록했고 검증 직후 두 행 모두 원래 값 `false`로 복원했다.

## 6. 운영 브라우저 QA

Playwright Chromium으로 `http://127.0.0.1:5174/`을 데스크톱 1440×1000과 모바일 390×844에서 확인했다.

- 정밀 추천 0건 상태에 “오늘 신규 정밀 추천 없음”과 일반 목록 비승격 안내가 표시된다.
- 데스크톱과 모바일 모두 문서·상세 드로어 가로 오버플로가 0이다.
- 일반 목록 9,145건 중 첫 60건 가상 렌더링과 상세 드로어가 정상이다.
- 사진 매물 딥링크에서 700×311 이미지가 깨짐 없이 표시되고 모바일에서는 356px로 축소된다.
- 상세 드로어는 `role=dialog`, `aria-modal=true`이며 열릴 때 포커스를 받는다.
- 지도 Leaflet 캔버스, 복기/ML 6개 표, 임장 진행도 정렬, 관심 매물 2건 비교 화면을 확인했다.
- 브라우저 콘솔 오류, 페이지 오류, 접근성 alert 오류는 없었다.

QA 캡처는 런타임 임시 파일로만 보관했으며 저장소에 커밋하지 않았다.

## 7. 배치와 알림

- `gyeongmae-parse.timer`: active, enabled, 다음 실행 2026-08-21 21:00 UTC
- `gyeongmae-collect.timer`: active, enabled, 다음 실행 2026-08-22 11:00 UTC
- `gyeongmae-enrich.timer`: inactive, disabled — 배포 전 기준 상태와 동일
- parse/collect/enrich 서비스에 `OnFailure=gyeongmae-alert@%n.service`가 설정돼 있다.
- parse 타임아웃은 14,400초, collect 타임아웃은 1,800초다.
- `AUCTION_BOT_TOKEN`, `AUCTION_CHAT_ID`, `GM_TELEGRAM_CHAT_ID` 키 존재와 알림 스크립트의 alias fallback을 확인했다. 비밀값은 출력하지 않았다.
- 실제 Telegram 발송은 실행 환경의 외부 전송 승인 정책에서 거부되어 수행하지 않았다. 설정과 systemd 실패 라우팅 검증만 완료했으며, 운영자가 승인된 콘솔에서 테스트 메시지를 별도로 확인해야 한다.

## 8. 관찰된 운영 주의사항

- 실행 중인 JAR 경로에서 Maven 패키지를 덮어쓴 뒤 재시작해, 이전 JVM 종료 훅에서 지연 로딩 클래스 경고가 발생했다. 새 JVM은 정상 기동했고 이후 API 예외는 없다.
- 다음 배포부터는 별도 worktree에서 JAR을 빌드하고, API를 중지한 짧은 구간에 검증된 JAR을 원자적으로 교체한 뒤 시작한다.
- systemd는 정상적인 SIGTERM 종료코드 143도 일시적으로 `Failed`로 기록한다. 현재 서비스는 active지만 운영 로그 노이즈를 줄이려면 별도 변경으로 `SuccessExitStatus=143` 적용을 검토한다.
- 8080에 TLS 또는 비정상 HTTP 바이트를 보내는 외부 스캔 흔적이 있다. 애플리케이션 오류는 아니지만 방화벽에서 직접 접근을 제한하는 것이 안전하다.

## 9. 롤백 기준

다음 중 하나라도 발생하면 정밀 다이제스트를 먼저 끄고 이전 검증 커밋으로 되돌린다.

- 정밀 감사 `ok=false`
- 비신뢰·인수금액·중복 대표 추천이 1건 이상
- 정밀 API 오류를 일반 추천으로 오인 표시
- 결정 POST 또는 기존 목록·상세·사진 API 회귀
- parse/collect 타이머 비활성 또는 OnFailure 라우팅 유실

롤백 시 `gm_data_trust`, `gm_outcome_trust`, `gm_precision_evaluations`, `gm_decision_events`와 사진 메타·파일은 삭제하지 않는다. 자세한 절차는 `docs/precision-first-operations.md`를 따른다.
