import type { ReactNode } from 'react';
import type { SortKey } from './filters.ts';

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
