/** 일일 다이제스트 텍스트 포맷(순수 — DB/IO 없음, 테스트 가능). daily-digest.ts가 DB 조회 후 호출. */
export interface DigestRow {
  case_no: string; property_type: string; address: string;
  appraisal_value: number | null; min_bid_price: number | null; sale_date: string | null;
  source_url: string | null; inq_cnt: number | null; interest_cnt: number | null; crawled_at: string | null;
  risk_grade: string | null; safety_margin: number | null; true_margin: number | null;
  total_score: number | null;
}

const eok = (n: number | null): string => (n == null ? '-' : `${(n / 1e8).toFixed(1)}억`);
const pct = (v: number | null): string => (v == null ? '-' : `${Math.round(v * 100)}%`);
const TYPE: Record<string, string> = { apartment: '아파트', villa: '빌라', officetel: '오피스텔', house: '단독', land: '토지', commercial: '상가', other: '기타' };
const RISK: Record<string, string> = { clean: '✅clean', caution: '🟡주의', risky: '🟠위험', review_required: '🔴검토' };

/** 통과 상위 N건 → 텔레그램용 다이제스트 텍스트. */
export function formatDigest(rows: DigestRow[], opts: { today: string; totalPassed: number }): string {
  if (!rows.length) return '🏁 오늘 추천할 통과 매물이 없습니다. (기준 충족 0건)';
  const out: string[] = [`🏆 오늘의 경매 추천 ${rows.length}건 (통과 ${opts.totalPassed}건 중 상위)`, ''];
  rows.forEach((r, i) => {
    const isNew = r.crawled_at != null && r.crawled_at.slice(0, 10) >= opts.today;
    const lowComp = r.inq_cnt != null && (r.inq_cnt + (r.interest_cnt ?? 0) * 3) <= 10;
    out.push(`${i + 1}. ${r.case_no} · ${TYPE[r.property_type] ?? r.property_type} · ${r.address.slice(0, 24)} ⭐${r.total_score ?? '-'}${isNew ? ' 🆕' : ''}`);
    out.push(`   감정 ${eok(r.appraisal_value)} / 최저 ${eok(r.min_bid_price)} · 안전마진 ${pct(r.safety_margin)}${r.true_margin != null ? ` (진짜 ${pct(r.true_margin)})` : ''}`);
    const tags = [RISK[r.risk_grade ?? ''] ?? r.risk_grade ?? '', lowComp ? `🔥저경쟁(조회${r.inq_cnt})` : '', r.sale_date ? `매각 ${r.sale_date}` : ''].filter(Boolean);
    out.push(`   ${tags.join(' · ')}`);
    if (r.source_url) out.push(`   ${r.source_url}`);
    out.push('');
  });
  return out.join('\n').trim();
}
