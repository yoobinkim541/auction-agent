/**
 * 낙찰가 예측(comps) — 수집된 실제 낙찰결과(gm_auction_results)로 유사매물(같은 시군구·유형)의
 * 낙찰가율 분포를 잡아 "예상 낙찰가 밴드"를 만든다. 입찰가 산정용 과거사례 조사 발품 대체.
 *   - 순수부(통계·포맷)는 테스트, DB 조회는 fetchRegionComps로 분리.
 *   - 표본 3건 미만이면 밴드를 내지 않는다(허위 정밀도 방지). 시군구 표본 부족 시 시/도로 확대.
 */
import { query } from '../../shared/db.ts';
import { eok } from '../../shared/format.ts';

export interface CompSale {
  caseNo: string;
  address: string;
  date: string;        // 기일(YYYY-MM-DD)
  soldAmount: number;  // 낙찰가
  appraisal: number;   // 감정가
}

export interface CompsStats {
  n: number;
  medianRatio: number; // 낙찰가/감정가 중앙값
  p25: number;
  p75: number;
}

/** 주소 → 시군구 키('서울특별시 성북구'). 두 번째 토큰이 없으면 첫 토큰(시/도)만. */
export function regionKey(address: string): string {
  const t = address.trim().split(/\s+/);
  return t.slice(0, Math.min(2, t.length)).join(' ');
}

/** 시/도 키(광역 fallback용). */
export function sidoKey(address: string): string {
  return address.trim().split(/\s+/)[0] ?? '';
}

/** 낙찰가율 분포 요약 — 표본 3건 미만이면 null(밴드 무의미). */
export function compsStats(sales: { soldAmount: number; appraisal: number }[]): CompsStats | null {
  const ratios = sales
    .filter((s) => s.appraisal > 0 && s.soldAmount > 0)
    .map((s) => s.soldAmount / s.appraisal)
    .sort((a, b) => a - b);
  if (ratios.length < 3) return null;
  const q = (p: number): number => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))]!;
  return { n: ratios.length, medianRatio: q(0.5), p25: q(0.25), p75: q(0.75) };
}

/** 다이제스트/리포트용 한 줄 — "예상낙찰 2.1~2.4억 (유사 14건 · 낙찰가율 중앙 64%)". */
export function bandLine(appraisal: number | null | undefined, stats: CompsStats | null): string | null {
  if (!appraisal || !stats) return null;
  return `예상낙찰 ${eok(appraisal * stats.p25)}~${eok(appraisal * stats.p75)} (유사 ${stats.n}건 · 낙찰가율 중앙 ${Math.round(stats.medianRatio * 100)}%)`;
}

/**
 * 입찰가 가이드(승률) — 유사 낙찰가율 분포의 분위수로 "이 가격이면 과거 낙찰가의 q%를 이겼다"를 제시.
 * 표본 5건 미만이면 null(분위수 신뢰 불가). 예: "입찰가 가이드: 승률50% 1.92억 · 70% 2.10억 · 90% 2.40억".
 */
export function winRateGuide(appraisal: number | null | undefined, sales: { soldAmount: number; appraisal: number }[]): string | null {
  if (!appraisal) return null;
  const ratios = sales
    .filter((s) => s.appraisal > 0 && s.soldAmount > 0)
    .map((s) => s.soldAmount / s.appraisal)
    .sort((a, b) => a - b);
  if (ratios.length < 5) return null;
  const q = (p: number): number => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))]!;
  const at = (p: number): string => eok(appraisal * q(p));
  return `입찰가 가이드(승률): 50% ${at(0.5)} · 70% ${at(0.7)} · 90% ${at(0.9)} — 유사 ${ratios.length}건 낙찰가 분포 기준`;
}

/** 상세 리포트용 "유사 낙찰 사례" 라인들(최근순 최대 max건). */
export function recentSalesLines(sales: CompSale[], max = 3): string[] {
  return sales.slice(0, max).map(
    (s) => `${s.date} ${s.address.slice(0, 20)} → 낙찰 ${eok(s.soldAmount)} (감정가 대비 ${Math.round((s.soldAmount / s.appraisal) * 100)}%)`,
  );
}

/** 지역 프리픽스+유형의 최근 낙찰 사례 조회(최근순). 사건별 최신 매물행과 조인. */
export async function fetchRegionComps(propertyType: string, regionPrefix: string, days = 270, limit = 40): Promise<CompSale[]> {
  const rows = await query<{ case_no: string; address: string; date: string; sold_amount: number; appraisal: number }>(
    `select r.case_no, l.address, r.dxdy_date::text as date,
            r.sold_amount::float8 as sold_amount, l.appraisal_value::float8 as appraisal
       from gm_auction_results r
       join (select distinct on (case_no, coalesce(item_no,'1'))
                    case_no, coalesce(item_no,'1') item_no, address, property_type, appraisal_value
               from gm_listings order by case_no, coalesce(item_no,'1'), crawled_at desc nulls last) l
         on l.case_no = r.case_no and l.item_no = r.item_no
      where r.sold and r.sold_amount > 0 and l.appraisal_value > 0
        and l.property_type = $1 and l.address like $2 || '%'
        and r.dxdy_date >= current_date - $3::int
      order by r.dxdy_date desc
      limit $4`,
    [propertyType, regionPrefix, days, limit],
  );
  return rows.map((r) => ({ caseNo: r.case_no, address: r.address, date: r.date, soldAmount: r.sold_amount, appraisal: r.appraisal }));
}

/** 시군구 표본 부족(<3) 시 시/도로 확대 조회. (지역, 사례) 반환 — 라벨 표기용 지역도 함께. */
export async function fetchCompsWithFallback(propertyType: string, address: string): Promise<{ region: string; sales: CompSale[] }> {
  const gu = regionKey(address);
  let sales = await fetchRegionComps(propertyType, gu);
  if (compsStats(sales)) return { region: gu, sales };
  const sido = sidoKey(address);
  if (sido && sido !== gu) sales = await fetchRegionComps(propertyType, sido);
  return { region: sido || gu, sales };
}
