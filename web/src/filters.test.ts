import { describe, it, expect } from 'vitest';
import { applyListingFilters, sortRows, fieldworkRank, groupRowsByCase, type FilterState, type ScoredRow } from './filters.ts';
import { DEFAULT_CONFIG } from './scoring.ts';
import type { ListingItem } from './api.ts';

const row = (item: Record<string, unknown>, passed = true, totalScore = 50, competitionScore: number | null = null): ScoredRow =>
  ({ item: item as unknown as ListingItem, sc: { passed, totalScore, safetyScore: 0, cleanScore: 0, competitionScore, reasons: [] } });

const A = row({ address: '서울 강남구', property_type: 'apartment', min_bid_price: 3e8, case_no: '2024-1', court: '서울중앙' }, true, 80);
const B = row({ address: '부산 해운대구', property_type: 'villa', min_bid_price: 1e8, case_no: '2024-2', court: '부산' }, false, 40);
const C = row({ address: '서울 마포구', property_type: 'apartment', min_bid_price: 5e8, case_no: '2024-3', court: '서울서부' }, true, 60);
const rows = [A, B, C];

const base = (over: Partial<FilterState> = {}): FilterState => ({
  cfg: { ...DEFAULT_CONFIG, regionKeywords: [] },
  hideExpired: false, hideIncomplete: false, onlyPassed: false, onlyFavorite: false, onlyZeroPi: false,
  onlyConsider: false, onlyPassedAvoid: false, onlyToday: false, filterDate: '', onlyUrgent: false,
  maxGapEok: 0, onlyMultiRound: false, type: 'all', q: '', today: '2026-06-22', ...over,
});

describe('applyListingFilters', () => {
  it('필터 없음 → 전부 통과', () => {
    expect(applyListingFilters(rows, base())).toHaveLength(3);
  });
  it('지역 키워드(서울)', () => {
    const r = applyListingFilters(rows, base({ cfg: { ...DEFAULT_CONFIG, regionKeywords: ['서울'] } }));
    expect(r.map((x) => x.item.case_no)).toEqual(['2024-1', '2024-3']);
  });
  it('가격 하한(≥2억)', () => {
    const r = applyListingFilters(rows, base({ cfg: { ...DEFAULT_CONFIG, regionKeywords: [], priceMinEok: 2 } }));
    expect(r.map((x) => x.item.case_no)).toEqual(['2024-1', '2024-3']);
  });
  it('통과만(sc.passed)', () => {
    expect(applyListingFilters(rows, base({ onlyPassed: true })).map((x) => x.item.case_no)).toEqual(['2024-1', '2024-3']);
  });
  it('물건종류(villa)', () => {
    expect(applyListingFilters(rows, base({ type: 'villa' })).map((x) => x.item.case_no)).toEqual(['2024-2']);
  });
  it('검색어(주소/사건번호/법원)', () => {
    expect(applyListingFilters(rows, base({ q: '마포' }))).toHaveLength(1);
    expect(applyListingFilters(rows, base({ q: '부산' }))[0]!.item.case_no).toBe('2024-2'); // 법원 매칭
  });
  it('다회차(round≥2 또는 fail_count≥1)', () => {
    const r2 = row({ address: '서울', property_type: 'apartment', case_no: 'm2', sale_date: '2026-06-22', location: { sale_rounds: [{ date: '2026-06-22', round: 2 }] } });
    const r1 = row({ address: '서울', property_type: 'apartment', case_no: 'm1', sale_date: '2026-06-22', location: { sale_rounds: [{ date: '2026-06-22', round: 1 }] }, fail_count: 0 });
    const out = applyListingFilters([r1, r2], base({ onlyMultiRound: true }));
    expect(out.map((x) => x.item.case_no)).toEqual(['m2']);
  });
  it('갭 상한(gapInvestment ≤ N억, null은 통과)', () => {
    const lo = row({ address: '서울', property_type: 'apartment', case_no: 'g-lo', location: { income: { gapInvestment: 5e7 } } });
    const hi = row({ address: '서울', property_type: 'apartment', case_no: 'g-hi', location: { income: { gapInvestment: 2e8 } } });
    const nul = row({ address: '서울', property_type: 'apartment', case_no: 'g-null', location: { income: {} } });
    expect(applyListingFilters([lo, hi, nul], base({ maxGapEok: 1 })).map((x) => x.item.case_no)).toEqual(['g-lo', 'g-null']);
  });
  it('입력 배열 비변경(순수)', () => {
    const snapshot = [...rows];
    applyListingFilters(rows, base({ onlyPassed: true }));
    expect(rows).toEqual(snapshot);
  });
});

describe('sortRows', () => {
  it('기본 score 내림차순', () => {
    expect(sortRows(rows, 'score', 'desc').map((x) => x.item.case_no)).toEqual(['2024-1', '2024-3', '2024-2']);
  });
  it('가격 오름차순', () => {
    expect(sortRows(rows, 'price', 'asc').map((x) => x.item.case_no)).toEqual(['2024-2', '2024-1', '2024-3']);
  });
  it('입력 배열 비변경', () => {
    const snapshot = [...rows];
    sortRows(rows, 'price', 'asc');
    expect(rows).toEqual(snapshot);
  });
  it('경쟁도순(desc) — 저경쟁(점수↑) 먼저, 신호없음(null)은 뒤', () => {
    const hi = row({ case_no: 'comp-hi' }, true, 50, 90); // 저경쟁
    const lo = row({ case_no: 'comp-lo' }, true, 50, 20); // 고경쟁
    const nul = row({ case_no: 'comp-null' }, true, 50, null);
    expect(sortRows([lo, nul, hi], 'competition', 'desc').map((x) => x.item.case_no)).toEqual(['comp-hi', 'comp-lo', 'comp-null']);
  });
});

describe('groupRowsByCase', () => {
  it('사건별 묶음 + 정렬순서(최상위 멤버 위치) 보존', () => {
    const a1 = row({ case_no: 'A', address: '서울' });
    const b1 = row({ case_no: 'B', address: '서울' });
    const a2 = row({ case_no: 'A', address: '서울' });
    const g = groupRowsByCase([a1, b1, a2]);
    expect(g.map((x) => x.caseNo)).toEqual(['A', 'B']); // A가 먼저 등장
    expect(g[0]!.rows).toHaveLength(2); // A 물건 2개
    expect(g[1]!.rows).toHaveLength(1);
  });
});

describe('fieldworkRank', () => {
  it('완료=0(맨뒤), 진행중>메모>미시작>완료', () => {
    expect(fieldworkRank({ field_total: 5, field_done: 5 } as unknown as ListingItem)).toBe(0); // 완료 → 맨뒤(최저)
    expect(fieldworkRank({ field_done: 3 } as unknown as ListingItem)).toBe(1003);
    expect(fieldworkRank({ field_notes: 2 } as unknown as ListingItem)).toBe(502);
    expect(fieldworkRank({} as unknown as ListingItem)).toBe(1); // 미시작 → 완료보다 앞
  });
});
