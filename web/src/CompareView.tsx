import { useEffect, type ReactNode } from 'react';
import { scoreClient, type ScoreConfig } from './scoring.ts';
import { eok, pct, type ListingItem } from './api.ts';
import { TYPE_LABEL, RISK } from './labels.ts';
import { DDay } from './ui.tsx';

/** 관심 매물 나란히 비교 — slim 데이터만으로 핵심 지표를 표로. 항목별 최우수 셀을 초록 강조. */
export function CompareView({ items, cfg, onClose, onSelect }: {
  items: ListingItem[]; cfg: ScoreConfig; onClose: () => void; onSelect: (r: ListingItem) => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  type Row = { label: string; rank?: (r: ListingItem) => number | null; dir?: 'max' | 'min'; cell: (r: ListingItem) => ReactNode };
  const score = (r: ListingItem) => scoreClient(r, cfg).totalScore;
  const rows: Row[] = [
    { label: '종류·면적', cell: (r) => `${TYPE_LABEL[r.property_type] ?? r.property_type}${r.area_m2 != null ? ` · ${r.area_m2.toFixed(0)}㎡` : ''}` },
    { label: '감정가', cell: (r) => eok(r.appraisal_value) },
    { label: '최저가', dir: 'min', rank: (r) => r.min_bid_price, cell: (r) => eok(r.min_bid_price) },
    { label: '안전마진', dir: 'max', rank: (r) => r.location?.safety_margin ?? null, cell: (r) => pct(r.location?.safety_margin) },
    { label: '진짜마진', dir: 'max', rank: (r) => r.location?.acquisition_cost?.trueSafetyMargin ?? null, cell: (r) => pct(r.location?.acquisition_cost?.trueSafetyMargin) },
    { label: '예상낙찰가', cell: (r) => eok(r.location?.expected_bid_price) },
    { label: '인수금액', dir: 'min', rank: (r) => r.rights?.assumed_amount ?? 0, cell: (r) => (r.rights?.assumed_amount ? eok(r.rights.assumed_amount) : '0') },
    { label: '갭(소자본)', dir: 'min', rank: (r) => r.location?.income?.gapInvestment ?? null, cell: (r) => (r.location?.income?.gapInvestment != null ? eok(r.location.income.gapInvestment) : '-') },
    { label: '점수', dir: 'max', rank: (r) => score(r), cell: (r) => <b>{score(r)}</b> },
    { label: '권리', cell: (r) => (RISK[r.rights?.risk_grade ?? '']?.label ?? '-') },
    { label: '매각기일', cell: (r) => <>{r.sale_date ?? '-'} <DDay dateStr={r.sale_date} /></> },
    { label: '무피', cell: (r) => (r.location?.income?.zeroPiCandidate ? '★' : '-') },
    { label: '현장확인', cell: (r) => `${r.field_done ?? 0}/${r.field_total ?? 0}${(r.field_notes ?? 0) > 0 ? ' 📝' : ''}` },
  ];

  const bestIdx = (row: Row): number => {
    if (!row.rank || !row.dir) return -1;
    let bi = -1, bv = row.dir === 'max' ? -Infinity : Infinity;
    items.forEach((r, i) => {
      const v = row.rank!(r);
      if (v == null) return;
      if ((row.dir === 'max' && v > bv) || (row.dir === 'min' && v < bv)) { bv = v; bi = i; }
    });
    return bi;
  };

  return (
    <div className="cmp-bg" onClick={onClose}>
      <div className="cmp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cmp-head">
          <h2>⚖ 관심 매물 비교 <span className="muted">({items.length}건)</span></h2>
          <button className="close" onClick={onClose}>✕</button>
        </div>
        <div className="cmp-scroll">
          <table className="cmp-table">
            <thead>
              <tr>
                <th className="cmp-rowlabel"></th>
                {items.map((r) => (
                  <th key={r.id} className="cmp-col-head">
                    <button className="cmp-open" onClick={() => { onClose(); onSelect(r); }} title="상세 열기">
                      <span className="cmp-addr">{r.address}</span>
                      <span className="mono cmp-case">{r.case_no} ›</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const bi = bestIdx(row);
                return (
                  <tr key={row.label}>
                    <td className="cmp-rowlabel">{row.label}</td>
                    {items.map((r, i) => (
                      <td key={r.id} className={`cmp-cell${i === bi ? ' cmp-best' : ''}`}>{row.cell(r)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted cmp-foot">초록 = 항목별 최우수(최저가·최고마진·최저인수·최고점수 등). 열 머리 클릭 시 상세.</p>
      </div>
    </div>
  );
}
