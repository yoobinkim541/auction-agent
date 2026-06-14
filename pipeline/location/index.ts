/**
 * 입지분석: 지오코딩(카카오) → 실거래가(국토부) 기반 안전마진 + 주변 POI.
 * 외부 키가 없으면 해당 신호는 null로 비우고 진행(graceful degradation).
 */
import type { Listing, LocationAnalysis, Comparable, PropertyType } from '../../shared/types.ts';
import { addressToLawdCd } from './lawd-codes.ts';

const KAKAO = 'https://dapi.kakao.com/v2/local';
// 국토부 실거래가 — base 엔드포인트 + _type=json + User-Agent 필요(Dev 엔드포인트는 data.go.kr WAF에 차단됨)
const MOLIT_BASE = 'https://apis.data.go.kr/1613000';
const MOLIT_ENDPOINT: Partial<Record<PropertyType, string>> = {
  apartment: 'RTMSDataSvcAptTrade',   // 아파트 매매
  villa: 'RTMSDataSvcRHTrade',        // 연립다세대 매매
  officetel: 'RTMSDataSvcOffiTrade',  // 오피스텔 매매(승인 시)
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

interface GeocodeResult {
  lat: number;
  lng: number;
  roadAddress?: string;
  lawdCd?: string; // 법정동코드 앞 5자리(LAWD_CD)
  bCode?: string;
}

async function kakaoGeocode(address: string): Promise<GeocodeResult | null> {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return null;
  const res = await fetch(`${KAKAO}/search/address.json?query=${encodeURIComponent(address)}`, {
    headers: { Authorization: `KakaoAK ${key}` },
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    documents: { x: string; y: string; address?: { b_code?: string }; road_address?: { address_name?: string } }[];
  };
  const d = j.documents?.[0];
  if (!d) return null;
  const bCode = d.address?.b_code;
  return {
    lat: parseFloat(d.y),
    lng: parseFloat(d.x),
    roadAddress: d.road_address?.address_name,
    bCode,
    lawdCd: bCode ? bCode.slice(0, 5) : undefined,
  };
}

/** 국토부 매매 실거래가(최근 N개월) — 물건종류별 base 엔드포인트 + JSON. */
async function molitTrades(propertyType: PropertyType, lawdCd: string, months: number): Promise<Comparable[]> {
  const ep = MOLIT_ENDPOINT[propertyType];
  const key = process.env.MOLIT_SERVICE_KEY;
  if (!ep || !key) return [];
  const out: Comparable[] = [];
  for (const ym of recentYearMonths(months)) {
    const url =
      `${MOLIT_BASE}/${ep}/get${ep}?serviceKey=${encodeURIComponent(key)}&LAWD_CD=${lawdCd}&DEAL_YMD=${ym}&numOfRows=400&pageNo=1&_type=json`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
      const json = (await res.json()) as MolitResponse;
      out.push(...parseMolitJson(json?.response?.body?.items?.item));
    } catch {
      /* 개별 월 실패는 무시 */
    }
  }
  return out;
}

interface MolitItem {
  dealAmount?: string; excluUseAr?: number | string;
  dealYear?: number | string; dealMonth?: number | string; dealDay?: number | string;
  floor?: number | string;
  aptNm?: string; mhouseNm?: string; offiNm?: string;
}
interface MolitResponse { response?: { body?: { items?: { item?: MolitItem | MolitItem[] } } } }

function parseMolitJson(item: MolitItem | MolitItem[] | undefined): Comparable[] {
  const items = Array.isArray(item) ? item : item ? [item] : [];
  const comps: Comparable[] = [];
  for (const it of items) {
    const dealAmount = parseInt(String(it.dealAmount ?? '').replace(/[^0-9]/g, ''), 10) * 10_000; // 만원→원
    const areaM2 = parseFloat(String(it.excluUseAr ?? ''));
    if (!dealAmount || !areaM2) continue;
    const name = it.aptNm || it.mhouseNm || it.offiNm;
    comps.push({
      apartmentName: name?.trim() || undefined,
      areaM2,
      dealAmount,
      dealDate: `${it.dealYear}-${String(it.dealMonth ?? 1).padStart(2, '0')}-${String(it.dealDay ?? 1).padStart(2, '0')}`,
      floor: it.floor != null ? parseInt(String(it.floor), 10) : undefined,
    });
  }
  return comps;
}

function recentYearMonths(months: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** 면적·단지명으로 비교군 선별 후 시세 추정 */
function estimateMarketPrice(comps: Comparable[], areaM2?: number, buildingName?: string): {
  marketPrice: number | null;
  used: Comparable[];
} {
  let pool = comps;
  if (buildingName) {
    const nameMatched = pool.filter((c) => c.apartmentName && c.apartmentName.includes(buildingName));
    if (nameMatched.length >= 3) pool = nameMatched;
  }
  if (areaM2) {
    const tol = areaM2 * 0.1;
    const areaMatched = pool.filter((c) => Math.abs(c.areaM2 - areaM2) <= tol);
    if (areaMatched.length >= 3) pool = areaMatched;
  }
  const used = pool.slice(0, 30);
  return { marketPrice: median(used.map((c) => c.dealAmount)), used };
}

async function kakaoCategoryCount(code: string, lat: number, lng: number, radius: number): Promise<number> {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return 0;
  const res = await fetch(
    `${KAKAO}/search/category.json?category_group_code=${code}&x=${lng}&y=${lat}&radius=${radius}&size=15`,
    { headers: { Authorization: `KakaoAK ${key}` } },
  );
  if (!res.ok) return 0;
  const j = (await res.json()) as { meta?: { total_count?: number } };
  return j.meta?.total_count ?? 0;
}

async function nearestStation(lat: number, lng: number): Promise<{ name?: string; distanceM?: number } | null> {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return null;
  const res = await fetch(
    `${KAKAO}/search/category.json?category_group_code=SW8&x=${lng}&y=${lat}&radius=1500&sort=distance&size=1`,
    { headers: { Authorization: `KakaoAK ${key}` } },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as { documents: { place_name: string; distance: string }[] };
  const d = j.documents?.[0];
  return d ? { name: d.place_name, distanceM: parseInt(d.distance, 10) } : null;
}

export interface LocationOptions {
  buildingName?: string;
  tradeMonths?: number; // 실거래 조회 기간(개월)
}

export async function analyzeLocation(listing: Listing, opts: LocationOptions = {}): Promise<LocationAnalysis> {
  const geo = listing.lat && listing.lng
    ? { lat: listing.lat, lng: listing.lng, lawdCd: addressToLawdCd(listing.address) }
    : await kakaoGeocode(listing.roadAddress || listing.address);

  // 카카오 지오코딩이 없어도 주소→법정동코드 테이블로 LAWD_CD 확보(안전마진용)
  const lawdCd = geo?.lawdCd ?? addressToLawdCd(listing.address);

  let comps: Comparable[] = [];
  let marketPrice: number | null = null;
  if (lawdCd && MOLIT_ENDPOINT[listing.propertyType]) {
    const all = await molitTrades(listing.propertyType, lawdCd, opts.tradeMonths ?? 6);
    const est = estimateMarketPrice(all, listing.areaM2, opts.buildingName);
    comps = est.used;
    marketPrice = est.marketPrice;
  }

  const safetyMargin =
    marketPrice && marketPrice > 0 && listing.minBidPrice
      ? (marketPrice - listing.minBidPrice) / marketPrice
      : null;

  let transit, schools, amenities;
  if (geo) {
    const station = await nearestStation(geo.lat, geo.lng);
    transit = station ? { nearestStation: station.name, walkMinutes: station.distanceM ? Math.round(station.distanceM / 80) : undefined } : undefined;
    const [mart, conv, hosp, pharm, cafe, academy, school] = await Promise.all([
      kakaoCategoryCount('MT1', geo.lat, geo.lng, 1000),
      kakaoCategoryCount('CS2', geo.lat, geo.lng, 500),
      kakaoCategoryCount('HP8', geo.lat, geo.lng, 1000),
      kakaoCategoryCount('PM9', geo.lat, geo.lng, 500),
      kakaoCategoryCount('CE7', geo.lat, geo.lng, 500),
      kakaoCategoryCount('AC5', geo.lat, geo.lng, 1000),
      kakaoCategoryCount('SC4', geo.lat, geo.lng, 1000),
    ]);
    amenities = { mart, convenience: conv, hospital: hosp, pharmacy: pharm, cafe };
    schools = { academyCount: academy, schoolCount: school };
  }

  return {
    caseNo: listing.caseNo,
    marketPrice,
    comps,
    safetyMargin,
    transit,
    schools,
    amenities,
  };
}
