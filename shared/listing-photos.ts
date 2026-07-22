import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  markListingPhotosDeletedByCase,
  saveListingPhotoMetadata,
} from './db.ts';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

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

export async function cacheListingPhotos(
  listingId: number,
  caseNo: string,
  itemNo: string,
  sourceUrls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const publicUrls: string[] = [];
  const seen = new Set<string>();
  for (const sourceUrl of sourceUrls) {
    if (seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    try {
      const response = await fetchImpl(sourceUrl, { redirect: 'follow' });
      if (!response.ok) continue;
      const ext = normalizePhotoExtension(response.headers.get('content-type'), sourceUrl);
      if (!ext) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.byteLength > MAX_PHOTO_BYTES) continue;
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      const cachePath = photoCachePath(listingId, contentHash, ext);
      const publicUrl = photoPublicUrl(listingId, contentHash, ext);
      await mkdir(join(photoCacheRoot(), String(listingId)), { recursive: true });
      await writeFile(cachePath, bytes);
      try {
        await saveListingPhotoMetadata(listingId, {
          caseNo,
          itemNo,
          source: 'courtauction',
          sourceUrl,
          cachePath,
          publicUrl,
          contentHash,
        });
      } catch (err) {
        console.warn(`[listing-photos] metadata save failed for ${caseNo}/${itemNo}: ${err instanceof Error ? err.message : String(err)}`);
      }
      publicUrls.push(publicUrl);
    } catch (err) {
      console.warn(`[listing-photos] cache failed ${sourceUrl}: ${err instanceof Error ? err.message : String(err)}`);
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
