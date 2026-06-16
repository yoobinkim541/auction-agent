/**
 * 입지 POI 보강 러너 — 네이버 지오코딩 + OSM Overpass로 생활인프라 개수·소음/혐오 플래그를
 *   gm_location_analysis(amenities, land_use_flags)에 채운다. 키 없는 Phase 2.
 *
 *   npm run enrich:poi            # 통과(passed) 매물만 (기본, 부하 최소)
 *   npm run enrich:poi -- --all   # 데이터 완전한 전체
 * OSM 무료 미러 에티켓: 요청 간 지연(POI_DELAY_MS, 기본 1500ms) + 정직한 UA + 미러 폴백.
 */
import 'dotenv/config';
import { query } from '../../shared/db.ts';
import { geocodeNaver, fetchPoiCounts } from './osm.ts';
import type { LandUseFlag } from '../../shared/types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const all = process.argv.includes('--all');
  const delay = parseInt(process.env.POI_DELAY_MS ?? '1500', 10);
  // 대상: 분석 완료 + (기본) 통과 매물. lat/lng 캐시 있으면 지오코딩 생략.
  type Transit = { nearestStation?: string; walkMinutes?: number; lines?: number; stations?: unknown[] } | null;
  const rows = await query<{ id: number; address: string; lat: number | null; lng: number | null; passed: boolean | null; land_use_flags: LandUseFlag[] | null; transit: Transit }>(
    `select l.id, l.address, l.lat, l.lng, s.passed_filter as passed, loc.land_use_flags, loc.transit
     from gm_listings l
     join gm_location_analysis loc on loc.listing_id = l.id
     left join gm_scores s on s.listing_id = l.id
     where (loc.transit->>'walkMinutes') is null ${all ? '' : 'and s.passed_filter = true'}
     order by s.total_score desc nulls last`,
  );
  console.log(`POI 보강 대상: ${rows.length}건 ${all ? '(전체)' : '(통과만)'} · 지연 ${delay}ms`);

  let done = 0, ok = 0;
  for (const r of rows) {
    try {
      let lat = r.lat, lng = r.lng;
      if (lat == null || lng == null) {
        const g = await geocodeNaver(r.address);
        if (g) { lat = g.lat; lng = g.lng; await query('update gm_listings set lat=$2, lng=$3 where id=$1', [r.id, lat, lng]); }
      }
      if (lat == null || lng == null) { done++; continue; }
      const poi = await fetchPoiCounts(lat, lng);
      if (poi) {
        // 소음·혐오 → land_use_flags에 risk로 병합(중복 제거)
        const flags: LandUseFlag[] = [...(r.land_use_flags ?? [])];
        for (const n of poi.noiseFlags) {
          if (!flags.some((f) => f.label === n)) flags.push({ keyword: n, label: n, kind: 'risk', severity: 'low', impact: 'OSM 기반 근접 추정 — 실제 소음·영향은 현장 확인' });
        }
        // amenities + 학군(초/중/고) 개수
        const amen: Record<string, number> = { ...poi.amenities };
        if (poi.schools.elementary) amen['초등학교'] = poi.schools.elementary;
        if (poi.schools.middle) amen['중학교'] = poi.schools.middle;
        if (poi.schools.high) amen['고등학교'] = poi.schools.high;
        // transit: 기존(역세권 site_metrics) 유지 + 도보분/최근접 역거리 추가
        const transit = { ...(r.transit ?? {}), walkMinutes: poi.walkMinToStation ?? undefined, osmStationCount: poi.stationCount, nearestStationM: poi.nearest['지하철·기차역'] };
        const schools = { schoolCount: poi.schools.elementary + poi.schools.middle + poi.schools.high, assignedElementary: undefined, assignedMiddle: undefined };
        await query('update gm_location_analysis set amenities=$2::jsonb, land_use_flags=$3::jsonb, transit=$4::jsonb, schools=coalesce(schools,$5::jsonb) where listing_id=$1',
          [r.id, JSON.stringify(amen), JSON.stringify(flags), JSON.stringify(transit), JSON.stringify(schools)]);
        ok++;
      }
      done++;
      if (done % 20 === 0) console.log(`[poi] ${done}/${rows.length} (성공 ${ok})`);
      await sleep(delay);
    } catch (e) {
      console.warn(`[poi] ${r.id} 실패: ${e}`);
      done++;
    }
  }
  console.log(`POI 보강 완료: ${done}건 처리, ${ok}건 적재.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
