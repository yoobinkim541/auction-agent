import { describe, expect, it } from 'vitest';
import { depositWon, formatBidPrep, type BidPrepRow } from './bidprep-format.ts';

const row = (over: Partial<BidPrepRow> = {}): BidPrepRow => ({
  case_no: '2025타경507294', item_no: '2', property_type: 'villa', address: '인천광역시 중구 송월동3가 1-1',
  court: '인천지방법원', min_bid_price: 1_4000_0000, total_score: 100, is_favorite: false, ...over,
});

describe('depositWon', () => {
  it('최저가 10% 올림', () => {
    expect(depositWon(1_4000_0000)).toBe(1400_0000);
    expect(depositWon(null)).toBeNull();
  });
});

describe('formatBidPrep', () => {
  it('대상 없으면 빈 문자열(발송 생략)', () => {
    expect(formatBidPrep([], '2026-07-13')).toBe('');
  });
  it('보증금·법원·딥링크·준비물·특별매각 경고 포함', () => {
    const s = formatBidPrep([row({ is_favorite: true })], '2026-07-13', 'https://dash.example');
    expect(s).toContain('🎯 내일 입찰 D-1 · 2026-07-13 (1건)');
    expect(s).toContain('★');
    expect(s).toContain('인천지방법원');
    expect(s).toContain('보증금 1,400만원 (10%)');
    expect(s).toContain('https://dash.example/#case=2025%ED%83%80%EA%B2%BD507294&item=2');
    expect(s).toContain('준비물');
    expect(s).toContain('특별매각조건');
  });
  it('보증금 1억 이상은 억 단위 표기', () => {
    const s = formatBidPrep([row({ min_bid_price: 12_0000_0000 })], '2026-07-13');
    expect(s).toContain('보증금 1.20억');
  });
});
