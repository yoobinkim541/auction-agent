import type { ReactNode } from 'react';
import type { SortKey } from './filters.ts';
import type { ListingItem } from './api.ts';
import { saleDaysDiff } from './listing-utils.ts';

/** 로딩 스켈레톤 리스트. */
export function SkeletonList() {
  return (
    <div className="skeleton" aria-busy="true" aria-label="불러오는 중">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="sk-row">
          <span className="sk-cell sk-w1" /><span className="sk-cell sk-w2" />
          <span className="sk-cell sk-w3" /><span className="sk-cell sk-w1" />
          <span className="sk-cell sk-w1" /><span className="sk-cell sk-w2" />
        </div>
      ))}
    </div>
  );
}

/** 안내 박스. */
export function Notice({ children }: { children: ReactNode }) {
  return <div className="notice">{children}</div>;
}

/** 상세 섹션 래퍼. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="sect"><h3>{title}</h3>{children}</section>;
}

/** 정렬 가능한 테이블 헤더 셀. */
export function ThSort({ col, cur, dir, onSort, children }: {
  col: SortKey; cur: SortKey; dir: 'asc' | 'desc'; onSort: (c: SortKey) => void; children: ReactNode;
}) {
  const active = col === cur;
  return (
    <th className={`sortable${active ? ' sorted' : ''}`} onClick={() => onSort(col)}>
      {children}{active ? <span className="sort-ind">{dir === 'asc' ? ' ↑' : ' ↓'}</span> : null}
    </th>
  );
}

/** D-Day 배지(매각기일까지 남은 일수). */
export function DDay({ dateStr }: { dateStr?: string | null }) {
  const d = saleDaysDiff(dateStr);
  if (d === null) return null;
  const label = d === 0 ? 'D-Day' : d < 0 ? `D+${-d}` : `D-${d}`;
  const cls = d <= 0 ? 'dday-urgent' : d <= 3 ? 'dday-warn' : d <= 7 ? 'dday-soon' : 'dday-ok';
  return <span className={`dday ${cls}`} title={dateStr ?? ''}>{label}</span>;
}

/** 임장 진행 배지 — 현장 체크를 시작한 매물에만 표시. */
export function FieldProgress({ r }: { r: ListingItem }) {
  const total = r.field_total ?? 0;
  const done = r.field_done ?? 0;
  const notes = r.field_notes ?? 0;
  if (total === 0 || (done === 0 && notes === 0)) return null;
  const complete = done >= total;
  return (
    <span className={`fv-chip${complete ? ' fv-chip-done' : ''}`}
      title={`현장 확인 ${done}/${total}${notes ? ` · 메모 ${notes}건` : ''}${complete ? ' · 임장 완료' : ''}`}>
      🚶{done}/{total}{notes > 0 ? ' 📝' : ''}
    </span>
  );
}
