/** 일일 다이제스트 텍스트 포맷(순수 — DB/IO 없음, 테스트 가능). daily-digest.ts가 DB 조회 후 호출. */
export interface DigestRow {
  case_no: string; property_type: string; address: string;
  appraisal_value: number | null; min_bid_price: number | null; sale_date: string | null;
  source_url: string | null; inq_cnt: number | null; interest_cnt: number | null; crawled_at: string | null;
  risk_grade: string | null; safety_margin: number | null; true_margin: number | null;
  total_score: number | null; memo: string | null;
  predicted_band?: string | null; // 낙찰가 예측 밴드(comps) — daily-digest가 채움(선택)
}

/** 어제 기일 결과 회고용(gm_auction_results 조인). */
export interface DigestResult {
  case_no: string; property_type: string; address: string;
  appraisal_value: number | null; sold: boolean | null; sold_amount: number | null;
  sale_ratio: number | null; was_recommended: boolean;
}

const eok = (n: number | null): string => (n == null ? '-' : `${(n / 1e8).toFixed(1)}억`);
const pct = (v: number | null): string => (v == null ? '-' : `${Math.round(v * 100)}%`);
const TYPE: Record<string, string> = { apartment: '아파트', villa: '빌라', officetel: '오피스텔', house: '단독', land: '토지', commercial: '상가', other: '기타' };
const RISK: Record<string, string> = { clean: '✅clean', caution: '🟡주의', risky: '🟠위험', review_required: '🔴검토' };

const isNew = (r: DigestRow, today: string): boolean => r.crawled_at != null && r.crawled_at.slice(0, 10) >= today;
/** memo 첫 문장(텔레그램 한 줄용). */
const firstSentence = (memo: string): string => {
  const s = memo.trim().split(/(?<=[.。!?])\s/)[0] ?? memo;
  return s.length > 90 ? s.slice(0, 88) + '…' : s;
};

export interface DigestOpts {
  today: string;
  totalPassed: number;
  dataAsOf?: string | null;   // 마지막 실수집(n_found>0) 날짜 YYYY-MM-DD
  dataAgeDays?: number | null; // 오늘 - dataAsOf (일)
  dashboardBase?: string | null; // 설정 시 매물 링크를 대시보드 딥링크(#case=)로 — 없으면 원본(courtauction) 링크
}

const ddayLabel = (d: string | null, today: string): string => {
  if (!d) return '';
  const days = Math.round((new Date(d).getTime() - new Date(today).getTime()) / 86_400_000);
  return days === 0 ? 'D-day' : days > 0 ? `D-${days}` : `D+${-days}`;
};

/** 통과 상위 N건 → 텔레그램용 다이제스트 텍스트. */
export function formatDigest(rows: DigestRow[], opts: DigestOpts): string {
  const out: string[] = [];
  // 데이터 신선도 스탬프(침묵 방지 — 낡은 데이터로 추천 시 스스로 경고)
  if (opts.dataAsOf) {
    const stale = (opts.dataAgeDays ?? 0) >= 2;
    out.push(`📅 데이터 기준 ${opts.dataAsOf}${opts.dataAgeDays != null ? ` (${opts.dataAgeDays}일 전${stale ? ' ⚠️ 오래됨 — 크롤 점검 필요' : ''})` : ''}`);
  }
  if (!rows.length) {
    out.push('🏁 오늘 추천할 통과 매물이 없습니다. (기준 충족 0건)');
    return out.join('\n').trim();
  }
  const newCount = rows.filter((r) => isNew(r, opts.today)).length;
  out.push(`🏆 오늘의 경매 추천 ${rows.length}건 (통과 ${opts.totalPassed}건 중 · 🆕 신규 ${newCount})`, '');

  rows.forEach((r, i) => {
    const lowComp = r.inq_cnt != null && (r.inq_cnt + (r.interest_cnt ?? 0) * 3) <= 10;
    const ratio = r.appraisal_value && r.min_bid_price ? r.min_bid_price / r.appraisal_value : null;
    const extreme = ratio != null && ratio < 0.4; // 최저가가 감정가의 40% 미만 = 수차례 유찰(지분·특수 의심)
    out.push(`${i + 1}. ${r.case_no} · ${TYPE[r.property_type] ?? r.property_type} · ${r.address.slice(0, 24)} ⭐${r.total_score ?? '-'}${isNew(r, opts.today) ? ' 🆕' : ''}`);
    out.push(`   감정 ${eok(r.appraisal_value)} / 최저 ${eok(r.min_bid_price)} · 안전마진 ${pct(r.safety_margin)}${r.true_margin != null ? ` (진짜 ${pct(r.true_margin)})` : ''}`);
    const tags = [
      RISK[r.risk_grade ?? ''] ?? r.risk_grade ?? '',
      lowComp ? `🔥저경쟁(조회${r.inq_cnt})` : '',
      extreme ? '⚠️극단마진(지분·특수 의심)' : '',
      r.sale_date ? `매각 ${r.sale_date}` : '',
    ].filter(Boolean);
    out.push(`   ${tags.join(' · ')}`);
    if (r.predicted_band) out.push(`   📈 ${r.predicted_band}`);
    if (r.memo) out.push(`   💬 ${firstSentence(r.memo)}`);
    const link = opts.dashboardBase ? `${opts.dashboardBase.replace(/\/+$/, '')}/#case=${encodeURIComponent(r.case_no)}` : r.source_url;
    if (link) out.push(`   ${link}`);
    out.push('');
  });
  return out.join('\n').trim();
}

/** 이번 주 입찰 후보 — 매각 임박순 압축 리스트(다이제스트가 '읽기'에서 '행동'으로). */
export function formatUpcoming(rows: DigestRow[], today: string): string {
  if (!rows.length) return '';
  const out: string[] = [`🗓 이번 주 입찰 후보 ${rows.length}건`];
  for (const r of rows.slice(0, 8)) {
    out.push(`  ${ddayLabel(r.sale_date, today)} · ${r.case_no} · ${TYPE[r.property_type] ?? r.property_type} · ${r.address.slice(0, 14)} ⭐${r.total_score ?? '-'}`);
  }
  return out.join('\n');
}

/** 어제 기일 결과 회고 — 학습 루프를 눈에 보이게(낙찰/유찰 + 우리가 추천했던 물건 결과). */
export function formatResultsRecap(results: DigestResult[], dateLabel: string): string {
  if (!results.length) return '';
  const sold = results.filter((r) => r.sold);
  const failed = results.filter((r) => !r.sold);
  const ratios = sold.map((r) => r.sale_ratio).filter((x): x is number => x != null).sort((a, b) => a - b);
  const medRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)]! : null;
  const out: string[] = [`📊 ${dateLabel} 기일 결과: 낙찰 ${sold.length} · 유찰 ${failed.length}${medRatio != null ? ` · 낙찰가율(중앙) ${Math.round(medRatio * 100)}%` : ''}`];
  const rec = results.filter((r) => r.was_recommended);
  for (const r of rec.slice(0, 5)) {
    const res = r.sold ? `낙찰 ${eok(r.sold_amount)}${r.sale_ratio != null ? `(${Math.round(r.sale_ratio * 100)}%)` : ''}` : '유찰';
    out.push(`   ⭐추천했던 ${r.case_no} ${r.address.slice(0, 16)} → ${res}`);
  }
  return out.join('\n');
}
