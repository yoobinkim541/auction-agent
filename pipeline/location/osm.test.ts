import { describe, it, expect } from 'vitest';
import { tagMatches, overpassSelector, type PoiCat } from './osm.ts';

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
