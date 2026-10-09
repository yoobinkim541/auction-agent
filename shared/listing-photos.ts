import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  activeListingPhotoSourceUrls,
  markListingPhotosDeletedByCase,
  saveListingPhotoMetadata,
} from './db.ts';
import { repairStoredPhotoSource } from './inline-photo.ts';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_FETCH_TIMEOUT_MS = 15_000;

export function photoCacheRoot(): string {
  return resolve(process.env.PHOTO_CACHE_DIR ?? 'artifacts/listing-photos');
}

function normalizeExt(ext: string): string {
  const clean = ext.trim().toLowerCase().replace(/^\.+/, '');
  return `.${clean || 'jpg'}`;
}

export function photoPublicUrl(listingId: number, contentHash: string, ext: string): string {
  return `/api/listings/${listingId}/photos/${contentHash}${normalizeExt(ext)}`;
}

export function photoCachePath(listingId: number, contentHash: string, ext: string): string {
  return join(photoCacheRoot(), String(listingId), `${contentHash}${normalizeExt(ext)}`);
}

export function normalizePhotoExtension(contentType: string | null | undefined, sourceUrl: string): string | null {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'image/jpeg' || type === 'image/jpg') return '.jpg';
  if (type === 'image/png') return '.png';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/gif') return '.gif';
  if (type && !type.startsWith('image/')) return null;
  const path = sourceUrl.split(/[?#]/)[0] ?? '';
  const match = path.match(/\.(jpe?g|png|webp|gif)$/i);
  if (!match) return type.startsWith('image/') ? '.jpg' : null;
  const raw = match[1]!.toLowerCase();
  return raw === 'jpeg' ? '.jpg' : `.${raw}`;
}

export async function deletePhotoFiles(paths: string[]): Promise<number> {
  let deleted = 0;
  for (const path of paths) {
    try {
      await stat(path);
      await rm(path, { force: true });
      deleted++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return deleted;
}

function describePhotoSource(sourceUrl: string): string {
  if (sourceUrl.startsWith('data:')) return `${sourceUrl.slice(0, 48)}…`;
  return sourceUrl.length > 160 ? `${sourceUrl.slice(0, 157)}…` : sourceUrl;
}

type PhotoPayload = {
  bytes: Uint8Array;
};

function decodeDataUrlPhoto(sourceUrl: string): PhotoPayload | null {
  const match = sourceUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const contentType = match[1] ?? '';
  const ext = normalizePhotoExtension(contentType, sourceUrl);
  if (!ext) return null;
  const bytes = new Uint8Array(Buffer.from((match[2] ?? '').replace(/\s+/g, ''), 'base64'));
  return { bytes };
}

async function loadPhotoPayload(sourceUrl: string, fetchImpl: typeof fetch): Promise<PhotoPayload | null> {
  const dataUrlPhoto = decodeDataUrlPhoto(sourceUrl);
  if (dataUrlPhoto) return dataUrlPhoto;

  const response = await fetchImpl(sourceUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const ext = normalizePhotoExtension(response.headers.get('content-type'), sourceUrl);
  if (!ext) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes };
}

export async function convertPhotoToWebp(bytes: Uint8Array): Promise<Uint8Array> {
  const converted = await sharp(bytes, { failOn: 'error' })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
  return new Uint8Array(converted);
}

export async function cacheListingPhotos(
  listingId: number,
  caseNo: string,
  itemNo: string,
  sourceUrls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const publicUrls: string[] = [];
  const seen = new Set<string>();
  let existingSources = new Set<string>();
  try {
    existingSources = new Set(await activeListingPhotoSourceUrls(listingId));
  } catch {
    // 테스트·DB 장애 시에도 파일 캐시는 계속 시도하고 메타데이터 저장에서 재시도한다.
  }
  for (const storedUrl of sourceUrls) {
    // 과거 크롤이 저장한 깨진 base64 주소는 요청 전에 복구한다(analyze는 DB에 저장된 주소를 읽는다).
    const sourceUrl = repairStoredPhotoSource(storedUrl);
    if (sourceUrl === null) continue;
    if (seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    if (!sourceUrl.startsWith('data:') && existingSources.has(sourceUrl)) continue;
    try {
      const payload = await loadPhotoPayload(sourceUrl, fetchImpl);
      if (!payload) continue;
      const { bytes } = payload;
      if (!bytes.length || bytes.byteLength > MAX_PHOTO_BYTES) continue;
      const webpBytes = await convertPhotoToWebp(bytes);
      if (!webpBytes.length || webpBytes.byteLength > MAX_PHOTO_BYTES) continue;
      const contentHash = createHash('sha256').update(webpBytes).digest('hex');
      const cachePath = photoCachePath(listingId, contentHash, '.webp');
      const publicUrl = photoPublicUrl(listingId, contentHash, '.webp');
      const metadataSourceUrl = sourceUrl.startsWith('data:') ? `data:${contentHash}` : sourceUrl;
      await mkdir(join(photoCacheRoot(), String(listingId)), { recursive: true });
      await writeFile(cachePath, webpBytes);
      try {
        await saveListingPhotoMetadata(listingId, {
          caseNo,
          itemNo,
          source: 'courtauction',
          sourceUrl: metadataSourceUrl,
          cachePath,
          publicUrl,
          contentHash,
        });
      } catch (err) {
        console.warn(`[listing-photos] metadata save failed for ${caseNo}/${itemNo}: ${err instanceof Error ? err.message : String(err)}`);
      }
      publicUrls.push(publicUrl);
    } catch (err) {
      console.warn(`[listing-photos] cache failed ${describePhotoSource(sourceUrl)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return publicUrls;
}

export async function deleteCachedPhotosForSoldListing(caseNo: string, itemNo: string, reason = 'sold'): Promise<number> {
  try {
    const paths = await markListingPhotosDeletedByCase(caseNo, itemNo, reason);
    return deletePhotoFiles(paths);
  } catch (err) {
    console.warn(`[listing-photos] sold photo cleanup skipped for ${caseNo}/${itemNo}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
