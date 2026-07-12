import { describe, expect, it } from 'vitest';
import { buildRoutes, formatRoutes, haversineKm, nearestOrder, type RoutePoint } from './route-plan.ts';

const p = (caseNo: string, lat: number, lng: number, over: Partial<RoutePoint> = {}): RoutePoint => ({
  caseNo, address: '인천광역시 미추홀구 어딘가', saleDate: '2026-07-15', lat, lng, score: 100, ...over,
});

describe('haversineKm', () => {
  it('서울시청↔인천시청 ≈ 27km', () => {
    const d = haversineKm({ lat: 37.5663, lng: 126.9779 }, { lat: 37.4563, lng: 126.7052 });
    expect(d).toBeGreaterThan(24);
    expect(d).toBeLessThan(30);
  });
  it('같은 점은 0', () => {
    expect(haversineKm({ lat: 37.5, lng: 127 }, { lat: 37.5, lng: 127 })).toBe(0);
  });
});

describe('nearestOrder', () => {
  it('서쪽에서 출발해 가까운 순으로 잇는다', () => {
    const pts = [p('c', 37.5, 127.10), p('a', 37.5, 127.00), p('b', 37.5, 127.04)];
    expect(nearestOrder(pts).map((x) => x.caseNo)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildRoutes/formatRoutes', () => {
  it('시군구별 그룹 + 이동거리 + 카카오맵 링크', () => {
    const pts = [
      p('2024타경1', 37.46, 126.65, { address: '인천광역시 미추홀구 매소홀로 262' }),
      p('2024타경2', 37.47, 126.66, { address: '인천광역시 미추홀구 숭의동 1' }),
      p('2025타경3', 37.60, 127.02, { address: '서울특별시 성북구 석관동 340' }),
    ];
    const groups = buildRoutes(pts);
    expect(groups[0]!.region).toBe('인천광역시 미추홀구');
    expect(groups[0]!.points).toHaveLength(2);
    const s = formatRoutes(groups, { totalCandidates: 3, noCoord: 1 });
    expect(s).toContain('🗺 이번 주 임장 코스 — 후보 3건 (좌표없음 1건 제외)');
    expect(s).toContain('📍 인천광역시 미추홀구 2건');
    expect(s).toContain('https://map.kakao.com/link/map/');
    expect(s).toContain('이동 약 ');
  });
  it('후보 없으면 빈 문자열', () => {
    expect(formatRoutes([], { totalCandidates: 0, noCoord: 0 })).toBe('');
  });
});
