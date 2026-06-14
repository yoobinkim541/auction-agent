/**
 * 입지분석: 지오코딩(카카오) → 실거래가(국토부) 기반 안전마진 + 주변 POI.
 * 외부 키가 없으면 해당 신호는 null로 비우고 진행(graceful degradation).
 */
import type { Listing, LocationAnalysis, Comparable } from '../../shared/types.ts';

const KAKAO = 'https://dapi.kakao.com/v2/local';
const MOLIT = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';

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

/** 국토부 아파트 매매 실거래가(최근 N개월). 의존성 없이 XML을 경량 파싱. */
async function molitAptTrades(lawdCd: string, months: number): Promise<Comparable[]> {
  const key = process.env.MOLIT_SERVICE_KEY;
  if (!key) return [];
  const yms = recentYearMonths(months);
  const out: Comparable[] = [];
  for (const ym of yms) {
    const url =
      `${MOLIT}?serviceKey=${encodeURIComponent(key)}&LAWD_CD=${lawdCd}&DEAL_YMD=${ym}&numOfRows=200&pageNo=1`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const xml = await res.text();
      out.push(...parseMolitItems(xml));
    } catch {
      /* 개별 월 실패는 무시 */
    }
  }
  return out;
}

function parseMolitItems(xml: string): Comparable[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const tag = (block: string, name: string) => {
    const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? m[1]!.trim() : '';
  };
  const comps: Comparable[] = [];
  for (const it of items) {
    // 신/구 태그명 모두 대응(거래금액/dealAmount, 전용면적/excluUseAr 등)
    const amountStr = tag(it, '거래금액') || tag(it, 'dealAmount');
    const areaStr = tag(it, '전용면적') || tag(it, 'excluUseAr');
    const y = tag(it, '년') || tag(it, 'dealYear');
    const mo = tag(it, '월') || tag(it, 'dealMonth');
    const da = tag(it, '일') || tag(it, 'dealDay');
    const name = tag(it, '아파트') || tag(it, 'aptNm');
    const floor = tag(it, '층') || tag(it, 'floor');
    if (!amountStr || !areaStr) continue;
    const dealAmount = parseInt(amountStr.replace(/[^0-9]/g, ''), 10) * 10_000; // 만원→원
    const areaM2 = parseFloat(areaStr);
    if (!dealAmount || !areaM2) continue;
    comps.push({
      apartmentName: name || undefined,
      areaM2,
      dealAmount,
      dealDate: `${y}-${String(mo).padStart(2, '0')}-${String(da || '1').padStart(2, '0')}`,
      floor: floor ? parseInt(floor, 10) : undefined,
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
    ? { lat: listing.lat, lng: listing.lng, lawdCd: undefined as string | undefined }
    : await kakaoGeocode(listing.roadAddress || listing.address);

  let comps: Comparable[] = [];
  let marketPrice: number | null = null;
  if (geo?.lawdCd && (listing.propertyType === 'apartment')) {
    const all = await molitAptTrades(geo.lawdCd, opts.tradeMonths ?? 6);
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
