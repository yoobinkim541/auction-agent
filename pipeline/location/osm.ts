/**
 * 키 없는 입지 분석 — 네이버 지오코딩(보유 키) + OSM Overpass(무키·무전환).
 *   카카오 로컬(앱 비즈니스 전환 필요) 대신 사용. 반경 내 생활인프라 개수 + 소음/혐오시설 근접 플래그.
 *
 * OSM 에티켓: 정직한 User-Agent + 미러 폴백 + 요청 간 지연. 한국 OSM은 주요 POI(역·마트·병원·학교)
 *   커버리지 양호하나 완전치 않음 → '참고용 밀도 지표'.
 */
const NAVER_ID = process.env.NAVER_MAP_CLIENT_ID;
const NAVER_SECRET = process.env.NAVER_MAP_CLIENT_SECRET;
const UA = 'gyeongmae-agent/0.1 (personal real-estate research; contact: owner)';
// 동작 확인된 미러 우선(maps.mail.ru) + 폴백
const OVERPASS_MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export async function geocodeNaver(address: string): Promise<{ lat: number; lng: number } | null> {
  if (!NAVER_ID || !NAVER_SECRET) return null;
  try {
    const r = await fetch(`https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(address)}`,
      { headers: { 'x-ncp-apigw-api-key-id': NAVER_ID, 'x-ncp-apigw-api-key': NAVER_SECRET }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { addresses?: { x: string; y: string }[] };
    const a = j.addresses?.[0];
    return a ? { lat: +a.y, lng: +a.x } : null;
  } catch { return null; }
}

export interface PoiResult {
  amenities: Record<string, number>; // 카테고리별 반경 내 개수
  stationCount: number; // 지하철/철도역 수(1.2km)
  nearest: Record<string, number>; // 카테고리별 최근접 거리(m)
  walkMinToStation: number | null; // 최근접 역 도보 추정(분)
  schools: { elementary: number; middle: number; high: number }; // 주변 초/중/고 개수
  noiseFlags: string[]; // 소음·혐오 근접 플래그
}

const R = 6371000;
function haversine(la1: number, lo1: number, la2: number, lo2: number): number {
  const t = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(t(la2 - la1) / 2) ** 2 + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(t(lo2 - lo1) / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// 카테고리 정의: {라벨, overpass 요소(node/nwr/way), 태그 key, 값(정확 문자열 또는 정규식), 반경m}.
// tally가 이 정의로 직접 태그를 매칭하고 overpass selector도 여기서 생성 — selector 문자열 역파싱 제거.
export interface PoiCat { label: string; osm: 'node' | 'nwr' | 'way'; k: string; v: string | RegExp; radius: number }

// 생활인프라(반경 내 개수)
const CATS: PoiCat[] = [
  { label: '지하철·기차역', osm: 'node', k: 'railway', v: 'station', radius: 1200 },
  { label: '마트', osm: 'node', k: 'shop', v: 'supermarket', radius: 1000 },
  { label: '편의점', osm: 'node', k: 'shop', v: 'convenience', radius: 500 },
  { label: '병원', osm: 'nwr', k: 'amenity', v: 'hospital', radius: 1500 },
  { label: '약국', osm: 'node', k: 'amenity', v: 'pharmacy', radius: 800 },
  { label: '학교', osm: 'nwr', k: 'amenity', v: 'school', radius: 1000 },
  { label: '어린이집·유치원', osm: 'nwr', k: 'amenity', v: 'kindergarten', radius: 800 },
  { label: '공원', osm: 'nwr', k: 'leisure', v: 'park', radius: 1000 },
  { label: '카페', osm: 'node', k: 'amenity', v: 'cafe', radius: 500 },
];
// 소음·혐오(근접 시 플래그)
const NUISANCE: PoiCat[] = [
  { label: '고압 송전탑 인접', osm: 'node', k: 'power', v: 'tower', radius: 300 },
  { label: '대로변(소음)', osm: 'way', k: 'highway', v: /^(motorway|trunk|primary)$/, radius: 80 },
  { label: '철도 인접(소음)', osm: 'way', k: 'railway', v: 'rail', radius: 150 },
  { label: '공장 인접', osm: 'nwr', k: 'landuse', v: 'industrial', radius: 400 },
];

/** OSM 태그가 카테고리 정의와 일치하는지(정확값 또는 정규식). */
export const tagMatches = (cat: PoiCat, tags: Record<string, string>): boolean => {
  const val = tags[cat.k];
  if (val == null) return false;
  return cat.v instanceof RegExp ? cat.v.test(val) : val === cat.v;
};
/** PoiCat → overpass selector(around 포함). */
export const overpassSelector = (cat: PoiCat, lat: number, lng: number): string =>
  `${cat.osm}["${cat.k}"${cat.v instanceof RegExp ? `~"${cat.v.source}"` : `="${cat.v}"`}](around:${cat.radius},${lat},${lng});`;

export async function fetchPoiCounts(lat: number, lng: number): Promise<PoiResult | null> {
  const parts = [...CATS, ...NUISANCE].map((c) => overpassSelector(c, lat, lng)).join('');
  const query = `[out:json][timeout:25];(${parts});out tags center;`;
  for (const ep of OVERPASS_MIRRORS) {
    try {
      const r = await fetch(ep, {
        method: 'POST', body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { elements?: OsmEl[] };
      const els = j.elements ?? [];
      if (!Array.isArray(els)) continue;
      return tally(els, lat, lng);
    } catch { /* 다음 미러 */ }
  }
  return null;
}

interface OsmEl { tags?: Record<string, string>; lat?: number; lon?: number; center?: { lat: number; lon: number } }

function tally(els: OsmEl[], lat: number, lng: number): PoiResult {
  const amenities: Record<string, number> = {};
  const nearest: Record<string, number> = {};
  const noise = new Set<string>();
  const schools = { elementary: 0, middle: 0, high: 0 };
  for (const c of CATS) amenities[c.label] = 0;
  for (const e of els) {
    const t = e.tags ?? {};
    const ll = e.lat != null ? { lat: e.lat, lon: e.lon! } : e.center;
    const dist = ll ? haversine(lat, lng, ll.lat, ll.lon) : null;
    for (const c of CATS) {
      if (!tagMatches(c, t)) continue;
      amenities[c.label] = (amenities[c.label] ?? 0) + 1;
      if (dist != null && (nearest[c.label] == null || dist < nearest[c.label]!)) nearest[c.label] = dist;
      if (c.label === '학교') {
        const nm = t['name'] ?? '';
        if (/초등/.test(nm)) schools.elementary++; else if (/중학교|중학/.test(nm)) schools.middle++; else if (/고등|고교/.test(nm)) schools.high++;
      }
      break;
    }
    for (const c of NUISANCE) if (tagMatches(c, t)) noise.add(c.label);
  }
  for (const k of Object.keys(amenities)) if (amenities[k] === 0) delete amenities[k];
  const stM = nearest['지하철·기차역'];
  const walkMinToStation = stM != null ? Math.max(1, Math.round((stM * 1.3) / 67)) : null; // 도보 67m/분, 우회 1.3
  return { amenities, stationCount: amenities['지하철·기차역'] ?? 0, nearest, walkMinToStation, schools, noiseFlags: [...noise] };
}
