/**
 * 임장 동선 계획(발품절감 ④, 순수 — DB/IO 없음, 테스트 가능) — 이번 주 기일 후보를
 * 시군구로 묶고 최근접 이웃 순서로 방문 순서를 정해 '하루 임장 코스'를 만든다.
 * field-route.ts가 조회 후 호출.
 */
import { regionKey } from '../pipeline/predict/comps.ts';

export interface RoutePoint {
  caseNo: string;
  address: string;
  saleDate: string | null; // YYYY-MM-DD
  lat: number;
  lng: number;
  score: number | null;
}

/** 두 좌표 간 대원거리(km). */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 최근접 이웃 순서(그리디) — 서쪽(경도 최소)에서 출발, 항상 가장 가까운 다음 지점으로. */
export function nearestOrder(points: RoutePoint[]): RoutePoint[] {
  if (points.length <= 2) return [...points];
  const rest = [...points].sort((a, b) => a.lng - b.lng);
  const out: RoutePoint[] = [rest.shift()!];
  while (rest.length) {
    const cur = out[out.length - 1]!;
    let bi = 0;
    for (let i = 1; i < rest.length; i++) {
      if (haversineKm(cur, rest[i]!) < haversineKm(cur, rest[bi]!)) bi = i;
    }
    out.push(rest.splice(bi, 1)[0]!);
  }
  return out;
}

export interface RouteGroup { region: string; points: RoutePoint[]; totalKm: number }

/** 시군구별 코스 — 건수 많은 지역 순, 그룹당 최대 maxPerGroup건(과밀 방지). */
export function buildRoutes(points: RoutePoint[], maxGroups = 4, maxPerGroup = 6): RouteGroup[] {
  const byRegion = new Map<string, RoutePoint[]>();
  for (const p of points) {
    const k = regionKey(p.address);
    byRegion.set(k, [...(byRegion.get(k) ?? []), p]);
  }
  return [...byRegion.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxGroups)
    .map(([region, pts]) => {
      const ordered = nearestOrder(pts).slice(0, maxPerGroup);
      let totalKm = 0;
      for (let i = 1; i < ordered.length; i++) totalKm += haversineKm(ordered[i - 1]!, ordered[i]!);
      return { region, points: ordered, totalKm };
    });
}

const mmdd = (d: string | null): string => (d ? d.slice(5) : '-');

/** 텔레그램용 임장 코스 텍스트 — 후보 없으면 빈 문자열. */
export function formatRoutes(groups: RouteGroup[], opts: { totalCandidates: number; noCoord: number }): string {
  if (!groups.length) return '';
  const out: string[] = [`🗺 이번 주 임장 코스 — 후보 ${opts.totalCandidates}건${opts.noCoord ? ` (좌표없음 ${opts.noCoord}건 제외)` : ''}`];
  for (const g of groups) {
    out.push(`📍 ${g.region} ${g.points.length}건${g.points.length > 1 ? ` · 이동 약 ${g.totalKm.toFixed(1)}km` : ''}`);
    g.points.forEach((p, i) => {
      const short = p.address.split(/\s+/).slice(2).join(' ').slice(0, 18) || p.address.slice(0, 18);
      out.push(`  ${i + 1}) ${p.caseNo} ${short} (기일 ${mmdd(p.saleDate)}${p.score != null ? ` ⭐${p.score}` : ''})`);
      out.push(`     https://map.kakao.com/link/map/${encodeURIComponent(p.caseNo)},${p.lat},${p.lng}`);
    });
  }
  out.push('※ 순서는 최근접 이웃 기준 — 현장 체크리스트는 대시보드 상세의 임장 모드에서.');
  return out.join('\n');
}
