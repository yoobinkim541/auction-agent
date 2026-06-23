/**
 * 입지분석: 지오코딩(카카오) → 실거래가(국토부) 기반 안전마진 + 주변 POI.
 * 외부 키가 없으면 해당 신호는 null로 비우고 진행(graceful degradation).
 */
import type { Listing, LocationAnalysis, Comparable, PropertyType } from '../../shared/types.ts';
import { addressToLawdCd } from './lawd-codes.ts';
import { fetchMolitRaw, molitQuotaHit } from '../../shared/molit-cache.ts';
import { geocodeNaver } from './osm.ts';
import {
  parseMolitDealAmount, extractDong, extractBuildingName, estimateMarketPrice,
} from './comps.ts';
import { recentYearMonths } from '../../shared/stats.ts';

const KAKAO = 'https://dapi.kakao.com/v2/local';
// 국토부 실거래가 — 물건종류별 base 엔드포인트(DB 캐시는 shared/molit-cache 가 담당)
const MOLIT_ENDPOINT: Partial<Record<PropertyType, string>> = {
  apartment: 'RTMSDataSvcAptTrade',   // 아파트 매매
  villa: 'RTMSDataSvcRHTrade',        // 연립다세대 매매
  officetel: 'RTMSDataSvcOffiTrade',  // 오피스텔 매매(승인 시)
};

interface GeocodeResult {
  lat: number;
  lng: number;
  roadAddress?: string;
  lawdCd?: string; // 법정동코드 앞 5자리(LAWD_CD)
  bCode?: string;
}

/** Kakao Local API GET — 키 없거나 네트워크/비정상응답이면 null(throw-safe, graceful degradation). */
async function kakaoGet<T>(path: string): Promise<T | null> {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${KAKAO}${path}`, {
      headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(12000),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch { return null; }
}

async function kakaoGeocode(address: string): Promise<GeocodeResult | null> {
  const j = await kakaoGet<{
    documents: { x: string; y: string; address?: { b_code?: string }; road_address?: { address_name?: string } }[];
  }>(`/search/address.json?query=${encodeURIComponent(address)}`);
  const d = j?.documents?.[0];
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

/** 국토부 매매 실거래가(최근 N개월) — DB 영구 캐시(shared/molit-cache) 경유로 쿼터 절약. */
async function molitTrades(propertyType: PropertyType, lawdCd: string, months: number): Promise<Comparable[]> {
  const ep = MOLIT_ENDPOINT[propertyType];
  if (!ep) return [];
  const out: Comparable[] = [];
  for (const ym of recentYearMonths(months)) {
    const items = await fetchMolitRaw(ep, lawdCd, ym);
    if (items === null) { if (molitQuotaHit()) break; else continue; } // 쿼터/장애 → 중단
    out.push(...parseMolitJson(items as MolitItem[]));
  }
  return out;
}

interface MolitItem {
  dealAmount?: string; excluUseAr?: number | string;
  dealYear?: number | string; dealMonth?: number | string; dealDay?: number | string;
  floor?: number | string; buildYear?: number | string; umdNm?: string;
  aptNm?: string; mhouseNm?: string; offiNm?: string;
}
function parseMolitJson(item: MolitItem | MolitItem[] | undefined): Comparable[] {
  const items = Array.isArray(item) ? item : item ? [item] : [];
  const comps: Comparable[] = [];
  for (const it of items) {
    const dealAmount = parseMolitDealAmount(it.dealAmount); // 음수·정정표기·비정상값 거부
    const areaM2 = parseFloat(String(it.excluUseAr ?? ''));
    if (!dealAmount || !areaM2) continue;
    const name = it.aptNm || it.mhouseNm || it.offiNm;
    comps.push({
      apartmentName: name != null ? String(name).trim() || undefined : undefined,
      dong: it.umdNm?.trim() || undefined,
      areaM2,
      dealAmount,
      dealDate: `${it.dealYear}-${String(it.dealMonth ?? 1).padStart(2, '0')}-${String(it.dealDay ?? 1).padStart(2, '0')}`,
      floor: it.floor != null ? parseInt(String(it.floor), 10) : undefined,
      buildYear: it.buildYear != null ? parseInt(String(it.buildYear), 10) : undefined,
    });
  }
  return comps;
}


async function kakaoCategoryCount(code: string, lat: number, lng: number, radius: number): Promise<number> {
  const j = await kakaoGet<{ meta?: { total_count?: number } }>(
    `/search/category.json?category_group_code=${code}&x=${lng}&y=${lat}&radius=${radius}&size=15`,
  );
  return j?.meta?.total_count ?? 0;
}

async function nearestStation(lat: number, lng: number): Promise<{ name?: string; distanceM?: number } | null> {
  const j = await kakaoGet<{ documents: { place_name: string; distance: string }[] }>(
    `/search/category.json?category_group_code=SW8&x=${lng}&y=${lat}&radius=1500&sort=distance&size=1`,
  );
  const d = j?.documents?.[0];
  return d ? { name: d.place_name, distanceM: parseInt(d.distance, 10) } : null;
}

export interface LocationOptions {
  buildingName?: string;
  tradeMonths?: number; // 실거래 조회 기간(개월)
}

export async function analyzeLocation(listing: Listing, opts: LocationOptions = {}): Promise<LocationAnalysis> {
  let geo: GeocodeResult | null = null;
  if (listing.lat && listing.lng) {
    geo = { lat: listing.lat, lng: listing.lng, lawdCd: addressToLawdCd(listing.address) };
  } else {
    // 카카오(키 있을 때) → 네이버(fallback) 순으로 지오코딩 시도
    const addr = listing.roadAddress || listing.address;
    geo = await kakaoGeocode(addr);
    if (!geo) {
      const n = await geocodeNaver(addr);
      if (n) geo = { lat: n.lat, lng: n.lng, lawdCd: addressToLawdCd(listing.address) };
    }
  }

  // 지오코딩 없어도 주소→법정동코드 테이블로 LAWD_CD 확보(안전마진용)
  const lawdCd = geo?.lawdCd ?? addressToLawdCd(listing.address);

  let comps: Comparable[] = [];
  let marketPrice: number | null = null;
  let marketConfidence: LocationAnalysis['marketConfidence'] = null;
  let compBasis: string | undefined;
  if (lawdCd && MOLIT_ENDPOINT[listing.propertyType]) {
    const all = await molitTrades(listing.propertyType, lawdCd, opts.tradeMonths ?? 12);
    const dong = extractDong(listing.address);
    const buildingName = opts.buildingName ?? extractBuildingName(listing.address);
    const est = estimateMarketPrice(all, { areaM2: listing.areaM2, dong, buildingName });
    comps = est.used;
    marketPrice = est.marketPrice;
    marketConfidence = est.confidence;
    compBasis = est.basis;
  }

  // 실거래 비교군 부족 → 감정가×90% 저신뢰 fallback(감정평가일이 경매 개시보다 수개월 앞서 괴리 존재)
  if (marketPrice === null && listing.appraisalValue && listing.appraisalValue > 0) {
    marketPrice = Math.round(listing.appraisalValue * 0.90);
    marketConfidence = 'low';
    compBasis = `감정가(${(listing.appraisalValue / 100_000_000).toFixed(2)}억)×90% 추정 — 실거래 비교군 부족, 저신뢰`;
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
    marketConfidence,
    compBasis,
    safetyMargin,
    transit,
    schools,
    amenities,
    resolvedLat: geo?.lat,
    resolvedLng: geo?.lng,
  };
}

/** 주소 → 카카오 좌표 (외부에서 단독 사용, 예: bulk geocoding). */
export { kakaoGeocode };
