/**
 * 임장 동선(발품절감 ④) — 이번 주(7일 내) 기일의 통과/★ 매물을 시군구 코스로 묶어 출력.
 *   봇 /route(=/임장) 명령이 stdout을 그대로 응답. 후보 없으면 안내 한 줄.
 * 사용: npm run route
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import { buildRoutes, formatRoutes, type RoutePoint } from './route-plan.ts';

async function main(): Promise<void> {
  const rows = await query<{ case_no: string; address: string; sale_date: string | null; lat: number | null; lng: number | null; total_score: number | null }>(
    `select l.case_no, l.address, l.sale_date::text, l.lat, l.lng, s.total_score::int
       from gm_listings l
       left join gm_scores s on s.listing_id = l.id
      where l.sale_date >= current_date and l.sale_date <= current_date + 7
        and (l.is_favorite = true or coalesce(s.passed_filter, false))
      order by s.total_score desc nulls last
      limit 40`,
  );
  const withCoord: RoutePoint[] = rows
    .filter((r): r is typeof r & { lat: number; lng: number } => r.lat != null && r.lng != null)
    .map((r) => ({ caseNo: r.case_no, address: r.address, saleDate: r.sale_date, lat: r.lat, lng: r.lng, score: r.total_score }));

  const text = formatRoutes(buildRoutes(withCoord), { totalCandidates: rows.length, noCoord: rows.length - withCoord.length });
  console.log(text || '이번 주(7일 내) 기일의 임장 후보가 없습니다.');
  await pool().end();
}

main().catch((e) => { console.error('field-route 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
