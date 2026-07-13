import { describe, it, expect } from 'vitest';
import { tagMatches, overpassSelector, stripToJibun, type PoiCat } from './osm.ts';

const station: PoiCat = { label: '역', osm: 'node', k: 'railway', v: 'station', radius: 1200 };
const bigRoad: PoiCat = { label: '대로변', osm: 'way', k: 'highway', v: /^(motorway|trunk|primary)$/, radius: 80 };

describe('osm tagMatches', () => {
  it('정확값 일치/불일치/키없음', () => {
    expect(tagMatches(station, { railway: 'station' })).toBe(true);
    expect(tagMatches(station, { railway: 'halt' })).toBe(false);
    expect(tagMatches(station, { shop: 'supermarket' })).toBe(false); // 키 없음
  });
  it('정규식 값(대로변 — 역파싱 없이 직접 매칭)', () => {
    expect(tagMatches(bigRoad, { highway: 'primary' })).toBe(true);
    expect(tagMatches(bigRoad, { highway: 'trunk' })).toBe(true);
    expect(tagMatches(bigRoad, { highway: 'residential' })).toBe(false);
  });
});

describe('osm overpassSelector', () => {
  it('정확값 → ["k"="v"]', () => {
    expect(overpassSelector(station, 37.5, 127)).toBe('node["railway"="station"](around:1200,37.5,127);');
  });
  it('정규식 → ["k"~"src"]', () => {
    expect(overpassSelector(bigRoad, 37.5, 127)).toBe('way["highway"~"^(motorway|trunk|primary)$"](around:80,37.5,127);');
  });
});

describe('stripToJibun (지오코딩용 주소 정제)', () => {
  it('지번 + 건물명·동·호수 꼬리 제거', () => {
    expect(stripToJibun('서울특별시 은평구 응암동 227-54 백련산파크타운 나동 2층203호'))
      .toBe('서울특별시 은평구 응암동 227-54');
    expect(stripToJibun('서울특별시 은평구 구산동 177-143 명성골든빌 비동 5층502호'))
      .toBe('서울특별시 은평구 구산동 177-143');
  });
  it('읍/리 지번도 처리', () => {
    expect(stripToJibun('경기도 화성시 향남읍 상신리 1315-1 어울림아파트 101동'))
      .toBe('경기도 화성시 향남읍 상신리 1315-1');
  });
  it('도로명 주소 + 층호수 꼬리 제거', () => {
    expect(stripToJibun('서울특별시 중구 동호로33길 15 8층801호'))
      .toBe('서울특별시 중구 동호로33길 15');
  });
  it('꼬리 없는 순수 지번 → 그대로', () => {
    expect(stripToJibun('경기도 화성시 향남읍 상신리 1315-1')).toBe('경기도 화성시 향남읍 상신리 1315-1');
  });
  it('패턴 미매칭(산 번지 등) → 원본 유지', () => {
    expect(stripToJibun('강원도 홍천군 서면 산 22')).toBe('강원도 홍천군 서면 산 22');
  });
});
