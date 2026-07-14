/**
 * 실증 낙찰가율 테이블 — 우리 낙찰결과(gm_auction_results)로 종류×지역별 낙찰가율(낙찰가/감정가)을
 *   집계해 예상낙찰가(expectedBid)의 폴백 근거로 쓴다. 동일건물/인근 실거래 낙찰사례가 없는 물건
 *   (전체의 ~94%)이 최저가 폴백으로 '가짜 안전마진'을 얻던 문제를 실측 근거로 대체.
 *
 * 계층적 조회(표본 부족 붕괴 방지):
 *   1) 종류×지역 (표본 ≥ MIN_N) → 2) 종류(지역통합, ≥ MIN_N) → 3) 보수적 프라이어(표본부족).
 * 프라이어는 통념 수도권 낙찰가율을 '높게' 잡는다 — 낙찰가율을 높게 추정하면 예상낙찰가↑ → 마진↓ →
 *   표본 부족 종류(현재 아파트·오피스텔)를 과대추천하지 않는 안전한 방향으로 치우친다.
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

/** 표본 부족 시 보수적 프라이어(%) — 통념 수도권 낙찰가율. 높게 잡아 과대추천 방지. */
export const TYPE_RATIO_PRIOR: Record<string, number> = {
  apartment: 88, officetel: 80, villa: 70, house: 75, land: 65,
};
const DEFAULT_PRIOR = 80;
/** 이 표본수 이상이어야 실증 중앙값 채택. 미만이면 상위 계층/프라이어로. */
export const MIN_N = 20;

export interface SaleRatioSample { propertyType: string; region: string; ratioPct: number }
export interface SaleRatioLookup { ratioPct: number; n: number; basis: string; tier: 'type_region' | 'type' | 'prior' }

export interface SaleRatioTable {
  lookup(propertyType: string, address: string): SaleRatioLookup;
  /** 집계 요약(로깅용) */
  summary(): { key: string; n: number; medianPct: number }[];
}

function push(map: Map<string, number[]>, key: string, v: number): void {
  const arr = map.get(key);
  if (arr) arr.push(v); else map.set(key, [v]);
}

/** 순수함수: 낙찰가율 표본 → 계층적 조회 테이블. */
export function buildSaleRatioTable(samples: SaleRatioSample[]): SaleRatioTable {
  const byTypeRegion = new Map<string, number[]>();
  const byType = new Map<string, number[]>();
  for (const s of samples) {
    if (!(s.ratioPct > 0) || !s.propertyType) continue;
    push(byTypeRegion, `${s.propertyType}|${s.region}`, s.ratioPct);
    push(byType, s.propertyType, s.ratioPct);
  }
  const med = (arr: number[] | undefined): number | null => (arr && arr.length ? median(arr) : null);

  return {
    lookup(propertyType, address) {
      const region = regionFromAddress(address);
      const tr = byTypeRegion.get(`${propertyType}|${region}`);
      if (tr && tr.length >= MIN_N) {
        return { ratioPct: Math.round(med(tr)!), n: tr.length, tier: 'type_region', basis: `실증 낙찰가율 ${propertyType}×${region} ${tr.length}건 중앙값` };
      }
      const t = byType.get(propertyType);
      if (t && t.length >= MIN_N) {
        return { ratioPct: Math.round(med(t)!), n: t.length, tier: 'type', basis: `실증 낙찰가율 ${propertyType} ${t.length}건(지역통합) 중앙값` };
      }
      const prior = TYPE_RATIO_PRIOR[propertyType] ?? DEFAULT_PRIOR;
      return { ratioPct: prior, n: t?.length ?? 0, tier: 'prior', basis: `기본 낙찰가율 ${prior}%(${propertyType} 표본 ${t?.length ?? 0}건<${MIN_N} — 보수 프라이어)` };
    },
    summary() {
      const out: { key: string; n: number; medianPct: number }[] = [];
      for (const [key, arr] of [...byTypeRegion, ...byType]) out.push({ key, n: arr.length, medianPct: Math.round(med(arr)!) });
      return out.sort((a, b) => b.n - a.n);
    },
  };
}

interface SaleRatioRow { property_type: string; address: string; ratio: number }

/** DB에서 낙찰결과⋈감정가/종류를 읽어 테이블 구성. query = shared/db.ts의 query 함수(rows 배열 반환). */
export async function loadSaleRatioTable(
  query: (sql: string, params?: unknown[]) => Promise<SaleRatioRow[]>,
): Promise<SaleRatioTable> {
  const rows = await query(
    `select l.property_type, l.address, (r.sold_amount::float / l.appraisal_value) as ratio
       from gm_auction_results r
       join lateral (
         select property_type, address, appraisal_value from gm_listings gl
         where gl.case_no = r.case_no and coalesce(gl.item_no,'1') = r.item_no
         order by crawled_at desc limit 1
       ) l on true
      where r.sold and r.sold_amount > 0 and l.appraisal_value > 0 and l.property_type is not null`,
  );
  const samples: SaleRatioSample[] = rows.map((x) => ({
    propertyType: x.property_type, region: regionFromAddress(x.address), ratioPct: x.ratio * 100,
  }));
  return buildSaleRatioTable(samples);
}
