/**
 * 기존 gm_listings 중 lat/lng 없는 매물을 네이버 지오코딩으로 일괄 보완.
 *   npm run geocode:bulk
 *
 * NAVER_MAP_CLIENT_ID / NAVER_MAP_CLIENT_SECRET 필요. 기본 300ms 간격.
 */
import 'dotenv/config';
import { query } from '../shared/db.ts';
import { geocodeSmart } from '../pipeline/location/osm.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELAY = parseInt(process.env.GEOCODE_DELAY_MS ?? '320', 10);

async function main() {
  // 우선순위: 대시보드 노출(통과+미래기일) → 활성 → 나머지. 쿼터가 중간에 끊겨도 지도에 보이는 물건부터 채워지게.
  const rows = await query<{ id: number; address: string }>(
    `SELECT l.id, l.address FROM gm_listings l
      LEFT JOIN gm_scores s ON s.listing_id = l.id
     WHERE l.lat IS NULL OR l.lng IS NULL
     ORDER BY (coalesce(s.passed_filter, false) AND (l.sale_date IS NULL OR l.sale_date >= current_date)) DESC,
              (l.sale_date IS NULL OR l.sale_date >= current_date) DESC, l.id`,
  );
  console.log(`지오코딩 대상: ${rows.length}건 · 간격 ${DELAY}ms`);
  if (!rows.length) { console.log('모두 완료됨.'); return; }

  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      const geo = await geocodeSmart(r.address);
      if (geo) {
        await query('UPDATE gm_listings SET lat=$2, lng=$3 WHERE id=$1', [r.id, geo.lat, geo.lng]);
        ok++;
        if (ok % 50 === 0) console.log(`  ${ok}/${rows.length} 완료`);
      } else {
        fail++;
        if (fail <= 10) console.warn(`  [miss] ${r.address}`);
      }
    } catch (e) {
      fail++;
      console.error(`  [err] ${r.id} ${r.address}: ${e}`);
    }
    await sleep(DELAY);
  }
  console.log(`완료 — 성공 ${ok}건, 실패 ${fail}건`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
