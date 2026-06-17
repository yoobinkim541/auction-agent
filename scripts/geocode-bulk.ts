/**
 * 기존 gm_listings 중 lat/lng 없는 매물을 네이버 지오코딩으로 일괄 보완.
 *   npm run geocode:bulk
 *
 * NAVER_MAP_CLIENT_ID / NAVER_MAP_CLIENT_SECRET 필요. 기본 300ms 간격.
 */
import 'dotenv/config';
import { query } from '../shared/db.ts';
import { geocodeNaver } from '../pipeline/location/osm.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELAY = parseInt(process.env.GEOCODE_DELAY_MS ?? '320', 10);

async function main() {
  const rows = await query<{ id: number; address: string }>(
    `SELECT id, address FROM gm_listings WHERE lat IS NULL OR lng IS NULL ORDER BY id`,
  );
  console.log(`지오코딩 대상: ${rows.length}건 · 간격 ${DELAY}ms`);
  if (!rows.length) { console.log('모두 완료됨.'); return; }

  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      const geo = await geocodeNaver(r.address);
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
