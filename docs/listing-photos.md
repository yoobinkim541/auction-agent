# 매물 사진 저장 정책

## 현재 정책

- 신규 수집 사진은 `sharp`로 WebP(quality 82, effort 4)로 변환한 뒤 저장한다.
- 변환된 바이트를 기준으로 SHA-256 해시를 만들기 때문에 DB 메타데이터와 파일명이 동일한 콘텐츠를 가리킨다.
- 대시보드는 `/api/listings/{listingId}/photos/{hash}.webp`를 `<img>`로 표시한다.
- 낙찰·종결 시 기존 사진 삭제 흐름은 확장자와 무관하게 계속 동작한다.

## 기존 사진 전환

먼저 변환 가능 여부와 누락 파일을 확인한다.

```bash
PHOTO_WEBP_MIGRATE_DRY_RUN=true npm run photos:migrate-webp
```

검증 후 실제 변환을 실행한다. 성공한 사진만 새 WebP 메타데이터를 활성화하고, 기존 JPG 파일은 DB 갱신 뒤 삭제한다. 변환 실패 사진은 기존 상태를 유지해 재시도할 수 있다.

```bash
npm run photos:migrate-webp
```

대량 작업을 나눌 때는 `PHOTO_WEBP_MIGRATE_LIMIT=500`처럼 제한한다.

## 사진 없는 사건 보강

상세 메타는 있지만 활성 사진이 없는 물건만 법원 상세를 다시 조회한다. 권리분석 전체를 재실행하지 않고, 한 번에 사진 상세 예산만 사용한다.

```bash
npm run crawl -- --source=courtauction --photos-only --photo-max=50 --max=1000
```

`--photo-max`를 낮게 유지해 법원 원천의 요청량과 차단 위험을 통제한다. 신규 상세 결과는 수집 단계에서 바로 사진 캐시로 연결되며, 목록 API에는 대표사진 한 장만 포함된다.
