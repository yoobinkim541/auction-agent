import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cacheListingPhotos,
  deletePhotoFiles,
  normalizePhotoExtension,
  photoCachePath,
  photoPublicUrl,
} from './listing-photos.ts';

let tempRoot: string;
const oldPhotoCacheDir = process.env.PHOTO_CACHE_DIR;

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
  it('이미지를 다운로드해 hash 기반 public URL을 반환한다', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = async () => new Response(body, { headers: { 'content-type': 'image/jpeg' } });
    const urls = await cacheListingPhotos(77, '2026타경1', '1', ['https://example.test/p.jpg'], fetchImpl as typeof fetch);
    expect(urls[0]).toMatch(/^\/api\/listings\/77\/photos\/[a-f0-9]+\.jpg$/);
  });

  it('data URL 이미지는 네트워크 fetch 없이 캐시한다', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const dataUrl = `data:image/jpeg;base64,${Buffer.from(body).toString('base64')}`;
    const fetchImpl = async () => { throw new Error('fetch should not be called for data URLs'); };

    const urls = await cacheListingPhotos(88, '2026타경2', '1', [dataUrl], fetchImpl as typeof fetch);

    expect(urls[0]).toMatch(/^\/api\/listings\/88\/photos\/[a-f0-9]+\.jpg$/);
  });
});

describe('listing photo deletion', () => {
  it('삭제 대상 파일 목록을 받아 파일 삭제 수를 반환한다', async () => {
    const file = join(tempRoot, `gm-photo-${Date.now()}.jpg`);
    await writeFile(file, 'x');
    await expect(deletePhotoFiles([file])).resolves.toBe(1);
  });
});
