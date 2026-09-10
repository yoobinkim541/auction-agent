/**
 * 실증 낙찰가율 테이블 — 신뢰 낙찰결과(gm_trusted_outcome_eval, 이상치 격리됨)로 낙찰가율(낙찰가/감정가)을
 *   종류×지역×회차밴드로 집계해 예상낙찰가(expectedBid)의 폴백 근거로 쓴다. 동일건물/인근 실거래
 *   낙찰사례가 없는 물건(전체의 ~94%)이 최저가 폴백으로 '가짜 안전마진'을 얻던 문제를 실측 근거로 대체.
 *
 * 회차밴드가 낙찰가율의 최대 신호(median: 신건 0.84 → 1회 0.72 → 2회 0.59 → 3회+ 0.40).
 *   최저가/감정가 비율로 스냅샷 시점 회차를 근사한다(법원별 저감률 차이까지 흡수).
 *
 * 계층적 조회(표본 부족 붕괴 방지) — 회차밴드를 지역보다 우선 유지:
 *   1) 종류×지역×밴드 → 2) 종류×밴드(지역통합) → 3) 종류×지역(회차통합) → 4) 종류 → 5) 보수적 프라이어.
 * 프라이어는 통념 수도권 낙찰가율을 '높게' 잡는다 — 낙찰가율을 높게 추정하면 예상낙찰가↑ → 마진↓ →
 *   표본 부족 종류를 과대추천하지 않는 안전한 방향으로 치우친다.
 */
import { median } from '../../shared/stats.ts';

/** 주소 → 지역(수도권 3분). 앞자리 앵커로 '경기도 광주시'의 '광주' 오분류 방지. */
export function regionFromAddress(address: string): string {
  const a = (address ?? '').trim();
  if (/^서울/.test(a)) return '서울';
  if (/^인천/.test(a)) return '인천';
  if (/^경기/.test(a)) return '경기';
  return '기타';
}

export type RoundBand = 'r1' | 'r2' | 'r3' | 'r4';
const BAND_LABEL: Record<RoundBand, string> = { r1: '신건', r2: '1회유찰', r3: '2회유찰', r4: '3회+유찰' };

/** 최저가/감정가 비율 → 회차밴드 근사. 법원 저감률(20~30%/회) 기준 경계. */
export function roundBandFromMinBid(minBidPrice: number | null | undefined, appraisalValue: number | null | undefined): RoundBand {
  if (!minBidPrice || !appraisalValue || appraisalValue <= 0) return 'r1'; // 정보 없으면 보수적으로 신건(높은 낙찰가율 프라이어)
  const ratio = minBidPrice / appraisalValue;
  if (ratio >= 0.95) return 'r1';
  if (ratio >= 0.72) return 'r2';
  if (ratio >= 0.55) return 'r3';
  return 'r4';
}

/** 표본 부족 시 보수적 프라이어(%) — 통념 수도권 낙찰가율. 높게 잡아 과대추천 방지. */
export const TYPE_RATIO_PRIOR: Record<string, number> = {
  apartment: 88, officetel: 80, villa: 70, house: 75, land: 65,
};
const DEFAULT_PRIOR = 80;
/** 이 표본수 이상이어야 실증 중앙값 채택. 미만이면 상위 계층/프라이어로. */
export const MIN_N = 20;

export interface SaleRatioSample { propertyType: string; region: string; band: RoundBand; ratioPct: number }
export interface SaleRatioLookup { ratioPct: number; n: number; basis: string; tier: 'type_region_band' | 'type_band' | 'type_region' | 'type' | 'prior' }

export interface SaleRatioTable {
  lookup(propertyType: string, address: string, band: RoundBand): SaleRatioLookup;
  /** 집계 요약(로깅용) */
  summary(): { key: string; n: number; medianPct: number }[];
}

function push(map: Map<string, number[]>, key: string, v: number): void {
  const arr = map.get(key);
  if (arr) arr.push(v); else map.set(key, [v]);
}

/** 순수함수: 낙찰가율 표본 → 계층적 조회 테이블. */
export function buildSaleRatioTable(samples: SaleRatioSample[]): SaleRatioTable {
  const byTypeRegionBand = new Map<string, number[]>();
  const byTypeBand = new Map<string, number[]>();
  const byTypeRegion = new Map<string, number[]>();
  const byType = new Map<string, number[]>();
  for (const s of samples) {
    if (!(s.ratioPct > 0) || !s.propertyType) continue;
    push(byTypeRegionBand, `${s.propertyType}|${s.region}|${s.band}`, s.ratioPct);
    push(byTypeBand, `${s.propertyType}|${s.band}`, s.ratioPct);
    push(byTypeRegion, `${s.propertyType}|${s.region}`, s.ratioPct);
    push(byType, s.propertyType, s.ratioPct);
  }
  const med = (arr: number[] | undefined): number | null => (arr && arr.length ? median(arr) : null);

  return {
    lookup(propertyType, address, band) {
      const region = regionFromAddress(address);
      const bl = BAND_LABEL[band];
      const trb = byTypeRegionBand.get(`${propertyType}|${region}|${band}`);
      if (trb && trb.length >= MIN_N) {
        return { ratioPct: Math.round(med(trb)!), n: trb.length, tier: 'type_region_band', basis: `실증 낙찰가율 ${propertyType}×${region}×${bl} ${trb.length}건 중앙값` };
      }
      const tb = byTypeBand.get(`${propertyType}|${band}`);
      if (tb && tb.length >= MIN_N) {
        return { ratioPct: Math.round(med(tb)!), n: tb.length, tier: 'type_band', basis: `실증 낙찰가율 ${propertyType}×${bl} ${tb.length}건(지역통합) 중앙값` };
      }
      const tr = byTypeRegion.get(`${propertyType}|${region}`);
      if (tr && tr.length >= MIN_N) {
        return { ratioPct: Math.round(med(tr)!), n: tr.length, tier: 'type_region', basis: `실증 낙찰가율 ${propertyType}×${region} ${tr.length}건(회차통합) 중앙값` };
      }
      const t = byType.get(propertyType);
      if (t && t.length >= MIN_N) {
        return { ratioPct: Math.round(med(t)!), n: t.length, tier: 'type', basis: `실증 낙찰가율 ${propertyType} ${t.length}건(지역·회차통합) 중앙값` };
      }
      const prior = TYPE_RATIO_PRIOR[propertyType] ?? DEFAULT_PRIOR;
      return { ratioPct: prior, n: t?.length ?? 0, tier: 'prior', basis: `기본 낙찰가율 ${prior}%(${propertyType} 표본 ${t?.length ?? 0}건<${MIN_N} — 보수 프라이어)` };
    },
    summary() {
      const out: { key: string; n: number; medianPct: number }[] = [];
      for (const [key, arr] of [...byTypeRegionBand, ...byTypeBand, ...byTypeRegion, ...byType]) {
        out.push({ key, n: arr.length, medianPct: Math.round(med(arr)!) });
      }
      return out.sort((a, b) => b.n - a.n);
    },
  };
}

interface SaleRatioRow { property_type: string; address: string; sale_ratio: number; min_bid_price: number | null; appraisal_value: number }

/** DB에서 신뢰 낙찰결과를 읽어 테이블 구성. query = shared/db.ts의 query 함수(rows 배열 반환).
 *  since = 이 날짜 이후 매각만(백테스트 시간분할용, 미지정 시 전체). */
export async function loadSaleRatioTable(
  query: (sql: string, params?: unknown[]) => Promise<SaleRatioRow[]>,
  opts: { before?: string } = {},
): Promise<SaleRatioTable> {
  const rows = await query(
    `select property_type, address, sale_ratio, min_bid_price, appraisal_value
       from gm_trusted_outcome_eval
      where sold and sale_ratio is not null and sale_ratio > 0
        and appraisal_value > 0 and property_type is not null
        and sale_date < ${opts.before ? '$1::date' : 'current_date'}`,
    opts.before ? [opts.before] : [],
  );
  const samples: SaleRatioSample[] = rows.map((x) => ({
    propertyType: x.property_type,
    region: regionFromAddress(x.address),
    band: roundBandFromMinBid(x.min_bid_price, x.appraisal_value),
    ratioPct: x.sale_ratio * 100,
  }));
  return buildSaleRatioTable(samples);
}
