import type { ListingItem } from './api.ts';
import { eok, pct } from './api.ts';
import type { ScoredRow } from './filters.ts';
import { saleDaysDiff } from './listing-utils.ts';

export type TriageKind = 'urgent' | 'assumed' | 'recommend' | 'fieldwork';
export type TriageTone = 'danger' | 'warn' | 'good' | 'info';

export interface TriageCard {
  kind: TriageKind;
  tone: TriageTone;
  label: string;
  caseNo: string;
  title: string;
  subtitle: string;
  metric: string;
  footLeft: string;
  footRight: string;
  row: ListingItem;
}

const TYPE_LABEL_SHORT: Record<string, string> = {
  apartment: '아파트',
  villa: '빌라',
  officetel: '오피스텔',
  house: '주택',
  land: '토지',
  commercial: '상가',
};

function titleOf(row: ListingItem): string {
  return `${row.case_no}${row.item_no && row.item_no !== '1' ? `-${row.item_no}` : ''}`;
}

function subtitleOf(row: ListingItem): string {
  const type = TYPE_LABEL_SHORT[row.property_type] ?? row.property_type;
  return `${row.address}${type ? ` · ${type}` : ''}`;
}

function ddayLabel(row: ListingItem, today: string): string {
  const diff = saleDaysDiff(row.sale_date, today);
  if (diff === null) return '기일 미정';
  if (diff === 0) return 'D-Day';
  return diff < 0 ? `D+${Math.abs(diff)}` : `D-${diff}`;
}

function trueMargin(row: ListingItem): number | null {
  return row.location?.acquisition_cost?.trueSafetyMargin ?? row.location?.safety_margin ?? null;
}

function cardFor(row: ScoredRow, today: string): TriageCard | null {
  const item = row.item;
  const diff = saleDaysDiff(item.sale_date, today);
  const assumed = item.rights?.assumed_amount ?? 0;
  const margin = trueMargin(item);
  const fieldTotal = item.field_total ?? 0;
  const fieldDone = item.field_done ?? 0;
  const fieldNotes = item.field_notes ?? 0;
  const title = titleOf(item);
  const subtitle = subtitleOf(item);
  const dday = ddayLabel(item, today);

  if (diff !== null && diff <= 1) {
    return {
      kind: 'urgent', tone: 'danger', label: '입찰임박', caseNo: item.case_no,
      title, subtitle, metric: pct(margin), footLeft: dday, footRight: assumed > 0 ? `인수 ${eok(assumed)}` : '인수 0',
      row: item,
    };
  }
  if (assumed > 0 || (margin != null && margin < 0)) {
    return {
      kind: 'assumed', tone: 'warn', label: '인수주의', caseNo: item.case_no,
      title, subtitle, metric: assumed > 0 ? eok(assumed) : pct(margin), footLeft: assumed > 0 ? `인수 ${eok(assumed)}` : '마진 음수',
      footRight: dday, row: item,
    };
  }
  if (row.sc.passed && row.sc.totalScore >= 70) {
    return {
      kind: 'recommend', tone: 'good', label: item.location?.income?.zeroPiCandidate ? '무피후보' : '강력추천',
      caseNo: item.case_no, title, subtitle, metric: String(row.sc.totalScore), footLeft: pct(margin), footRight: dday, row: item,
    };
  }
  if (fieldTotal > 0 && (fieldDone < fieldTotal || fieldNotes > 0)) {
    return {
      kind: 'fieldwork', tone: 'info', label: '임장대기', caseNo: item.case_no,
      title, subtitle, metric: `${fieldDone}/${fieldTotal}`, footLeft: fieldNotes > 0 ? `메모 ${fieldNotes}건` : '현장 확인',
      footRight: dday, row: item,
    };
  }
  return null;
}

export function buildTriageCards(rows: ScoredRow[], today: string, max = 4): TriageCard[] {
  const rank: Record<TriageKind, number> = { urgent: 0, assumed: 1, recommend: 2, fieldwork: 3 };
  const seen = new Set<number>();
  return rows
    .map((row) => cardFor(row, today))
    .filter((card): card is TriageCard => card !== null)
    .filter((card) => {
      if (seen.has(card.row.id)) return false;
      seen.add(card.row.id);
      return true;
    })
    .sort((a, b) => rank[a.kind] - rank[b.kind])
    .slice(0, max);
}
