/**
 * 실증 낙찰가율 테이블 — 신뢰 낙찰결과(gm_trusted_outcome_eval, 이상치 격리됨)에서 '낙찰가 ÷ 그 회차 최저가'
 *   (최저가 대비 배율)를 종류×지역×회차밴드로 집계해 예상낙찰가(expectedBid)의 근거로 쓴다.
 *   예상 낙찰가율 = 이번 기일 최저가/감정가 × 배율 중앙값.
 *
 * 밴드 안에서도 최저가/감정가가 다르면(예: 2회 유찰이 64%인 법원과 49%인 법원) 낙찰가율이 따라 움직인다.
 *   낙찰가율 중앙값을 그대로 쓰면 그 차이를 버리고, 배율은 물건의 실제 최저가에 얹으므로 살린다.
 *   시간분할 검증(학습 5,412 · 검증 2,320건) 낙찰가율 MAE: 밴드별 낙찰가율 중앙값 0.0626 → 배율 0.0599,
 *   ±10%p 적중 85.3% → 88.1%. 50~90% 다섯 분할 모두에서 낮고, 종류별로 나빠진 곳이 없다.
 *
 * 과거 표본의 최저가는 결과의 최저가(result_min_price)를 쓴다 — 스냅샷 최저가는 한 회차 전 값으로 저장돼 있었다.
 *   낙찰의 96%가 유찰 뒤에 나오므로 55% 미만을 셋으로 나눈다.
 *
 * 계층적 조회(표본 부족 붕괴 방지) — 회차밴드를 끝까지 유지:
 *   1) 종류×지역×밴드 → 2) 종류×밴드(지역통합) → 3) 밴드(종류통합) → 4) 보수적 프라이어(낙찰가율).
 *
 * 아파트는 그 앞에 시세 구간을 먼저 본다: 종류×밴드×(시세÷최저가 구간) → 종류×(시세÷최저가 구간).
 *   같은 건물·같은 면적 실거래로 잡은 시세(신뢰도 high)가 있으면 입찰자들이 최저가가 아니라 시세를 보고 쓰기 때문에,
 *   최저가가 시세보다 많이 낮을수록 최저가 위로 더 얹힌다. 표본의 시세는 그 기일에 볼 수 있었던 실거래로 다시 계산한다
 *   (저장된 과거 시세는 옛 규칙 값이라 쓰지 않는다).
 *   시간분할 다섯 개(50~90%) 평균, 아파트 낙찰가율 MAE 0.0739 → 0.0653, ±10%p 적중 74~75% → 78~80%.
 *   빌라·오피스텔은 같은 방식으로 나아지지 않아(0.0588 → 0.0591, 0.0546 → 0.0551) 넣지 않았다.
 *
 * 프라이어는 통념 수도권 낙찰가율을 '높게' 잡는다 — 낙찰가율을 높게 추정하면 예상낙찰가↑ → 마진↓ →
 *   표본 부족 종류를 과대추천하지 않는 안전한 방향으로 치우친다.
 */
import { median } from '../../shared/stats.ts';
import { query, PARCEL_COLUMNS } from '../../shared/db.ts';
import { addressToLawdCd } from '../location/lawd-codes.ts';
import {
  capMarketPrice, estimateMarketPrice, extractBuildingName, extractDong, extractLotNumber, parseMolitJson, type MolitItem,
} from '../location/comps.ts';
import type { Comparable } from '../../shared/types.ts';

/** 주소 → 지역(수도권 3분). 앞자리 앵커로 '경기도 광주시'의 '광주' 오분류 방지. */
export function regionFromAddress(address: string): string {
  const a = (address ?? '').trim();
  if (/^서울/.test(a)) return '서울';
  if (/^인천/.test(a)) return '인천';
  if (/^경기/.test(a)) return '경기';
  return '기타';
}

export type RoundBand = 'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6';
const BAND_LABEL: Record<RoundBand, string> = {
  r1: '신건', r2: '1회유찰', r3: '2회유찰', r4: '최저가 40~55%', r5: '최저가 28~40%', r6: '최저가 28% 미만',
};

/** 최저가/감정가 비율 → 회차밴드 근사. 법원 저감률(20~30%/회) 기준 경계. */
export function roundBandFromMinBid(minBidPrice: number | null | undefined, appraisalValue: number | null | undefined): RoundBand {
  if (!minBidPrice || !appraisalValue || appraisalValue <= 0) return 'r1'; // 정보 없으면 보수적으로 신건(높은 낙찰가율 프라이어)
  const ratio = minBidPrice / appraisalValue;
  if (ratio >= 0.95) return 'r1';
  if (ratio >= 0.72) return 'r2';
  if (ratio >= 0.55) return 'r3';
  if (ratio >= 0.40) return 'r4';
  if (ratio >= 0.28) return 'r5';
  return 'r6';
}

/** 표본 부족 시 보수적 프라이어(%) — 통념 수도권 낙찰가율. 높게 잡아 과대추천 방지. */
export const TYPE_RATIO_PRIOR: Record<string, number> = {
  apartment: 88, officetel: 80, villa: 70, house: 75, land: 65,
};
const DEFAULT_PRIOR = 80;
/** 이 표본수 이상이어야 실증 중앙값 채택. 미만이면 상위 계층/프라이어로. */
export const MIN_N = 20;

/** 시세 ÷ 최저가 구간 경계. 최저가가 시세에 얼마나 못 미치는지에 따라 최저가 위로 얹히는 폭이 달라진다. */
const MARKET_EDGES = [1.0, 1.15, 1.3, 1.5, 1.8, 2.3];
const marketBucket = (marketOverMin: number): number => {
  const index = MARKET_EDGES.findIndex((edge) => marketOverMin < edge);
  return index === -1 ? MARKET_EDGES.length : index;
};
const marketBucketLabel = (bucket: number): string => (
  bucket === 0 ? `${MARKET_EDGES[0]!.toFixed(2)} 미만`
    : bucket === MARKET_EDGES.length ? `${MARKET_EDGES[bucket - 1]!.toFixed(2)} 이상`
      : `${MARKET_EDGES[bucket - 1]!.toFixed(2)}~${MARKET_EDGES[bucket]!.toFixed(2)}`
);

/** overMin = 낙찰가 ÷ 그 회차 최저가(1 이상). marketOverMin = 그 기일의 신뢰도 high 시세 ÷ 최저가(없으면 생략). */
export interface SaleRatioSample { propertyType: string; region: string; band: RoundBand; overMin: number; marketOverMin?: number }
export interface SaleRatioLookup {
  ratioPct: number; n: number; basis: string;
  tier: 'type_band_market' | 'type_market' | 'type_region_band' | 'type_band' | 'band' | 'prior';
}

export interface SaleRatioTable {
  /**
   * 이번 기일 최저가·감정가로 예상 낙찰가율(%)을 낸다. 최저가나 감정가를 모르면 프라이어.
   * highConfidenceMarket 에는 신뢰도 high 인 시세만 넘긴다 — 시세 구간 표본이 있는 종류(아파트)는 그 구간을 먼저 본다.
   */
  lookup(
    propertyType: string, address: string, minBidPrice: number | null | undefined, appraisalValue: number | null | undefined,
    highConfidenceMarket?: number | null,
  ): SaleRatioLookup;
  /** 집계 요약(로깅용) */
  summary(): { key: string; n: number; medianPct: number }[];
}

/** 순수함수: 최저가 대비 배율 표본 → 계층적 조회 테이블. */
export function buildSaleRatioTable(samples: SaleRatioSample[]): SaleRatioTable {
  // 배율은 만분율 정수로 담는다 — shared median 은 짝수 개수일 때 평균을 정수로 반올림한다(금액용 계약).
  const cells = new Map<string, number[]>();
  for (const s of samples) {
    if (!(s.overMin >= 1) || !s.propertyType) continue;
    const bp = Math.round(s.overMin * 10_000);
    const keys = [`${s.propertyType}|${s.region}|${s.band}`, `${s.propertyType}|${s.band}`, s.band];
    if (s.marketOverMin !== undefined && s.marketOverMin > 0) {
      const bucket = marketBucket(s.marketOverMin);
      keys.push(`${s.propertyType}|${s.band}|m${bucket}`, `${s.propertyType}|m${bucket}`);
    }
    for (const key of keys) {
      const arr = cells.get(key);
      if (arr) arr.push(bp); else cells.set(key, [bp]);
    }
  }

  return {
    lookup(propertyType, address, minBidPrice, appraisalValue, highConfidenceMarket) {
      const prior = TYPE_RATIO_PRIOR[propertyType] ?? DEFAULT_PRIOR;
      if (!minBidPrice || !appraisalValue || appraisalValue <= 0) {
        return { ratioPct: prior, n: 0, tier: 'prior', basis: `기본 낙찰가율 ${prior}%(최저가·감정가 미상 — 보수 프라이어)` };
      }
      const region = regionFromAddress(address);
      const band = roundBandFromMinBid(minBidPrice, appraisalValue);
      const label = BAND_LABEL[band];
      const levels: { key: string; tier: SaleRatioLookup['tier']; name: string }[] = [];
      if (highConfidenceMarket && highConfidenceMarket > 0) {
        const bucket = marketBucket(highConfidenceMarket / minBidPrice);
        const range = `시세÷최저가 ${marketBucketLabel(bucket)}`;
        levels.push(
          { key: `${propertyType}|${band}|m${bucket}`, tier: 'type_band_market', name: `${propertyType}×${label}×${range}` },
          { key: `${propertyType}|m${bucket}`, tier: 'type_market', name: `${propertyType}×${range}(회차통합)` },
        );
      }
      levels.push(
        { key: `${propertyType}|${region}|${band}`, tier: 'type_region_band', name: `${propertyType}×${region}×${label}` },
        { key: `${propertyType}|${band}`, tier: 'type_band', name: `${propertyType}×${label}(지역통합)` },
        { key: band, tier: 'band', name: `${label}(종류통합)` },
      );
      for (const level of levels) {
        const arr = cells.get(level.key);
        if (!arr || arr.length < MIN_N) continue;
        const overMin = median(arr)! / 10_000;
        return {
          ratioPct: (minBidPrice / appraisalValue) * overMin * 100,
          n: arr.length,
          tier: level.tier,
          basis: `실증 낙찰가 ${level.name} ${arr.length}건 중앙값 = 최저가×${overMin.toFixed(2)}, 감정가 대비`,
        };
      }
      return { ratioPct: prior, n: 0, tier: 'prior', basis: `기본 낙찰가율 ${prior}%(${label} 표본<${MIN_N} — 보수 프라이어)` };
    },
    summary() {
      return [...cells]
        .map(([key, arr]) => ({ key, n: arr.length, medianPct: Math.round(median(arr)! / 100) }))
        .sort((a, b) => b.n - a.n);
    },
  };
}

/** 낙찰 결과 한 건. min_bid_price 는 그 회차의 실제 최저가, market_price 는 그 기일의 신뢰도 high 시세(아파트만, 없으면 null). */
export interface SaleRatioRow {
  sale_date: string; property_type: string; address: string; sale_ratio: number; min_bid_price: number; appraisal_value: number;
  expected_bid: number | null; market_price: number | null;
}

export function toSample(x: SaleRatioRow): SaleRatioSample {
  return {
    propertyType: x.property_type,
    region: regionFromAddress(x.address),
    band: roundBandFromMinBid(x.min_bid_price, x.appraisal_value),
    overMin: (x.sale_ratio * x.appraisal_value) / x.min_bid_price,
    marketOverMin: x.market_price ? x.market_price / x.min_bid_price : undefined,
  };
}

interface OutcomeRow extends Omit<SaleRatioRow, 'market_price'> {
  area_m2: number | null; lot_no: string | null; building_name: string | null; legal_dong: string | null;
}

const DAY_MS = 86_400_000;
/** 실거래 신고 기한(일). 기일 전 이 기간 안에 체결된 거래는 그날 아직 신고되지 않았을 수 있어 보지 않는다. */
const REPORT_LAG_DAYS = 30;
const TRADE_WINDOW_DAYS = 365;
const daysBefore = (date: string, days: number): string => new Date(Date.parse(date) - days * DAY_MS).toISOString().slice(0, 10);

/**
 * 아파트 낙찰 표본에 그 기일의 시세를 붙인다 — 운영과 같은 함수(estimateMarketPrice·capMarketPrice)로,
 * 기일 30일 전까지 1년 동안 체결된 실거래만 써서 다시 계산하고 신뢰도 high 만 남긴다.
 * high 는 같은 동·같은 건물 단계에서만 나오므로 표본이 있는 동의 거래만 읽는다.
 */
async function apartmentMarketAtSale(rows: OutcomeRow[]): Promise<Map<OutcomeRow, number>> {
  const targets = rows.flatMap((row) => {
    const lawdCd = row.property_type === 'apartment' ? addressToLawdCd(row.address) : undefined;
    const dong = row.legal_dong ?? extractDong(row.address);
    return lawdCd && dong ? [{ row, dong, place: `${lawdCd}|${dong}` }] : [];
  });
  const places = [...new Set(targets.map((target) => target.place))].map((place) => place.split('|') as [string, string]);
  const cells = await query<{ place: string; items: MolitItem[] }>(
    `select k.lawd_cd || '|' || k.dong as place, jsonb_agg(it) as items
       from gm_molit_cache c
      cross join lateral jsonb_array_elements(c.items) it
       join unnest($1::text[], $2::text[]) as k(lawd_cd, dong) on k.lawd_cd = c.lawd_cd and k.dong = trim(it->>'umdNm')
      where c.ep = 'RTMSDataSvcAptTrade'
      group by k.lawd_cd, k.dong`,
    [places.map((place) => place[0]), places.map((place) => place[1])],
  );
  const trades = new Map<string, Comparable[]>(cells.map((cell) => [cell.place, parseMolitJson(cell.items)]));

  const markets = new Map<OutcomeRow, number>();
  for (const { row, dong, place } of targets) {
    const from = daysBefore(row.sale_date, TRADE_WINDOW_DAYS);
    const to = daysBefore(row.sale_date, REPORT_LAG_DAYS);
    const visible = (trades.get(place) ?? []).filter((trade) => trade.dealDate >= from && trade.dealDate <= to);
    const estimate = estimateMarketPrice(visible, {
      areaM2: row.area_m2 ?? undefined,
      dong,
      buildingName: row.building_name ?? extractBuildingName(row.address),
      jibun: row.lot_no ?? extractLotNumber(row.address),
      propertyType: row.property_type,
    });
    const capped = capMarketPrice(estimate.marketPrice, estimate.confidence, row.appraisal_value, row.property_type);
    if (capped.marketPrice && capped.confidence === 'high') markets.set(row, capped.marketPrice);
  }
  return markets;
}

/** 신뢰 낙찰결과(오늘 전 매각)를 매각일 순으로 읽는다. 건물 식별값은 법원 원자료에만 있어 같은 물건이면 법원 행을 먼저 고른다. */
export async function loadSaleRatioRows(): Promise<SaleRatioRow[]> {
  const rows = await query<OutcomeRow>(
    `select e.sale_date::text as sale_date, e.property_type, e.address, e.sale_ratio::float8 as sale_ratio,
            coalesce(e.result_min_price, e.min_bid_price)::float8 as min_bid_price,
            e.appraisal_value::float8 as appraisal_value, e.expected_bid::float8 as expected_bid,
            l.area_m2::float8 as area_m2, l.lot_no, l.building_name, l.legal_dong
       from gm_trusted_outcome_eval e
       left join lateral (
         select area_m2, ${PARCEL_COLUMNS}
           from gm_listings
          where court = e.court and case_no = e.case_no and item_no = coalesce(nullif(e.item_no, ''), '1')
          order by (source = 'courtauction') desc, crawled_at desc nulls last, id desc
          limit 1
       ) l on e.property_type = 'apartment'
      where e.sold and e.sale_ratio > 0 and e.appraisal_value > 0 and e.property_type is not null
        and coalesce(e.result_min_price, e.min_bid_price) > 0
        and e.sale_date < current_date
      order by e.sale_date`,
  );
  const markets = await apartmentMarketAtSale(rows);
  return rows.map((row) => ({
    sale_date: row.sale_date, property_type: row.property_type, address: row.address, sale_ratio: row.sale_ratio,
    min_bid_price: row.min_bid_price, appraisal_value: row.appraisal_value, expected_bid: row.expected_bid,
    market_price: markets.get(row) ?? null,
  }));
}

export async function loadSaleRatioTable(): Promise<SaleRatioTable> {
  return buildSaleRatioTable((await loadSaleRatioRows()).map(toSample));
}
