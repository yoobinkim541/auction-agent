import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ListingItem, PrecisionObj } from './api.ts';
import { Detail } from './Detail.tsx';
import { PrecisionInbox } from './PrecisionInbox.tsx';
import {
  applyIfCurrent, canShowBid, createDecisionDraft, createRequestGate, decisionReasonLabel,
  precisionView, shouldShowLegacyBid,
} from './precision.ts';
import { shouldIgnoreDrawerShortcut } from './detail-keyboard.ts';

const recommendedPrecision: PrecisionObj = {
  status: 'recommended', confidence: 'high', conservative_value: 400_000_000,
  recommended_bid: 330_000_000, hard_cap_bid: 350_000_000, reason_codes: [],
  strengths: ['권리 확인'], risks: [], required_checks: [], evaluator_version: 'test', evaluated_at: '2026-08-21T00:00:00Z',
};

const precisionListing = (precision: PrecisionObj | null): ListingItem => ({
  id: 8, case_no: '2026타경8', item_no: '1', court: '서울중앙', address: '테스트 정밀 매물', property_type: 'apartment',
  appraisal_value: 500_000_000, min_bid_price: 300_000_000, fail_count: 1, sale_date: '2026-09-01', area_m2: 84,
  source: 'courtauction', source_url: null, is_favorite: false, crawled_at: null, lat: null, lng: null,
  field_done: 0, field_total: 0, field_notes: 0, inq_cnt: null, interest_cnt: null,
  rights: { max_safe_bid: 260_000_000 },
  location: {
    market_price: 450_000_000, expected_bid_price: 270_000_000, expected_bid_basis: '레거시 예상가 근거',
    sale_rounds: [{ round: 2, date: '2026-09-01', minPrice: 250_000_000 }],
    acquisition_cost: { bidPrice: 280_000_000, bidBasis: '레거시', acqTax: 0, acqTaxRatePct: 0, moveOutCost: 0, bondCost: 0, assumedAmount: 0, etcCost: 0, totalCost: 0, trueSafetyMargin: null, notes: [] },
  },
  total_score: null, passed_filter: null, safety_margin_score: null, clean_rights_score: null, reason: null,
  precision,
});

describe('precision presentation', () => {
  it('labels hold verdicts with the missing-market rationale', () => {
    const view = precisionView({ status: 'hold', reason_codes: ['MISSING_MARKET_PRICE'] });

    expect(view.label).toBe('보류');
    expect(view.summary).toContain('시세 근거 부족');
  });

  it('only exposes bid values for recommended verdicts', () => {
    expect(canShowBid({ status: 'recommended', hard_cap_bid: 240_000_000 })).toBe(true);
    expect(canShowBid({ status: 'hold', hard_cap_bid: 240_000_000 })).toBe(false);
    expect(canShowBid({ status: 'rejected', recommended_bid: 180_000_000 })).toBe(false);
  });

  it('renders structured decision reasons in Korean', () => {
    expect(decisionReasonLabel('data_missing')).toBe('데이터 부족');
    expect(decisionReasonLabel('rights')).toBe('권리관계');
  });

  it('shows legacy bid values only when there is no precision evaluation', () => {
    expect(shouldShowLegacyBid(null)).toBe(true);
    expect(shouldShowLegacyBid({ status: 'recommended' })).toBe(false);
    expect(shouldShowLegacyBid({ status: 'hold' })).toBe(false);
    expect(shouldShowLegacyBid({ status: 'rejected' })).toBe(false);
  });

  it('resets the A draft before navigating to B', () => {
    const draftForA = createDecisionDraft();
    draftForA.decision = 'rejected';
    draftForA.reasonCode = 'price';
    draftForA.note = 'A 메모';
    draftForA.targetBid = '240000000';

    expect(createDecisionDraft()).toEqual({ decision: 'reviewing', reasonCode: '', note: '', targetBid: '' });
  });

  it('rejects stale success and error responses after a newer precision request', () => {
    const gate = createRequestGate();
    const initialRequest = gate.begin();
    const newerRequest = gate.begin();
    const applied: string[] = [];

    expect(applyIfCurrent(gate, initialRequest, () => applied.push('stale-success'))).toBe(false);
    expect(applyIfCurrent(gate, initialRequest, () => applied.push('stale-error'))).toBe(false);
    expect(applied).toEqual([]);
    expect(applyIfCurrent(gate, newerRequest, () => applied.push('newer-success'))).toBe(true);
    expect(applied).toEqual(['newer-success']);
    expect(gate.isCurrent(newerRequest)).toBe(true);
  });

  it('rejects stale history and save responses after navigating from A to B', () => {
    const gate = createRequestGate();
    const listingARequest = gate.begin();
    const listingBRequest = gate.begin();
    const history: string[] = [];

    expect(applyIfCurrent(gate, listingARequest, () => history.push('A save'))).toBe(false);
    expect(applyIfCurrent(gate, listingARequest, () => history.push('A history'))).toBe(false);
    expect(history).toEqual([]);
    expect(applyIfCurrent(gate, listingBRequest, () => history.push('B history'))).toBe(true);
    expect(history).toEqual(['B history']);
    expect(gate.isCurrent(listingBRequest)).toBe(true);
  });

  it('keeps the hard cap on ready recommended inbox cards', () => {
    const markup = renderToStaticMarkup(createElement(PrecisionInbox, { items: [precisionListing(recommendedPrecision)], loading: false, error: null, onOpen: () => {}, onLegacy: () => {}, onReload: () => {} }));

    expect(markup).toContain('절대 상한 350,000,000원');
  });

  it('does not render stale precision cards while loading or after an error', () => {
    const staleItems = [precisionListing(recommendedPrecision)];
    const loadingMarkup = renderToStaticMarkup(createElement(PrecisionInbox, { items: staleItems, loading: true, error: null, onOpen: () => {}, onLegacy: () => {}, onReload: () => {} }));
    const errorMarkup = renderToStaticMarkup(createElement(PrecisionInbox, { items: staleItems, loading: false, error: 'failed', onOpen: () => {}, onLegacy: () => {}, onReload: () => {} }));

    expect(loadingMarkup).toContain('정밀 추천을 불러오는 중…');
    expect(loadingMarkup).not.toContain('테스트 정밀 매물');
    expect(errorMarkup).toContain('정밀 추천을 불러오지 못했습니다');
    expect(errorMarkup).not.toContain('테스트 정밀 매물');
  });

  it('omits actionable legacy bid surfaces from a nonrecommended precision detail', () => {
    const holdPrecision = { ...recommendedPrecision, status: 'hold' as const, hard_cap_bid: 350_000_000 };
    const markup = renderToStaticMarkup(createElement(Detail, { row: precisionListing(holdPrecision), onClose: () => {}, onFav: () => {}, onDecisionSaved: () => {} }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="detail-dialog-title"');
    expect(markup).toContain('id="detail-dialog-title"');
    expect(markup).not.toContain('정밀 추천 데이터 없음');
    expect(markup).not.toContain('최저매각가');
    expect(markup).not.toContain('일반 예상낙찰가');
    expect(markup).not.toContain('일반 최대안전입찰가');
    expect(markup).not.toContain('ML 참고 보정가');
    expect(markup).not.toContain('취득비용 계산기');
    expect(markup).not.toContain('매각기일 차수');
  });

  it('ignores drawer arrows from editable and interactive targets', () => {
    expect(shouldIgnoreDrawerShortcut({ tagName: 'INPUT' } as EventTarget)).toBe(true);
    expect(shouldIgnoreDrawerShortcut({ tagName: 'BUTTON' } as EventTarget)).toBe(true);
    expect(shouldIgnoreDrawerShortcut({ tagName: 'A' } as EventTarget)).toBe(true);
    expect(shouldIgnoreDrawerShortcut({ isContentEditable: true } as EventTarget)).toBe(true);
    expect(shouldIgnoreDrawerShortcut({ tagName: 'DIV' } as EventTarget)).toBe(false);
  });
});
