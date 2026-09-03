/** D-1 입찰 준비 패키지 포맷(순수 — DB/IO 없음, 테스트 가능). bid-prep.ts가 조회 후 호출. */
import { eok } from '../shared/format.ts';

export interface BidPrepRow {
  case_no: string;
  item_no: string;
  property_type: string;
  address: string;
  court: string;
  min_bid_price: number | null;
  total_score: number | null;
  is_favorite: boolean;
}

const TYPE: Record<string, string> = { apartment: '아파트', villa: '빌라', officetel: '오피스텔', house: '단독', land: '토지', commercial: '상가', other: '기타' };

/** 입찰보증금 = 최저매각가 10%(원). 특별매각조건(20%)은 공고 확인 필요 — 별도 경고로 안내. */
export function depositWon(minBid: number | null): number | null {
  return minBid == null ? null : Math.ceil(minBid * 0.1);
}

const manwon = (won: number | null): string =>
  won == null ? '-' : won >= 1e8 ? eok(won) : `${Math.round(won / 1e4).toLocaleString('ko-KR')}만원`;

/** 내일 기일 매물 → 입찰 준비 텍스트. 대상 없으면 빈 문자열(발송 생략 신호). */
export function formatBidPrep(rows: BidPrepRow[], tomorrow: string, dashboardBase?: string | null): string {
  if (!rows.length) return '';
  const out: string[] = [`🎯 내일 입찰 D-1 · ${tomorrow} (${rows.length}건)`];
  rows.forEach((r, i) => {
    out.push(`${i + 1}. ${r.case_no} · ${TYPE[r.property_type] ?? r.property_type} · ${r.address.slice(0, 22)}${r.total_score != null ? ` ⭐${r.total_score}` : ''}${r.is_favorite ? ' ★' : ''}`);
    out.push(`   ${r.court} · 최저가 ${eok(r.min_bid_price)} · 보증금 ${manwon(depositWon(r.min_bid_price))} (10%)`);
    if (dashboardBase) out.push(`   ${dashboardBase.replace(/\/+$/, '')}/#case=${encodeURIComponent(r.case_no)}&item=${encodeURIComponent(r.item_no || '1')}`);
  });
  out.push('');
  out.push('준비물: 신분증 · 도장 · 보증금(수표 1매 권장) · 사건번호 메모');
  out.push('⚠️ 재매각 사건은 보증금 20~30%일 수 있음 — 매각공고 특별매각조건 확인');
  return out.join('\n');
}
