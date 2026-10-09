import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cacheListingPhotos,
  convertPhotoToWebp,
  deletePhotoFiles,
  normalizePhotoExtension,
  photoCachePath,
  photoPublicUrl,
} from './listing-photos.ts';

let tempRoot: string;
const oldPhotoCacheDir = process.env.PHOTO_CACHE_DIR;
const TINY_JPEG = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AYf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AYf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACP/aAAwDAQACAAMAAAAQ/wD/xAAUEAEAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
));

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'gm-photo-test-'));
  process.env.PHOTO_CACHE_DIR = tempRoot;
});

afterEach(async () => {
  process.env.PHOTO_CACHE_DIR = oldPhotoCacheDir;
  await rm(tempRoot, { recursive: true, force: true });
});

describe('listing photo cache paths', () => {
  it('listing id와 hash로 안정적인 public URL과 cache path를 만든다', () => {
    expect(photoPublicUrl(42, 'abc123', '.jpg')).toBe('/api/listings/42/photos/abc123.jpg');
    expect(photoCachePath(42, 'abc123', '.jpg')).toContain('/42/abc123.jpg');
  });

  it('없는 파일 삭제는 실패로 취급하지 않는다', async () => {
    await expect(deletePhotoFiles([join(tempRoot, 'missing.jpg')])).resolves.toBe(0);
  });
});

describe('listing photo extension normalization', () => {
  it('content-type과 URL에서 이미지 확장자를 정규화한다', () => {
    expect(normalizePhotoExtension('image/jpeg', 'https://x/a')).toBe('.jpg');
    expect(normalizePhotoExtension('image/png', 'https://x/a')).toBe('.png');
    expect(normalizePhotoExtension(null, 'https://x/a.webp?token=1')).toBe('.webp');
    expect(normalizePhotoExtension('text/html', 'https://x/a')).toBeNull();
  });
});

describe('listing photo cache download', () => {
  it('변환 결과가 WebP 컨테이너다', async () => {
    const converted = await convertPhotoToWebp(TINY_JPEG);
    expect(Buffer.from(converted).subarray(0, 4).toString()).toBe('RIFF');
    expect(Buffer.from(converted).subarray(8, 12).toString()).toBe('WEBP');
  });

  it('이미지를 다운로드해 hash 기반 public URL을 반환한다', async () => {
    const fetchImpl = async () => new Response(TINY_JPEG, { headers: { 'content-type': 'image/jpeg' } });
    const urls = await cacheListingPhotos(77, '2026타경1', '1', ['https://example.test/p.jpg'], fetchImpl as typeof fetch);
    expect(urls[0]).toMatch(/^\/api\/listings\/77\/photos\/[a-f0-9]+\.webp$/);
  });

  it('JPEG 입력을 WebP로 변환해 저장한다', async () => {
    const fetchImpl = async () => new Response(TINY_JPEG, { headers: { 'content-type': 'image/jpeg' } });

    const urls = await cacheListingPhotos(99, '2026타경9', '1', ['https://example.test/p.jpg'], fetchImpl as typeof fetch);

    expect(urls[0]).toMatch(/^\/api\/listings\/99\/photos\/[a-f0-9]+\.webp$/);
    const fileName = urls[0]!.split('/').pop()!;
    const cached = await readFile(photoCachePath(99, fileName.slice(0, -5), '.webp'));
    expect(cached.subarray(0, 4).toString()).toBe('RIFF');
    expect(cached.subarray(8, 12).toString()).toBe('WEBP');
  });

  it('data URL 이미지는 네트워크 fetch 없이 캐시한다', async () => {
    const dataUrl = `data:image/jpeg;base64,${Buffer.from(TINY_JPEG).toString('base64')}`;
    const fetchImpl = async () => { throw new Error('fetch should not be called for data URLs'); };

    const urls = await cacheListingPhotos(88, '2026타경2', '1', [dataUrl], fetchImpl as typeof fetch);

    expect(urls[0]).toMatch(/^\/api\/listings\/88\/photos\/[a-f0-9]+\.webp$/);
  });

  it('외부 이미지 fetch에 타임아웃 중단 신호를 전달한다', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Response(TINY_JPEG, { headers: { 'content-type': 'image/jpeg' } });
    };

    await cacheListingPhotos(89, '2026타경3', '1', ['https://example.test/slow.jpg'], fetchImpl as typeof fetch);

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('stored inline photo sources', () => {
  // 1x1 GIF — 과거 크롤이 법원 호스트 뒤에 붙여 저장한 base64 사진(https://www.courtauction.go.kr/R0lGOD...)
  const TINY_GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const noFetch = (async () => { throw new Error('fetch must not be called'); }) as unknown as typeof fetch;

  it('저장된 깨진 base64 사진 주소는 요청하지 않고 data URL로 복구해 캐시한다', async () => {
    const urls = await cacheListingPhotos(78, '2026타경2', '1', [`https://www.courtauction.go.kr/${TINY_GIF_BASE64}`], noFetch);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^\/api\/listings\/78\/photos\/[0-9a-f]{64}\.webp$/);
  });

  it('형식을 알 수 없는 긴 base64 주소는 요청하지 않고 건너뛴다', async () => {
    let calls = 0;
    const countingFetch = (async () => { calls++; throw new Error('unexpected fetch'); }) as unknown as typeof fetch;
    const urls = await cacheListingPhotos(79, '2026타경3', '1', [`https://www.courtauction.go.kr/Qk2${'A/b+'.repeat(40)}`], countingFetch);
    expect(urls).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('listing photo deletion', () => {
  it('삭제 대상 파일 목록을 받아 파일 삭제 수를 반환한다', async () => {
    const file = join(tempRoot, `gm-photo-${Date.now()}.jpg`);
    await writeFile(file, 'x');
    await expect(deletePhotoFiles([file])).resolves.toBe(1);
  });
});
