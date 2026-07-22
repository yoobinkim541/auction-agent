import { describe, expect, it } from 'vitest';
import type { ListingItem } from './api.ts';
import type { ScoredRow } from './filters.ts';
import { buildTriageCards } from './triage.ts';

const item = (over: Partial<ListingItem>): ListingItem => ({
  id: 1,
  case_no: '2024타경1',
  item_no: '1',
  court: '서울중앙',
  address: '서울 강남구',
  property_type: 'apartment',
  appraisal_value: 500_000_000,
  min_bid_price: 350_000_000,
  fail_count: 0,
  sale_date: '2026-07-25',
  area_m2: 84,
  source: 'court',
  source_url: null,
  is_favorite: false,
  crawled_at: null,
  lat: null,
  lng: null,
  field_done: 0,
  field_total: 0,
  field_notes: 0,
  inq_cnt: null,
  interest_cnt: null,
  rights: { risk_grade: 'clean', assumed_amount: 0 },
  location: { safety_margin: 0.18, acquisition_cost: { trueSafetyMargin: 0.1 } as any, report: { recommendation: 'consider', dangerCount: 0, warnCount: 0, headline: '', summary: [], rightsSummary: '', locationSummary: '', costSummary: '', checklist: [] } },
  total_score: null,
  passed_filter: null,
  safety_margin_score: null,
  clean_rights_score: null,
  reason: null,
  ...over,
} as ListingItem);

const scored = (over: Partial<ListingItem>, totalScore = 70, passed = true): ScoredRow => ({
  item: item(over),
  sc: { totalScore, passed, safetyScore: 0, cleanScore: 0, competitionScore: null, reasons: [] },
});

describe('buildTriageCards', () => {
  it('입찰임박·인수주의·추천·임장대기를 우선순위 카드로 요약한다', () => {
    const cards = buildTriageCards([
      scored({ id: 1, case_no: 'urgent', sale_date: '2026-07-22' }, 82),
      scored({ id: 2, case_no: 'assumed', rights: { risk_grade: 'review_required', assumed_amount: 120_000_000 } as any }, 41, false),
      scored({ id: 3, case_no: 'good', location: { safety_margin: 0.24, acquisition_cost: { trueSafetyMargin: 0.15 }, income: { zeroPiCandidate: true } } as any }, 86),
      scored({ id: 4, case_no: 'field', field_total: 5, field_done: 2, field_notes: 1 }, 63),
    ], '2026-07-22', 4);

    expect(cards.map((card) => card.kind)).toEqual(['urgent', 'assumed', 'recommend', 'fieldwork']);
    expect(cards.map((card) => card.caseNo)).toEqual(['urgent', 'assumed', 'good', 'field']);
    expect(cards[0]).toMatchObject({ tone: 'danger', label: '입찰임박' });
    expect(cards[1]).toMatchObject({ tone: 'warn', label: '인수주의' });
  });

  it('같은 매물은 가장 중요한 카드 한 장으로만 노출한다', () => {
    const cards = buildTriageCards([
      scored({ id: 1, case_no: 'both', sale_date: '2026-07-22', rights: { risk_grade: 'risky', assumed_amount: 80_000_000 } as any }, 35, false),
    ], '2026-07-22', 4);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind).toBe('urgent');
  });
});
