/**
 * 기존 활성 JPG/PNG/GIF 매물 사진을 WebP로 변환한다.
 * 사용: PHOTO_WEBP_MIGRATE_DRY_RUN=true npm run photos:migrate-webp
 *       PHOTO_WEBP_MIGRATE_LIMIT=500 npm run photos:migrate-webp
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, query, saveListingPhotoMetadata } from '../shared/db.ts';
import {
  convertPhotoToWebp,
  deletePhotoFiles,
  photoCachePath,
  photoCacheRoot,
  photoPublicUrl,
} from '../shared/listing-photos.ts';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

interface PhotoRow {
  id: string;
  listing_id: string;
  case_no: string;
  item_no: string;
  source: string;
  source_url: string;
  cache_path: string;
}

function envLimit(): number {
  const parsed = Number(process.env.PHOTO_WEBP_MIGRATE_LIMIT ?? '10000');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10000;
}

function isDryRun(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PHOTO_WEBP_MIGRATE_DRY_RUN ?? '');
}

async function refreshLocationPhotos(listingId: number): Promise<void> {
  await query(
    `update gm_location_analysis
        set photos = coalesce(
          (select jsonb_agg(p.public_url order by p.captured_at, p.id)
             from gm_listing_photos p
            where p.listing_id=$1 and p.status='active'),
          '[]'::jsonb
        ), analyzed_at=now()
      where listing_id=$1`,
    [listingId],
  );
}

async function migrateRow(row: PhotoRow, dryRun: boolean): Promise<'converted' | 'skipped' | 'failed'> {
  const listingId = Number(row.listing_id);
  try {
    const original = new Uint8Array(await readFile(row.cache_path));
    if (!original.length || original.byteLength > MAX_PHOTO_BYTES) return 'skipped';

    const converted = await convertPhotoToWebp(original);
    if (!converted.length || converted.byteLength > MAX_PHOTO_BYTES) return 'skipped';

    const contentHash = createHash('sha256').update(converted).digest('hex');
    const cachePath = photoCachePath(listingId, contentHash, '.webp');
    const publicUrl = photoPublicUrl(listingId, contentHash, '.webp');
    console.log(`${dryRun ? '[dry-run] ' : ''}${row.case_no}/${row.item_no} ${row.cache_path} -> ${cachePath}`);
    if (dryRun) return 'converted';

    await mkdir(join(photoCacheRoot(), String(listingId)), { recursive: true });
    await writeFile(cachePath, converted);
    await saveListingPhotoMetadata(listingId, {
      caseNo: row.case_no,
      itemNo: row.item_no || '1',
      source: row.source,
      sourceUrl: row.source_url,
      cachePath,
      publicUrl,
      contentHash,
    });
    await query(
      `update gm_listing_photos
          set status='deleted', delete_reason='webp_migrated', deleted_at=now()
        where id=$1 and status='active'`,
      [row.id],
    );
    await deletePhotoFiles([row.cache_path]);
    return 'converted';
  } catch (error) {
    console.warn(`[photos:migrate-webp] 실패 ${row.case_no}/${row.item_no}: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

async function main(): Promise<void> {
  const dryRun = isDryRun();
  const rows = await query<PhotoRow>(
    `select id, listing_id, case_no, item_no, source, source_url, cache_path
       from gm_listing_photos
      where status='active' and public_url !~* '\\.webp$'
      order by id
      limit $1`,
    [envLimit()],
  );
  const touched = new Set<number>();
  let converted = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await migrateRow(row, dryRun);
    if (result === 'converted') {
      converted++;
      touched.add(Number(row.listing_id));
    } else if (result === 'skipped') {
      skipped++;
    } else {
      failed++;
    }
  }
  if (!dryRun) {
    for (const listingId of touched) await refreshLocationPhotos(listingId);
  }
  console.log(`[photos:migrate-webp] total=${rows.length} converted=${converted} skipped=${skipped} failed=${failed} dryRun=${dryRun}`);
  await pool().end();
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(`[photos:migrate-webp] fatal: ${error instanceof Error ? error.message : String(error)}`);
  await pool().end().catch(() => undefined);
  process.exitCode = 1;
});
