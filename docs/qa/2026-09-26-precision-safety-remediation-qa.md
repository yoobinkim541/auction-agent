# 2026-09-26 정밀 안전성 보강 최종 QA

## 범위

- 임차인 보증금의 `억/만원` 단위 파싱과 대항력 판단 경계
- 다물건 사건의 `item_no` 식별·상세·권리·사진 격리
- 로그인 egress의 집 회선 검증 및 fail-closed 동작
- 정밀 추천의 입찰상한·분석 최신성·실패 시 digest 차단
- 사건번호 검색의 공백·하이픈 표기와 인천 수집 범위

## 반영 커밋

- `29d23af`: 다물건 상세 식별과 크롤 회선 검증
- `9ec14af`: 정밀 입찰상한과 분석 최신성 불변조건
- `f8d0288`: 분석 실패 시 정밀 다이제스트 차단
- `7f90df8`: 로그인 egress와 정밀 저장 경계 fail-closed
- `94de14f`: 사건번호 표기와 인천 수집 범위 보강
- `c09dbea`: API 사건번호 검색 표기 정규화

## 자동 검증

| 영역 | 결과 |
| --- | --- |
| Root Vitest | 117 files passed, 2 skipped / 1221 tests passed, 14 skipped |
| Root TypeScript typecheck | passed |
| Spring Maven tests | passed |
| Spring package | passed |
| Web production build | passed, Vite 48 modules transformed |
| PostgreSQL `ListingServiceIntegrationTest` | 3 tests passed, 사건번호 공백·하이픈 회귀 포함 |
| Shell syntax / scope tests | passed |
| `git diff --check` | passed |

## 운영 smoke

- `gyeongmae-api.service`: `active (running)`; 2026-09-26 12:28 UTC 새 JAR로 재기동
- `gyeongmae-web.service`: `active (running)`
- `gyeongmae-parse.timer`, `gyeongmae-collect.timer`: `active (waiting)`
- `/api/health`: `ok=true`
- `/api/listings?q=2025 타경 101607`: 2건
- `/api/listings?q=2025-101607`: 2건
- 사건 `2025타경101607`, `itemNo=2` 및 `/by-id/604376`: 동일하게 `id=604376`, `item=2`
- 활성 사진 라우트: HTTP 200, 62,239 bytes
- `/api/recommendations/precision?limit=5`: 5건

## 판단 및 한계

검색 API는 기존 원문 검색을 유지하면서 숫자가 포함된 입력에만 숫자형 사건번호 비교를 추가했다. 짧은 숫자 검색어의 부분 일치 범위가 넓어질 수 있는 trade-off가 있으므로 UI에서는 사건번호·주소 입력을 함께 표시한다.

브라우저 자동화는 이번 환경에서 preview 세션이 응답하지 않아 최종 합격 근거로 사용하지 않았으며, production HTTP smoke·서버 통합 테스트·웹 production build로 대체 검증했다.
