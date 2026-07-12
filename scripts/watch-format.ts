/** 관심물건(★) 변동 diff·포맷(순수 — DB/IO 없음, 테스트 가능). watch-favorites.ts가 조회 후 호출. */
import { eok } from '../shared/format.ts';

export interface FavSnapshot {
  case_no: string;
  address: string;
  sale_date: string | null;      // YYYY-MM-DD
  min_bid_price: number | null;
  fail_count: number | null;
  sold: boolean;                 // 낙찰 결과 존재
}

/** 직전 상태 대비 변동 라인들(변화 없으면 빈 배열). */
export function diffFavorite(prev: FavSnapshot, cur: FavSnapshot): string[] {
  const out: string[] = [];
  if (cur.sold && !prev.sold) {
    out.push('🎉 매각됨 — 낙찰 결과 확인');
    return out; // 매각 후 기일/최저가 변동은 무의미
  }
  if ((cur.fail_count ?? 0) > (prev.fail_count ?? 0)) {
    out.push(`유찰 발생 (${prev.fail_count ?? 0}→${cur.fail_count}회)`);
  }
  if (cur.sale_date !== prev.sale_date && cur.sale_date) {
    out.push(`기일 변경 ${prev.sale_date ?? '-'} → ${cur.sale_date}`);
  }
  if (cur.min_bid_price !== prev.min_bid_price && cur.min_bid_price != null && prev.min_bid_price != null) {
    const dropPct = Math.round((1 - cur.min_bid_price / prev.min_bid_price) * 100);
    out.push(`최저가 ${eok(prev.min_bid_price)} → ${eok(cur.min_bid_price)}${dropPct > 0 ? ` (▼${dropPct}%)` : ''}`);
  }
  return out;
}

export interface FavChangeBlock { caseNo: string; address: string; lines: string[] }

/** 텔레그램용 변동 알림 텍스트 — 변동 블록이 없으면 빈 문자열(발송 생략 신호). */
export function formatWatch(blocks: FavChangeBlock[], dashboardBase?: string | null): string {
  const withLines = blocks.filter((b) => b.lines.length);
  if (!withLines.length) return '';
  const out: string[] = [`🔔 관심물건 변동 ${withLines.length}건`];
  for (const b of withLines) {
    out.push(`★${b.caseNo} · ${b.address.slice(0, 22)}`);
    for (const l of b.lines) out.push(`   ${l}`);
    if (dashboardBase) out.push(`   ${dashboardBase.replace(/\/+$/, '')}/#case=${encodeURIComponent(b.caseNo)}`);
  }
  return out.join('\n');
}
