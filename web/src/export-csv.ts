import { resolveRound, localDateISO } from './listing-utils.ts';
import { TYPE_LABEL, RISK } from './labels.ts';
import type { ListingItem } from './api.ts';
import type { ClientScore } from './scoring.ts';

export type CsvRow = { item: ListingItem; sc: ClientScore };

const HEADERS = [
  '사건번호', '종류', '면적(㎡)', '주소', '법원', '감정가(만원)', '최저가(만원)',
  '안전마진%', '인수금액(만원)', '권리등급', '점수', '통과', '미통과사유', '매각기일',
  '추정시세(만원)', '진짜마진%', '전세시세(만원)', '갭(만원)', '수익률%',
  '현재차수', '예상낙찰가(만원)', 'AI권고', '위험항목수', '주의항목수', '등기미수집', '관심',
];

/** 현재 목록을 Excel 친화 CSV 문자열로 직렬화(BOM + CRLF, 금액은 만원 단위). 다운로드는 exportCSV가 담당 — 이 함수는 순수(테스트 가능). */
export function buildCsv(rows: CsvRow[]): string {
  const BOM = '﻿'; // Excel Korean UTF-8 BOM
  const toMw = (v: number | null | undefined) => (v != null ? Math.round(v / 10000) : '');
  const pctStr = (v: number | null | undefined) => (v != null ? (v * 100).toFixed(1) : '');
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const lines = rows.map(({ item: r, sc }) => {
    const rounds = r.location?.sale_rounds ?? [];
    const currentRound = resolveRound(rounds, r.sale_date, r.fail_count)?.n ?? null;
    return [
      r.case_no, TYPE_LABEL[r.property_type] ?? r.property_type, r.area_m2 != null ? r.area_m2.toFixed(2) : '', r.address, r.court ?? '',
      toMw(r.appraisal_value), toMw(r.min_bid_price),
      pctStr(r.location?.safety_margin),
      toMw(r.rights?.assumed_amount ?? 0),
      RISK[r.rights?.risk_grade ?? '']?.label ?? '-',
      sc.totalScore, sc.passed ? '○' : '✕', sc.reasons.join(' · '), r.sale_date ?? '',
      toMw(r.location?.market_price),
      pctStr(r.location?.acquisition_cost?.trueSafetyMargin),
      toMw(r.location?.income?.jeonseDeposit),
      toMw(r.location?.income?.gapInvestment),
      r.location?.income?.grossYieldPct != null ? r.location.income.grossYieldPct.toFixed(1) : '',
      currentRound ?? '',
      toMw(r.location?.expected_bid_price),
      r.location?.report?.recommendation ?? '',
      r.location?.report?.dangerCount ?? '',
      r.location?.report?.warnCount ?? '',
      r.location?.report?.headline?.startsWith('[데이터 불완전]') ? '○' : '',
      r.is_favorite ? '★' : '',
    ].map(esc).join(',');
  });

  return BOM + [HEADERS.map(esc).join(','), ...lines].join('\r\n');
}

/** buildCsv 결과를 파일로 다운로드(브라우저 전용 side-effect). */
export function exportCSV(rows: CsvRow[], filenameDate = localDateISO()): void {
  const csv = buildCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `경매분석_${filenameDate}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
