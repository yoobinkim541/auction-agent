/**
 * 입지분석: 지오코딩(카카오) → 실거래가(국토부) 기반 안전마진 + 주변 POI.
 * 외부 키가 없으면 해당 신호는 null로 비우고 진행(graceful degradation).
 */
import type { Listing, LocationAnalysis, Comparable, PropertyType } from '../../shared/types.ts';
import { addressToLawdCd } from './lawd-codes.ts';
import { fetchMolitRaw, molitQuotaHit } from '../../shared/molit-cache.ts';
import { geocodeSmart, stripToJibun } from './osm.ts';
import {
  parseMolitJson, extractDong, extractBuildingName, extractLotNumber, estimateMarketPrice, capMarketPrice, type MolitItem,
} from './comps.ts';
import { recentYearMonths } from '../../shared/stats.ts';
import { parcelLocality, readCache, writeCache } from './public-records.ts';

const KAKAO = 'https://dapi.kakao.com/v2/local';
// 국토부 실거래가 — 물건종류별 base 엔드포인트(DB 캐시는 shared/molit-cache 가 담당)
const MOLIT_ENDPOINT: Partial<Record<PropertyType, string>> = {
  apartment: 'RTMSDataSvcAptTrade',   // 아파트 매매
  villa: 'RTMSDataSvcRHTrade',        // 연립다세대 매매
  officetel: 'RTMSDataSvcOffiTrade',  // 오피스텔 매매(승인 시)
  house: 'RTMSDataSvcSHTrade',        // 단독다가구 — k-skill 프록시
  commercial: 'RTMSDataSvcNrgTrade',  // 상업업무 — k-skill 프록시
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
    if (items === null) continue; // 캐시 없는 월 건너뜀 — 쿼터 시에도 다른 월 캐시는 활용
    out.push(...parseMolitJson(items as MolitItem[]));
  }
  return out;
}

/** null = 호출 실패(키 없음·한도 초과·장애). 0건과 구분한다. */
async function kakaoCategoryCount(code: string, lat: number, lng: number, radius: number): Promise<number | null> {
  const j = await kakaoGet<{ meta?: { total_count?: number } }>(
    `/search/category.json?category_group_code=${code}&x=${lng}&y=${lat}&radius=${radius}&size=15`,
  );
  return j ? j.meta?.total_count ?? 0 : null;
}

/** null = 호출 실패. 1.5km 안에 역이 없으면 빈 객체. */
async function nearestStation(lat: number, lng: number): Promise<{ name?: string; distanceM?: number } | null> {
  const j = await kakaoGet<{ documents: { place_name: string; distance: string }[] }>(
    `/search/category.json?category_group_code=SW8&x=${lng}&y=${lat}&radius=1500&sort=distance&size=1`,
  );
  if (!j) return null;
  const d = j.documents?.[0];
  return d ? { name: d.place_name, distanceM: parseInt(d.distance, 10) } : {};
}

type NearbyPoi = Pick<LocationAnalysis, 'transit' | 'schools' | 'amenities'>;

/**
 * 주변 역·학교·편의시설. 물건마다 카테고리 검색 8회라 좌표(소수 4자리, 약 10m)별로 캐시한다 —
 * 매일 전체 재분석이 카카오 무료 한도(API별 하루 10만 건)를 쓰지 않게. 한 건이라도 실패하면 0으로 굳히지 않고 비운다.
 */
async function nearbyPoi(lat: number, lng: number): Promise<NearbyPoi> {
  if (!process.env.KAKAO_REST_KEY) return {};
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = await readCache('poi', key);
  if (hit) return hit as NearbyPoi;
  const [station, mart, convenience, hospital, pharmacy, cafe, academyCount, schoolCount] = await Promise.all([
    nearestStation(lat, lng),
    kakaoCategoryCount('MT1', lat, lng, 1000),
    kakaoCategoryCount('CS2', lat, lng, 500),
    kakaoCategoryCount('HP8', lat, lng, 1000),
    kakaoCategoryCount('PM9', lat, lng, 500),
    kakaoCategoryCount('CE7', lat, lng, 500),
    kakaoCategoryCount('AC5', lat, lng, 1000),
    kakaoCategoryCount('SC4', lat, lng, 1000),
  ]);
  if (station === null || mart === null || convenience === null || hospital === null || pharmacy === null || cafe === null || academyCount === null || schoolCount === null) return {};
  const poi: NearbyPoi = {
    transit: station.name ? { nearestStation: station.name, walkMinutes: station.distanceM ? Math.round(station.distanceM / 80) : undefined } : undefined,
    amenities: { mart, convenience, hospital, pharmacy, cafe },
    schools: { academyCount, schoolCount },
  };
  await writeCache('poi', key, poi);
  return poi;
}

export interface LocationOptions {
  buildingName?: string;
  tradeMonths?: number; // 실거래 조회 기간(개월)
  buildYear?: number; // 사용승인 연도(건축물대장) — 동 단위 비교군을 비슷한 연식으로 좁힌다
}

/** 주소 표로 시군구·동을 고르고, 동이 없는 도로명 주소는 주소→필지 변환(캐시)으로 채운다. */
export async function resolveLocality(address: string): Promise<{ lawdCd?: string; dong?: string }> {
  let lawdCd = addressToLawdCd(address);
  let dong = extractDong(address);
  if (!lawdCd || !dong) {
    const parcel = await parcelLocality(address);
    lawdCd ??= parcel?.lawdCd;
    dong ??= parcel?.dong;
  }
  return { lawdCd, dong };
}

export async function analyzeLocation(listing: Listing, opts: LocationOptions = {}): Promise<LocationAnalysis> {
  let geo: GeocodeResult | null = null;
  if (listing.lat && listing.lng) {
    geo = { lat: listing.lat, lng: listing.lng, lawdCd: addressToLawdCd(listing.address) };
  } else {
    // 카카오(키 있을 때) → 네이버(fallback, 지번 정제 재시도 포함) 순으로 지오코딩 시도
    const addr = listing.roadAddress || listing.address;
    geo = await kakaoGeocode(addr);
    if (!geo) {
      const stripped = stripToJibun(addr);
      if (stripped !== addr) geo = await kakaoGeocode(stripped);
    }
    if (!geo) {
      const n = await geocodeSmart(addr);
      if (n) geo = { lat: n.lat, lng: n.lng, lawdCd: addressToLawdCd(listing.address) };
    }
  }

  // 지오코딩 없어도 주소→법정동코드 테이블로 LAWD_CD 확보(안전마진용)
  const locality = MOLIT_ENDPOINT[listing.propertyType] ? await resolveLocality(listing.address) : {};
  const lawdCd = geo?.lawdCd ?? locality.lawdCd;

  let comps: Comparable[] = [];
  let marketPrice: number | null = null;
  let marketConfidence: LocationAnalysis['marketConfidence'] = null;
  let compBasis: string | undefined;
  if (lawdCd && MOLIT_ENDPOINT[listing.propertyType]) {
    const all = await molitTrades(listing.propertyType, lawdCd, opts.tradeMonths ?? 12);
    const est = estimateMarketPrice(all, {
      areaM2: listing.areaM2,
      dong: listing.legalDong ?? locality.dong,
      buildingName: opts.buildingName ?? listing.buildingName ?? extractBuildingName(listing.address),
      jibun: listing.lotNo ?? extractLotNumber(listing.address),
      buildYear: opts.buildYear,
      propertyType: listing.propertyType,
    });
    comps = est.used;
    marketPrice = est.marketPrice;
    marketConfidence = est.confidence;
    compBasis = est.basis;
  }

  // 실거래 비교군 부족 → 감정가×90% 저신뢰 fallback(쿼터 차단 중엔 적용 안 함 — prevMarket 보존 우선)
  if (marketPrice === null && !molitQuotaHit() && listing.appraisalValue && listing.appraisalValue > 0) {
    marketPrice = Math.round(listing.appraisalValue * 0.90);
    marketConfidence = 'low';
    compBasis = `감정가(${(listing.appraisalValue / 100_000_000).toFixed(2)}억)×90% 추정 — 실거래 비교군 부족, 저신뢰`;
  }

  // 시세 sanity 상한(가짜 마진 방지) — 백테스트상 '고점수→유찰'의 최대 원인이 저신뢰 시세 과대추정.
  {
    const capped = capMarketPrice(marketPrice, marketConfidence, listing.appraisalValue, listing.propertyType);
    if (capped.capped) {
      compBasis = `${compBasis ?? ''} → 감정가 대비 과대(${capped.overPct}%)로 ${capped.thinType ? '감정가' : '감정가×1.3'} 상한(저신뢰 실거래 매칭 의심)`;
    } else if (capped.underPct != null) {
      compBasis = `${compBasis ?? ''} → 감정가의 ${capped.underPct}% — 층·건물급이 다른 비교군 의심, 저신뢰`;
    }
    marketPrice = capped.marketPrice;
    marketConfidence = capped.confidence;
  }

  const safetyMargin =
    marketPrice && marketPrice > 0 && listing.minBidPrice
      ? (marketPrice - listing.minBidPrice) / marketPrice
      : null;

  const { transit, schools, amenities } = geo ? await nearbyPoi(geo.lat, geo.lng) : {};

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
