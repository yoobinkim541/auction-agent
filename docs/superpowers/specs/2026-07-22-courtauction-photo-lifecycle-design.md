# Courtauction Photo Lifecycle Design

## Goal

법원 경매 상세 페이지에서 매물 사진을 수집하고, 프론트엔드 상세 화면에 안정적으로 표시하며, 낙찰·매각·종결 상태가 확인되면 캐시된 사진 파일을 삭제한다.

## Selected Approach

**캐시형 사진 프록시(B안)** 을 적용한다.

- 법원 상세 응답 또는 상세 페이지에서 매물 사진 후보 URL을 추출한다.
- 크롤러/파이프라인은 사진 URL을 직접 프론트에 노출하지 않고 내부 캐시 URL로 정규화한다.
- 프론트는 기존 `location.photos: string[]` 계약을 유지해 `/api/listings/:id/photos/:photoId` 또는 정적 캐시 경로를 표시한다.
- 결과 수집에서 `sold = true` 또는 운영상 종결 상태가 확인되면 사진 binary를 삭제하고 DB에는 삭제 메타데이터만 남긴다.

## Current Code Context

- `crawler/adapters/courtauction.ts`
  - `fetchDetail()`이 법원 상세 `dma_result`를 가져온다.
  - `applyDetail()`이 상세 파싱 결과를 `registry_summary`, `sale_statement` 문서로 저장한다.
  - `collectSaleResults()`가 `gdsDspslDxdyLst`에서 회차별 결과와 `sold` 여부를 만든다.
- `crawler/adapters/deonakchal.ts`
  - 이미 상세 페이지의 `img` 태그를 필터링해 `siteMetrics.photos`에 넣는 패턴이 있다.
- `pipeline/run.ts`
  - `site_metrics` 문서의 `siteMetrics.photos`를 `loc.photos`로 넘긴다.
- `shared/db.ts`
  - `saveLocationAnalysis()`가 `gm_location_analysis.photos`를 저장하고, 새 사진 배열이 비어 있으면 기존 사진을 보존한다.
- `shared/types.ts`
  - `LocationAnalysis.photos?: string[]` 계약이 있다.
- `server/src/main/java/com/gyeongmae/service/ListingService.java`
  - 상세 조회는 `location` 전체를 반환한다.
  - 목록 조회는 무거운 `photos`를 제외한다.
- `web/src/Detail.tsx`
  - `loc.photos`가 있으면 갤러리를 렌더링한다.

## Data Model

기존 `gm_location_analysis.photos`는 프론트 호환용 active URL 배열로 유지한다.

새 테이블 `gm_listing_photos`를 추가한다.

- `id`
- `listing_id`
- `case_no`
- `item_no`
- `source`
- `source_url`
- `cache_path`
- `public_url`
- `content_hash`
- `status`: `active | deleted | failed`
- `delete_reason`
- `captured_at`
- `deleted_at`
- unique key: `(listing_id, content_hash)`

이 구조는 사진 표시와 삭제 감사 로그를 분리한다. `gm_location_analysis.photos`는 항상 active 상태의 `public_url` 배열만 담는다.

## Collection Flow

1. `courtauction` 상세 수집 시 `dma_result`에서 사진 URL 후보를 추출한다.
2. URL 후보가 없으면 상세 HTML/문서 필드에서 이미지 패턴 후보를 한 번 더 추출한다.
3. 로고·아이콘·배너·SVG·작은 썸네일은 제외한다.
4. URL은 절대 URL로 정규화하고 중복 제거한다.
5. 최대 15장까지만 저장 후보로 넘긴다.
6. 파이프라인은 후보 URL을 다운로드/캐시하고 active public URL 목록을 `loc.photos`로 저장한다.

## Cache Flow

1. 사진별 `source_url`을 받아 timeout과 content-type 검증을 적용해 다운로드한다.
2. `image/*`가 아니거나 크기가 10MB를 넘으면 저장하지 않는다.
3. `sha256` 해시로 파일명을 만든다.
4. 저장 위치는 운영 환경 설정값 `PHOTO_CACHE_DIR`을 사용하고, 기본값은 `artifacts/listing-photos`로 둔다.
5. public URL은 백엔드가 서빙 가능한 `/api/listings/:listingId/photos/:hash` 형태로 만든다.
6. 다운로드 실패 사진은 `failed` 메타로 남기되 `loc.photos`에는 넣지 않는다.

## Deletion Flow

1. 결과 수집 또는 결과 재시도 큐에서 `sold = true`가 확인된다.
2. 해당 `case_no + item_no`에 연결된 `listing_id`를 찾는다.
3. active 사진 파일을 삭제한다.
4. `gm_listing_photos.status = deleted`, `delete_reason = sold`, `deleted_at = now()`로 갱신한다.
5. `gm_location_analysis.photos = []`로 비운다.
6. 파일이 이미 없으면 DB 상태만 삭제 처리해 idempotent하게 동작한다.

## Frontend Flow

- 상세 화면은 기존 `loc.photos` 갤러리를 그대로 사용한다.
- 목록 카드는 성능을 위해 전체 사진 배열을 싣지 않는다.
- 추후 필요 시 `photo_thumb` 한 장만 slim query에 추가한다.
- 사진이 삭제된 종결 매물은 갤러리 대신 “종결되어 사진 캐시 삭제됨” 상태를 보여줄 수 있다.

## Safety And Compliance

- 프론트가 법원 이미지 URL을 직접 hotlink하지 않는다.
- 다운로드는 크롤러가 접근 권한을 가진 상세 수집 세션 안에서만 수행한다.
- 삭제는 binary 중심으로 수행하고, 감사·복기용 메타데이터는 보존한다.
- 법원 측 차단 또는 이미지 접근 실패는 매물 분석 실패로 전파하지 않는다.

## Tests

- courtauction 사진 후보 추출 순수 함수 테스트
- 이미지 URL 필터/정규화/중복 제거 테스트
- 캐시 저장 함수 테스트
- 낙찰 결과 기반 삭제 함수 idempotency 테스트
- `saveLocationAnalysis()` 사진 배열 업데이트/삭제 동작 테스트
- `Detail.tsx` 갤러리 fallback 테스트

## Open Trade-Offs

- 즉시 삭제는 저장공간과 민감도 측면에서 안전하지만, 낙찰 후 복기 화면에는 사진이 남지 않는다.
- 관심 매물 30일 유예는 복기에는 좋지만 삭제 정책이 복잡해진다.
- 이번 구현은 기본 정책을 “낙찰 확인 즉시 binary 삭제”로 두고, 관심 매물 유예는 후속 옵션으로 남긴다.
