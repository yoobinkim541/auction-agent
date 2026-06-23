/**
 * 매물 목록 필터/정렬 — App.tsx의 view useMemo에서 추출한 순수 로직(단위 테스트 대상).
 * App 상태를 FilterState로 받아 통과여부와 무관한 조건필터 + 토글필터를 적용하고 정렬한다.
 */
import type { ListingItem } from './api.ts';
import type { ClientScore, ScoreConfig } from './scoring.ts';

export type SortKey = 'score' | 'safety' | 'trueSafety' | 'sale' | 'price' | 'appraisal' | 'assumed' | 'gap' | 'fieldwork';

export interface ScoredRow { item: ListingItem; sc: ClientScore }

export interface FilterState {
  cfg: ScoreConfig;
  hideExpired: boolean;
  hideIncomplete: boolean;
  onlyPassed: boolean;
  onlyFavorite: boolean;
  onlyZeroPi: boolean;
  onlyConsider: boolean;
  onlyPassedAvoid: boolean;
  onlyToday: boolean;
  filterDate: string | null; // '' 또는 null = 없음
  onlyUrgent: boolean;
  maxGapEok: number; // 0 = 무제한
  onlyMultiRound: boolean;
  type: string; // 'all' = 전체
  q: string;
  today: string; // YYYY-MM-DD
}

/** 발품 진행도 정렬 순위(완료는 맨 뒤, 진행중 우선). desc 정렬 기준: 높을수록 앞에. */
export function fieldworkRank(r: ListingItem): number {
  const total = r.field_total ?? 0;
  const done = r.field_done ?? 0;
  const notes = r.field_notes ?? 0;
  if (total > 0 && done >= total) return 0; // 완료 → 맨 뒤(0=최저순위)
  if (done > 0) return 1000 + done; // 진행중
  if (notes > 0) return 500 + notes; // 메모만
  return 1; // 미시작 → 완료보다 앞(desc 기준 rank 0 < 1)
}

/** 조건필터(지역·가격대) + 토글필터 적용. 순수(입력 배열 비변경). */
export function applyListingFilters(rows: ScoredRow[], f: FilterState): ScoredRow[] {
  let v = rows;
  if (f.cfg.regionKeywords.length) v = v.filter((x) => f.cfg.regionKeywords.some((k) => x.item.address.includes(k)));
  if (f.cfg.priceMinEok > 0) v = v.filter((x) => (x.item.min_bid_price ?? 0) >= f.cfg.priceMinEok * 1e8);
  if (f.cfg.priceMaxEok > 0) v = v.filter((x) => (x.item.min_bid_price ?? 0) <= f.cfg.priceMaxEok * 1e8);
  if (f.cfg.apprMinEok > 0) v = v.filter((x) => (x.item.appraisal_value ?? 0) >= f.cfg.apprMinEok * 1e8);
  if (f.cfg.apprMaxEok > 0) v = v.filter((x) => (x.item.appraisal_value ?? 0) <= f.cfg.apprMaxEok * 1e8);
  if (f.hideExpired) v = v.filter((x) => !x.item.sale_date || x.item.sale_date >= f.today);
  if (f.hideIncomplete) v = v.filter((x) => !x.item.location?.report?.headline?.startsWith('[데이터 불완전]'));
  if (f.onlyPassed) v = v.filter((x) => x.sc.passed);
  if (f.onlyFavorite) v = v.filter((x) => x.item.is_favorite);
  if (f.onlyZeroPi) v = v.filter((x) => x.item.location?.income?.zeroPiCandidate === true);
  if (f.onlyConsider) v = v.filter((x) => x.item.location?.report?.recommendation === 'consider');
  if (f.onlyPassedAvoid) v = v.filter((x) => x.sc.passed && x.item.location?.report?.recommendation === 'avoid');
  if (f.onlyToday) v = v.filter((x) => x.item.sale_date === f.today);
  if (f.filterDate) v = v.filter((x) => x.item.sale_date === f.filterDate);
  if (f.onlyUrgent) {
    const sevenDaysStr = new Date(new Date(f.today).getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    v = v.filter((x) => x.item.sale_date && x.item.sale_date >= f.today && x.item.sale_date <= sevenDaysStr);
  }
  if (f.maxGapEok > 0) v = v.filter((x) => {
    const gap = x.item.location?.income?.gapInvestment;
    return gap == null || gap <= f.maxGapEok * 1e8;
  });
  if (f.onlyMultiRound) v = v.filter((x) => {
    const rs = x.item.location?.sale_rounds ?? [];
    const rnd = rs.find((s) => s.date === x.item.sale_date)?.round ?? (rs.length > 0 ? rs[rs.length - 1]!.round : null);
    return (rnd != null && rnd >= 2) || (rs.length === 0 && (x.item.fail_count ?? 0) >= 1);
  });
  if (f.type !== 'all') v = v.filter((x) => x.item.property_type === f.type);
  if (f.q.trim()) {
    const qt = f.q.trim();
    v = v.filter((x) => x.item.address.includes(qt) || x.item.case_no.includes(qt) || (x.item.court ?? '').includes(qt));
  }
  return v;
}

/** 정렬(새 배열 반환 — 입력 비변경). */
export function sortRows(rows: ScoredRow[], sort: SortKey, sortDir: 'asc' | 'desc'): ScoredRow[] {
  const v = [...rows];
  v.sort((a, b) => {
    let diff = 0;
    if (sort === 'safety') diff = (a.item.location?.safety_margin ?? -1) - (b.item.location?.safety_margin ?? -1);
    else if (sort === 'sale') diff = (a.item.sale_date ?? '9999').localeCompare(b.item.sale_date ?? '9999');
    else if (sort === 'trueSafety') diff = (a.item.location?.acquisition_cost?.trueSafetyMargin ?? -1) - (b.item.location?.acquisition_cost?.trueSafetyMargin ?? -1);
    else if (sort === 'price') diff = (a.item.min_bid_price ?? Infinity) - (b.item.min_bid_price ?? Infinity);
    else if (sort === 'appraisal') diff = (a.item.appraisal_value ?? 0) - (b.item.appraisal_value ?? 0);
    else if (sort === 'assumed') diff = (a.item.rights?.assumed_amount ?? 0) - (b.item.rights?.assumed_amount ?? 0);
    else if (sort === 'gap') {
      const ga = a.item.location?.income?.gapInvestment ?? Infinity;
      const gb = b.item.location?.income?.gapInvestment ?? Infinity;
      diff = ga - gb;
    } else if (sort === 'fieldwork') diff = fieldworkRank(a.item) - fieldworkRank(b.item);
    else diff = a.sc.totalScore - b.sc.totalScore;
    return sortDir === 'asc' ? diff : -diff;
  });
  return v;
}
