/**
 * 사진 미보유 활성 매물 타겟 고속 보강 스크립트.
 *
 * 기존 --photos-only의 비효율(법원 전체 검색 1페이지부터 전수 페이징, 서울 편향, 50건 극소 한도)을 해결:
 * 1. DB에서 활성 사진이 없는 물건만 직접 조회.
 * 2. 정밀 추천 후보(recommended) 및 고득점 통과 물건을 최우선으로 타겟팅.
 * 3. 법원별 라운드로빈 인터리빙으로 특정 법원 편향 없이 골고루 보강.
 * 4. 법원 상세 API(fetchDetail) 직송 호출 및 WebP 변환/캐시 즉시 저장.
 *
 * 사용:
 *   npm run photos:backfill                  # 기본 100건 우선순위 보강
 *   npm run photos:backfill -- --limit=200   # 200건 보강
 *   npm run photos:backfill -- --court=인천  # 특정 법원만 보강
 *   npm run photos:backfill -- --priority=recommended # 추천 물건 최우선
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { pool, query } from '../shared/db.ts';
import { cacheListingPhotos } from '../shared/listing-photos.ts';
import {
  courtCodeByName,
  extractCourtPhotoUrls,
  fetchCourtDetail,
} from '../crawler/adapters/courtauction.ts';

export type BackfillPriority = 'recommended' | 'passed' | 'imminent' | 'all';

export interface BackfillOptions {
  limit: number;
  priority: BackfillPriority;
  court?: string;
  delayMs: number;
}

export interface MissingListingRow {
  id: number;
  case_no: string;
  item_no: string;
  court: string;
  sale_date: string;
  appraisal_value: number;
  min_bid_price: number;
  property_type: string;
  is_recommended?: boolean;
}

export function readBackfillCliOptions(
  args: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): BackfillOptions {
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const envLimit = Number(env.PHOTO_BACKFILL_LIMIT);
  let limit = 100;
  if (limitArg) {
    const parsed = parseInt(limitArg.slice('--limit='.length), 10);
    if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(1000, parsed);
  } else if (Number.isFinite(envLimit) && envLimit > 0) {
    limit = Math.min(1000, Math.floor(envLimit));
  }

  const priorityArg = args.find((a) => a.startsWith('--priority='));
  const rawPriority = priorityArg ? priorityArg.slice('--priority='.length) : 'all';
  const priority: BackfillPriority =
    rawPriority === 'recommended' || rawPriority === 'passed' || rawPriority === 'imminent'
      ? rawPriority
      : 'all';

  const courtArg = args.find((a) => a.startsWith('--court='));
  const court = courtArg ? courtArg.slice('--court='.length).trim() : undefined;

  const delayArg = args.find((a) => a.startsWith('--delay='));
  const delayMs = delayArg ? Math.max(100, parseInt(delayArg.slice('--delay='.length), 10) || 400) : 400;

  return { limit, priority, court: court || undefined, delayMs };
}

export function buildMissingPhotosQuery(options: BackfillOptions): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let paramIdx = 1;

  let whereCourt = '';
  if (options.court) {
    whereCourt = `and l.court like $${paramIdx++}`;
    params.push(`%${options.court}%`);
  }

  let orderClause = 'l.sale_date asc, l.id desc';
  if (options.priority === 'recommended') {
    orderClause = `
      case when pe.status in ('recommended', 'conditional') then 0 else 1 end asc,
      case when sc.passed_filter = true then 0 else 1 end asc,
      l.sale_date asc
    `;
  } else if (options.priority === 'passed') {
    orderClause = `
      case when sc.passed_filter = true then 0 else 1 end asc,
      coalesce(sc.total_score, 0) desc,
      l.sale_date asc
    `;
  } else if (options.priority === 'imminent') {
    orderClause = 'l.sale_date asc, l.id desc';
  } else {
    // all: recommended first, then passed, then sale date
    orderClause = `
      case when pe.status = 'recommended' then 0
           when pe.status = 'conditional' then 1
           when sc.passed_filter = true then 2
           else 3 end asc,
      l.sale_date asc
    `;
  }

  const sql = `
    select l.id, l.case_no, coalesce(nullif(l.item_no, ''), '1') as item_no,
           l.court, l.sale_date, l.appraisal_value, l.min_bid_price, l.property_type,
           (pe.status in ('recommended', 'conditional')) as is_recommended
      from gm_listings l
      left join gm_precision_evaluations pe on pe.listing_id = l.id
      left join gm_scores sc on sc.case_no = l.case_no
     where l.sale_date >= current_date
       ${whereCourt}
       and not exists (
         select 1 from gm_listing_photos p
          where p.listing_id = l.id
            and p.status = 'active'
       )
     order by ${orderClause}
     limit $${paramIdx}
  `;
  params.push(options.limit);

  return { sql, params };
}

export function roundRobinByCourt<T extends { court: string }>(items: T[]): T[] {
  if (!items.length) return [];
  const byCourt = new Map<string, T[]>();
  for (const item of items) {
    const list = byCourt.get(item.court) ?? [];
    list.push(item);
    byCourt.set(item.court, list);
  }

  const result: T[] = [];
  let remaining = items.length;
  const queues = Array.from(byCourt.values());

  while (remaining > 0) {
    for (const queue of queues) {
      if (queue.length > 0) {
        result.push(queue.shift()!);
        remaining--;
      }
    }
  }

  return result;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function updateLocationPhotos(listingId: number): Promise<void> {
  await query(
    `update gm_location_analysis
        set photos = coalesce(
          (select jsonb_agg(p.public_url order by p.captured_at, p.id)
             from gm_listing_photos p
            where p.listing_id = $1 and p.status = 'active'),
          '[]'::jsonb
        ), analyzed_at = now()
      where listing_id = $1`,
    [listingId],
  );
}

export async function runPhotoBackfill(options?: Partial<BackfillOptions>): Promise<{
  totalTarget: number;
  successCount: number;
  photoCount: number;
  skippedCount: number;
}> {
  const opts = { ...readBackfillCliOptions(), ...options };
  const { sql, params } = buildMissingPhotosQuery(opts);
  const rows = await query<MissingListingRow>(sql, params);

  console.log(`[photos:backfill] 사진 미보유 타겟: ${rows.length}건 (우선순위: ${opts.priority}, 한도: ${opts.limit})`);
  if (!rows.length) {
    console.log('[photos:backfill] 보강 대상이 없습니다.');
    return { totalTarget: 0, successCount: 0, photoCount: 0, skippedCount: 0 };
  }

  // 법원별 라운드로빈 분배
  const queue = roundRobinByCourt(rows);
  let successCount = 0;
  let photoCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]!;
    const cortOfcCd = courtCodeByName(item.court);
    if (!cortOfcCd) {
      console.warn(`[photos:backfill] (${i + 1}/${queue.length}) 미지원 법원: ${item.court}`);
      skippedCount++;
      continue;
    }

    try {
      const detail = await fetchCourtDetail(item.case_no, cortOfcCd, item.item_no);
      if (!detail) {
        console.log(`[photos:backfill] (${i + 1}/${queue.length}) - ${item.case_no}/${item.item_no} 상세 미응답`);
        skippedCount++;
        continue;
      }

      const photos = extractCourtPhotoUrls(detail);
      if (photos.length > 0) {
        const publicUrls = await cacheListingPhotos(item.id, item.case_no, item.item_no, photos);
        if (publicUrls.length > 0) {
          await updateLocationPhotos(item.id);
          photoCount += publicUrls.length;
          successCount++;
          console.log(`[photos:backfill] (${i + 1}/${queue.length}) ✓ ${item.case_no}/${item.item_no} [${item.court}] ${publicUrls.length}장 캐시 완료`);
        } else {
          console.log(`[photos:backfill] (${i + 1}/${queue.length}) - ${item.case_no}/${item.item_no} 사진 없음`);
          skippedCount++;
        }
      } else {
        console.log(`[photos:backfill] (${i + 1}/${queue.length}) - ${item.case_no}/${item.item_no} 원천 사진 부재`);
        skippedCount++;
      }
    } catch (err) {
      console.warn(`[photos:backfill] (${i + 1}/${queue.length}) ✕ ${item.case_no}: ${err instanceof Error ? err.message : String(err)}`);
      skippedCount++;
    }

    await sleep(opts.delayMs);
  }

  console.log(`[photos:backfill] 완료: 대상 ${queue.length}건 중 ${successCount}건 성공 (${photoCount}장 캐시, ${skippedCount}건 스킵/부재)`);
  return { totalTarget: queue.length, successCount, photoCount, skippedCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPhotoBackfill()
    .catch((err) => {
      console.error('photos:backfill 실패:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool().end().catch(() => undefined));
}
