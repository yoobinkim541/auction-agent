# Courtauction Photo Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 법원 경매 상세 사진을 수집·캐시·노출하고 낙찰 확인 시 캐시 파일을 삭제한다.

**Architecture:** 사진 후보 추출은 `courtauction` 어댑터의 순수 함수로 분리한다. 캐시와 삭제 수명주기는 `shared/listing-photos.ts`와 `shared/db.ts`에 두고, 기존 `LocationAnalysis.photos: string[]` 프론트 계약은 유지한다. 결과 수집 스크립트는 `sold` 라운드 기록 후 같은 사건/물건의 active 사진을 삭제한다.

**Tech Stack:** TypeScript, Vitest, Node.js `fs/promises`, `crypto`, existing PostgreSQL `query()` helper, Spring Boot listing API.

## Global Constraints

- 기존 `LocationAnalysis.photos?: string[]` 응답 계약을 유지한다.
- 프론트는 법원 이미지 URL을 직접 hotlink하지 않는다.
- 사진 다운로드 실패는 매물 분석 실패로 전파하지 않는다.
- 낙찰 확인 시 사진 binary 삭제는 idempotent해야 한다.
- 목록 API에는 전체 사진 배열을 싣지 않는다.
- production 배포는 별도 명시 승인 전에는 수행하지 않는다.

---

## File Structure

- Modify: `crawler/adapters/courtauction.ts` — 상세 `dma_result`에서 사진 후보 URL을 추출하고 `site_metrics` 문서에 저장한다.
- Modify: `crawler/adapters/courtauction.test.ts` — URL 추출/필터/중복 제거 회귀 테스트를 추가한다.
- Create: `shared/listing-photos.ts` — 사진 캐시 경로, public URL 생성, binary 삭제 순수/IO 유틸을 담당한다.
- Create: `shared/listing-photos.test.ts` — 캐시 경로와 삭제 idempotency 테스트를 담당한다.
- Modify: `shared/db.ts` — 사진 메타 upsert, active URL 조회, 낙찰 삭제 DB helper를 추가한다.
- Modify: `db/schema.sql` — `gm_listing_photos` 테이블과 인덱스를 추가한다.
- Create: `db/migrate_listing_photos.sql` — 운영 DB 적용용 migration을 추가한다.
- Modify: `pipeline/run.ts` — `siteMetrics.photos`를 내부 캐시 URL로 변환한 뒤 `loc.photos`에 저장한다.
- Modify: `scripts/collect-results.ts` — `sold` 라운드 기록 후 사진 삭제를 호출한다.
- Modify: `scripts/retry-outcome-results.ts` — retry worker에서도 `sold` 라운드 기록 후 사진 삭제를 호출한다.
- Modify: `server/src/main/java/com/gyeongmae/service/ListingService.java` — 상세 응답은 기존 location 전체를 유지하고, 필요 시 삭제 상태 노출을 최소 필드로 확장한다.

### Task 1: Court Photo Extraction

**Files:**
- Modify: `crawler/adapters/courtauction.ts`
- Modify: `crawler/adapters/courtauction.test.ts`

**Interfaces:**
- Produces: `export function extractCourtPhotoUrls(detail: unknown, baseUrl?: string): string[]`
- Produces: `site_metrics` doc field `photos: string[]`

- [ ] **Step 1: Write the failing test**

```ts
it('상세 dma_result에서 법원 매물 사진 URL만 추출한다', () => {
  const detail = {
    photoList: [
      { fileUrl: '/down/image/photo1.jpg' },
      { imgUrl: 'https://www.courtauction.go.kr/down/image/photo2.jpeg?x=1' },
      { fileUrl: '/images/logo.png' },
      { fileUrl: 'data:image/png;base64,abc' },
      { fileUrl: '/down/image/photo1.jpg' },
    ],
    nested: { thumUrl: '/files/thumb_photo3.png' },
  };

  expect(extractCourtPhotoUrls(detail)).toEqual([
    'https://www.courtauction.go.kr/down/image/photo1.jpg',
    'https://www.courtauction.go.kr/down/image/photo2.jpeg?x=1',
    'https://www.courtauction.go.kr/files/thumb_photo3.png',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- crawler/adapters/courtauction.test.ts -t "법원 매물 사진"`
Expected: FAIL because `extractCourtPhotoUrls` is not exported.

- [ ] **Step 3: Implement minimal extractor**

Add `extractCourtPhotoUrls(detail: unknown, baseUrl = BASE): string[]` that recursively scans string values on keys matching `url|src|path|file|photo|image|thumb`, normalizes absolute URLs, rejects `data:`, `logo`, `icon`, `btn`, `button`, `blank`, `spacer`, `banner`, `sprite`, `.svg`, keeps image-looking paths, dedupes, and returns max 15.

- [ ] **Step 4: Wire extractor into detail docs**

In `applyDetail()`, call `extractCourtPhotoUrls(detail)` and append/merge a `site_metrics` doc with `parsedJson.photos`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- crawler/adapters/courtauction.test.ts`
Expected: PASS for `courtauction` tests.

### Task 2: Photo Cache Utilities

**Files:**
- Create: `shared/listing-photos.ts`
- Create: `shared/listing-photos.test.ts`

**Interfaces:**
- Produces: `photoCacheRoot(): string`
- Produces: `photoPublicUrl(listingId: number, contentHash: string, ext: string): string`
- Produces: `photoCachePath(listingId: number, contentHash: string, ext: string): string`
- Produces: `deletePhotoFiles(paths: string[]): Promise<number>`

- [ ] **Step 1: Write the failing tests**

```ts
it('listing id와 hash로 안정적인 public URL과 cache path를 만든다', () => {
  expect(photoPublicUrl(42, 'abc123', '.jpg')).toBe('/api/listings/42/photos/abc123.jpg');
  expect(photoCachePath(42, 'abc123', '.jpg')).toContain('/42/abc123.jpg');
});

it('없는 파일 삭제는 실패로 취급하지 않는다', async () => {
  await expect(deletePhotoFiles(['/tmp/gm-missing-photo.jpg'])).resolves.toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- shared/listing-photos.test.ts`
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement minimal utilities**

Use `PHOTO_CACHE_DIR ?? artifacts/listing-photos`, Node `path.join`, extension normalization, and `fs.rm(path, { force: true })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- shared/listing-photos.test.ts`
Expected: PASS.

### Task 3: Photo Metadata Persistence

**Files:**
- Modify: `db/schema.sql`
- Create: `db/migrate_listing_photos.sql`
- Modify: `shared/db.ts`

**Interfaces:**
- Produces: `ListingPhotoInput`
- Produces: `saveListingPhotoMetadata(listingId: number, input: ListingPhotoInput): Promise<void>`
- Produces: `activeListingPhotoUrls(listingId: number): Promise<string[]>`
- Produces: `markListingPhotosDeletedByCase(caseNo: string, itemNo: string, reason: string): Promise<string[]>`

- [ ] **Step 1: Write SQL and helper contract test by static behavior**

Add a Vitest test in `shared/listing-photos.test.ts` for `normalizePhotoExtension('image/jpeg', 'https://x/a') === '.jpg'` and unsupported content types returning `null`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- shared/listing-photos.test.ts`
Expected: FAIL because `normalizePhotoExtension` is missing.

- [ ] **Step 3: Add schema and migration**

Add `gm_listing_photos` with `status` check, delete metadata columns, `unique(listing_id, content_hash)`, and active index.

- [ ] **Step 4: Add DB helpers**

Implement helpers in `shared/db.ts` using existing `query()`:

```ts
export interface ListingPhotoInput {
  caseNo: string;
  itemNo: string;
  source: string;
  sourceUrl: string;
  cachePath: string;
  publicUrl: string;
  contentHash: string;
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- shared/listing-photos.test.ts`
Expected: PASS.

### Task 4: Pipeline Cache Integration

**Files:**
- Modify: `pipeline/run.ts`
- Modify: `shared/listing-photos.ts`

**Interfaces:**
- Produces: `cacheListingPhotos(listingId: number, caseNo: string, itemNo: string, sourceUrls: string[], fetchImpl?: typeof fetch): Promise<string[]>`

- [ ] **Step 1: Write failing cache test**

```ts
it('이미지를 다운로드해 hash 기반 public URL을 반환한다', async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const fetchImpl = async () => new Response(body, { headers: { 'content-type': 'image/jpeg' } });
  const urls = await cacheListingPhotos(77, '2026타경1', '1', ['https://example.test/p.jpg'], fetchImpl as typeof fetch);
  expect(urls[0]).toMatch(/^\/api\/listings\/77\/photos\/[a-f0-9]+\.jpg$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PHOTO_CACHE_DIR=/tmp/gm-photo-test npm test -- shared/listing-photos.test.ts -t "이미지를 다운로드"`
Expected: FAIL because `cacheListingPhotos` is missing.

- [ ] **Step 3: Implement cacheListingPhotos**

Download only `image/*`, reject payloads above 10MB, hash bytes with `sha256`, write files under cache root, save metadata, and return public URLs.

- [ ] **Step 4: Wire pipeline**

In `pipeline/run.ts`, replace direct `loc.photos = siteMetrics.photos` with cached URL conversion. On cache failure, log warning and keep analysis running.

- [ ] **Step 5: Run tests**

Run: `PHOTO_CACHE_DIR=/tmp/gm-photo-test npm test -- shared/listing-photos.test.ts`
Expected: PASS.

### Task 5: Sold Deletion Integration

**Files:**
- Modify: `scripts/collect-results.ts`
- Modify: `scripts/retry-outcome-results.ts`
- Modify: `shared/db.ts`
- Modify: `shared/listing-photos.ts`

**Interfaces:**
- Produces: `deleteCachedPhotosForSoldListing(caseNo: string, itemNo: string, reason?: string): Promise<number>`

- [ ] **Step 1: Write deletion utility test**

```ts
it('삭제 대상 파일 목록을 받아 파일 삭제 수를 반환한다', async () => {
  const file = join(tmpdir(), `gm-photo-${Date.now()}.jpg`);
  await writeFile(file, 'x');
  await expect(deletePhotoFiles([file])).resolves.toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- shared/listing-photos.test.ts -t "삭제 대상 파일"`
Expected: FAIL until delete count behavior is implemented.

- [ ] **Step 3: Implement deleteCachedPhotosForSoldListing**

Call `markListingPhotosDeletedByCase(caseNo, itemNo, reason)`, delete returned paths via `deletePhotoFiles`, and return deleted count.

- [ ] **Step 4: Wire result scripts**

In both result scripts, after any `round.sold`, call `deleteCachedPhotosForSoldListing(caseNo, itemNo, 'sold')`.

- [ ] **Step 5: Run tests**

Run: `npm test -- shared/listing-photos.test.ts`
Expected: PASS.

### Task 6: Verification

**Files:**
- All modified files

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- crawler/adapters/courtauction.test.ts shared/listing-photos.test.ts`
Expected: PASS.

- [ ] **Step 2: Run full TypeScript tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run frontend build**

Run: `npm --prefix web run build`
Expected: PASS.
