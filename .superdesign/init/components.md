# Components

Framework: React 19 + Vite. Component library: custom vanilla CSS, no shadcn/MUI/Tailwind. Shared UI primitives and cross-page components below include full source code.


### `web/src/ui.tsx`

```tsx
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

```


### `web/src/TodayActions.tsx`

```tsx
import type { TodayAction, TodayActionType } from './api.ts';

const LABELS: Record<TodayActionType, string> = {
  recrawl_needed: '재수집',
  rights_enrichment: '권리보강',
  bid_soon: '입찰임박',
  fieldwork: '현장확인',
  review_result: '결과복기',
};

function itemLabel(action: TodayAction): string {
  return action.item_no && action.item_no !== '1'
    ? `${action.case_no} · 물건 ${action.item_no}`
    : action.case_no;
}

export function TodayActions({ actions, loading, error, onOpenCase }: {
  actions: TodayAction[];
  loading: boolean;
  error: string | null;
  onOpenCase: (caseNo: string) => void;
}) {
  if (!loading && !error && actions.length === 0) return null;
  const visible = actions.slice(0, 8);
  const hidden = Math.max(0, actions.length - visible.length);

  return (
    <section className="today-actions" aria-label="오늘 할 일">
      <div className="today-actions-head">
        <div>
          <span className="today-actions-kicker">오늘 할 일</span>
          <b>{loading ? '불러오는 중…' : `${actions.length}건`}</b>
        </div>
        {hidden > 0 && <span className="today-actions-more">외 {hidden}건</span>}
      </div>
      {error ? (
        <p className="today-actions-error">할 일 큐를 불러오지 못했습니다: {error}</p>
      ) : (
        <div className="today-actions-list">
          {visible.map((action) => (
            <button
              key={`${action.action_type}:${action.listing_id}:${action.due_date ?? ''}`}
              className={`today-action-card today-action-${action.severity}`}
              onClick={() => onOpenCase(action.case_no)}
              title={action.reason}
            >
              <span className="today-action-type">{LABELS[action.action_type]}</span>
              <strong>{action.title}</strong>
              <span className="today-action-case">{itemLabel(action)}</span>
              <span className="today-action-reason">{action.reason}</span>
              {action.due_date && <span className="today-action-date">{action.due_date}</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

```


### `web/src/CostCalculator.tsx`

```tsx
import { useState } from 'react';
import { acquisitionTaxRate } from './cost.ts';
import { eok, won, pct, type ListingItem, type LocationObj } from './api.ts';
import { Section } from './ui.tsx';

/** 희망 낙찰가 입력 → 실시간 취득비용·진짜 안전마진 계산기(상세 드로어). */
export function CostCalculator({ row, loc }: { row: ListingItem; loc: LocationObj }) {
  const ac = loc.acquisition_cost!;
  const [bid, setBid] = useState<number>(ac.bidPrice || row.min_bid_price || 0);
  const [homes, setHomes] = useState<number>(1);
  const [regulated, setRegulated] = useState<boolean>(false);
  const [etc, setEtc] = useState<number>(ac.etcCost || 0);

  const tax = acquisitionTaxRate(row.property_type, bid, row.area_m2 ?? 0, { homeCountAfter: homes, isRegulatedArea: regulated });
  // 명도비·채권·인수금액은 낙찰가와 무관 → 서버 계산값을 상수로 사용
  const moveOut = ac.moveOutCost, bond = ac.bondCost, assumed = ac.assumedAmount;
  const total = bid + tax.totalKRW + moveOut + bond + assumed + etc;
  const market = loc.market_price ?? null;
  const margin = market && market > 0 ? (market - total) / market : null;
  const ratio = row.appraisal_value ? Math.round((bid / row.appraisal_value) * 100) : null;

  const presetBtn = (label: string, v: number | null) => v ? (
    <button className="mini-btn" onClick={() => setBid(v)}>{label} {eok(v)}</button>
  ) : null;

  return (
    <Section title="취득비용 계산기 · 진짜 안전마진">
      <div className="calc-row">
        <label>희망 낙찰가</label>
        <input type="number" step={1000000} value={bid} onChange={(e) => setBid(Number(e.target.value))} />
        <span className="muted">{eok(bid)}{ratio != null ? ` · 감정가 ${ratio}%` : ''}</span>
      </div>
      <div className="calc-presets">
        {presetBtn('최저가', row.min_bid_price)}
        {presetBtn('예상낙찰', loc.expected_bid_price ?? null)}
        {presetBtn('시세', market)}
      </div>
      <div className="calc-row">
        <label>보유 주택수</label>
        <select value={homes} onChange={(e) => setHomes(Number(e.target.value))}>
          <option value={1}>1주택(기본)</option><option value={2}>2주택</option>
          <option value={3}>3주택</option><option value={4}>4주택+</option>
        </select>
        <label className="chk"><input type="checkbox" checked={regulated} onChange={(e) => setRegulated(e.target.checked)} />조정대상지역</label>
      </div>
      <table className="mini">
        <tbody>
          <tr><td>낙찰가</td><td className="num">{won(bid)}</td></tr>
          <tr><td>취득세 ({tax.totalRatePct}%) <span className="muted">{tax.note}</span></td><td className="num">{won(tax.totalKRW)}</td></tr>
          <tr><td>명도비</td><td className="num">{won(moveOut)}</td></tr>
          <tr><td>국민주택채권(본인부담)</td><td className="num">{won(bond)}</td></tr>
          {assumed > 0 && <tr><td className="danger">권리 인수금액</td><td className="num danger">{won(assumed)}</td></tr>}
          <tr>
            <td>기타비용 <span className="muted">(미납관리비·법무사 등)</span></td>
            <td className="num"><input type="number" step={100000} value={etc} onChange={(e) => setEtc(Number(e.target.value))} className="etc-in" /></td>
          </tr>
          <tr className="total"><td><b>총 취득비용</b></td><td className="num"><b>{won(total)}</b></td></tr>
          <tr><td><b>진짜 안전마진</b> (시세 {eok(market)} 대비)</td><td className="num"><b className={(margin ?? 0) < 0 ? 'danger' : 'good'}>{pct(margin)}</b></td></tr>
        </tbody>
      </table>
      {ac.notes.length > 0 && <ul className="warns">{ac.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      <p className="muted">※ 취득세·채권은 참고용 추정(취득세 과세표준=낙찰가, 채권=공시가격 기준). 명도비·채권은 낙찰가와 무관해 고정. 등기 시점 위택스·주택도시기금 재확인.</p>
    </Section>
  );
}

```


### `web/src/CompareView.tsx`

```tsx
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

```


### `web/src/ConfigPanel.tsx`

```tsx
import { type ScoreConfig, DEFAULT_CONFIG } from './scoring.ts';
import { TYPE_LABEL } from './labels.ts';

const REGIONS = ['서울', '경기', '인천'];
// 가격대 프리셋(최저매각가, 억 단위). max=0 = 상한 없음.
const PRICE_BANDS: { label: string; min: number; max: number }[] = [
  { label: '5천만 미만', min: 0, max: 0.5 },
  { label: '5천~1억', min: 0.5, max: 1 },
  { label: '1억~1.5억', min: 1, max: 1.5 },
  { label: '1.5억~2억', min: 1.5, max: 2 },
  { label: '2억~3억', min: 2, max: 3 },
  { label: '3억~5억', min: 3, max: 5 },
  { label: '5억 이상', min: 5, max: 0 },
];
const ALLOWED_TYPES = ['apartment', 'villa', 'officetel', 'house', 'land', 'commercial', 'other'] as const;

/** 점수/필터 기준 설정 패널(슬라이더·체크박스). cfg는 상위(App)에서 관리. */
export function ConfigPanel({ cfg, setCfg }: { cfg: ScoreConfig; setCfg: (c: ScoreConfig) => void }) {
  const safetyPct = Math.round(cfg.wSafety * 100);
  const toggleRegion = (r: string) => {
    const has = cfg.regionKeywords.includes(r);
    setCfg({ ...cfg, regionKeywords: has ? cfg.regionKeywords.filter((x) => x !== r) : [...cfg.regionKeywords, r] });
  };
  const toggleType = (t: string) => {
    const has = cfg.allowedTypes.includes(t);
    setCfg({ ...cfg, allowedTypes: has ? cfg.allowedTypes.filter((x) => x !== t) : [...cfg.allowedTypes, t] });
  };
  return (
    <div className="cfg">
      <div className="cfg-row cfg-checks">
        <span className="cfg-label">지역</span>
        {REGIONS.map((r) => (
          <label key={r}><input type="checkbox" checked={cfg.regionKeywords.includes(r)} onChange={() => toggleRegion(r)} /> {r}</label>
        ))}
        <span className="muted">(전체 해제 = 제한 없음)</span>
      </div>
      <div className="cfg-row cfg-checks">
        <span className="cfg-label">물건종류</span>
        {ALLOWED_TYPES.map((t) => (
          <label key={t}><input type="checkbox" checked={cfg.allowedTypes.includes(t)} onChange={() => toggleType(t)} /> {TYPE_LABEL[t] ?? t}</label>
        ))}
        <span className="muted">(전체 해제 = 제한 없음)</span>
      </div>
      <div className="cfg-row cfg-checks">
        <span className="cfg-label">가격대</span>
        {PRICE_BANDS.map((b) => {
          const active = cfg.priceMinEok === b.min && cfg.priceMaxEok === b.max;
          return (
            <button key={b.label} className={`band-chip${active ? ' on' : ''}`}
              onClick={() => setCfg({ ...cfg, priceMinEok: active ? 0 : b.min, priceMaxEok: active ? 0 : b.max })}>
              {b.label}
            </button>
          );
        })}
        <span className="muted">(최저매각가 기준)</span>
      </div>
      <div className="cfg-row cfg-checks">
        <span className="cfg-label">최저매각가</span>
        <input type="number" min={0} placeholder="최소" value={cfg.priceMinEok || ''} style={{ width: 72 }}
          onChange={(e) => setCfg({ ...cfg, priceMinEok: Number(e.target.value) || 0 })} /> 억
        <span>~</span>
        <input type="number" min={0} placeholder="최대" value={cfg.priceMaxEok || ''} style={{ width: 72 }}
          onChange={(e) => setCfg({ ...cfg, priceMaxEok: Number(e.target.value) || 0 })} /> 억
        <span className="muted">(0 = 무제한)</span>
      </div>
      <div className="cfg-row cfg-checks">
        <span className="cfg-label">감정가</span>
        <input type="number" min={0} placeholder="최소" value={cfg.apprMinEok || ''} style={{ width: 72 }}
          onChange={(e) => setCfg({ ...cfg, apprMinEok: Number(e.target.value) || 0 })} /> 억
        <span>~</span>
        <input type="number" min={0} placeholder="최대" value={cfg.apprMaxEok || ''} style={{ width: 72 }}
          onChange={(e) => setCfg({ ...cfg, apprMaxEok: Number(e.target.value) || 0 })} /> 억
        <span className="muted">(0 = 무제한)</span>
      </div>
      <div className="cfg-row">
        <label>가중치 — 안전마진 {safetyPct}% : 권리 {100 - safetyPct}%</label>
        <input type="range" min={0} max={100} value={safetyPct}
          onChange={(e) => { const v = +e.target.value / 100; setCfg({ ...cfg, wSafety: v, wClean: 1 - v }); }} />
      </div>
      <div className="cfg-row">
        <label>경쟁도 가중치: {Math.round(cfg.wCompetition * 100)}% <span className="cfg-hint">(조회·관심 낮을수록 가점 — 저경쟁 발굴)</span></label>
        <input type="range" min={0} max={50} value={Math.round(cfg.wCompetition * 100)}
          onChange={(e) => setCfg({ ...cfg, wCompetition: +e.target.value / 100 })} />
      </div>
      <div className="cfg-row">
        <label>통과 최소 안전마진: {(cfg.minSafetyMargin * 100).toFixed(0)}%</label>
        <input type="range" min={0} max={40} value={Math.round(cfg.minSafetyMargin * 100)}
          onChange={(e) => setCfg({ ...cfg, minSafetyMargin: +e.target.value / 100 })} />
      </div>
      <div className="cfg-row">
        <label>통과 최소 진짜마진: {cfg.minTrueSafetyMarginPct <= -99 ? '제한 없음' : `${cfg.minTrueSafetyMarginPct}%`}
          <span className="cfg-hint"> (취득비용 반영 — -99 = 비활성)</span>
        </label>
        <input type="range" min={-99} max={30} value={cfg.minTrueSafetyMarginPct}
          onChange={(e) => setCfg({ ...cfg, minTrueSafetyMarginPct: +e.target.value })} />
      </div>
      <div className="cfg-row">
        <label>허용 위험항목 최대: {cfg.maxDangerCount < 0 ? '제한 없음' : `${cfg.maxDangerCount}건`}
          <span className="cfg-hint"> (공법규제·권리 위험 — -1 = 비활성)</span>
        </label>
        <input type="range" min={-1} max={3} value={cfg.maxDangerCount}
          onChange={(e) => setCfg({ ...cfg, maxDangerCount: +e.target.value })} />
      </div>
      <div className="cfg-row">
        <label>안전마진 만점 기준: {(cfg.safetyMaxAt * 100).toFixed(0)}%</label>
        <input type="range" min={10} max={60} value={Math.round(cfg.safetyMaxAt * 100)}
          onChange={(e) => setCfg({ ...cfg, safetyMaxAt: +e.target.value / 100 })} />
      </div>
      <div className="cfg-row cfg-checks">
        <label><input type="checkbox" checked={cfg.requireCleanRights} onChange={(e) => setCfg({ ...cfg, requireCleanRights: e.target.checked })} /> 인수금액 0만 통과</label>
        <label><input type="checkbox" checked={cfg.includeReviewRequired} onChange={(e) => setCfg({ ...cfg, includeReviewRequired: e.target.checked })} /> 검토필요(특수권리)도 통과에 포함</label>
        <label><input type="checkbox" checked={cfg.requireMarketPrice} onChange={(e) => setCfg({ ...cfg, requireMarketPrice: e.target.checked })} /> 시세 미확보 제외</label>
        <label><input type="checkbox" checked={cfg.excludeSpecialRights} onChange={(e) => setCfg({ ...cfg, excludeSpecialRights: e.target.checked })} /> 특수권리(위험) 제외</label>
        <button onClick={() => setCfg(DEFAULT_CONFIG)}>기본값</button>
      </div>
    </div>
  );
}

```


### `web/src/Legend.tsx`

```tsx
import type { ScoreConfig } from './scoring.ts';

/** 도움말/범례 — 점수 구성·통과 기준·배지 의미를 한 화면에. 대시보드를 self-explanatory하게. */
export function Legend({ cfg }: { cfg: ScoreConfig }) {
  const wSum = (cfg.wSafety + cfg.wClean + cfg.wCompetition) || 1;
  const w = (x: number) => `${Math.round((x / wSum) * 100)}%`;
  return (
    <section className="legend">
      <div className="legend-grid">
        <div className="legend-card">
          <h4>⭐ 점수는 어떻게 나오나</h4>
          <ul>
            <li><b>안전마진</b> {w(cfg.wSafety)} — 진짜 안전마진(취득비용 반영)이 높을수록 ↑</li>
            <li><b>권리 안전</b> {w(cfg.wClean)} — 인수금액·위험등급이 낮을수록 ↑</li>
            <li><b>경쟁도</b> {w(cfg.wCompetition)} — 관심수가 적을수록(남들이 덜 본) ↑</li>
            <li>★무피 후보 가점 · 🔴위험항목 감점</li>
          </ul>
          <p className="muted">가중치·기준은 <b>⚙ 조건</b>에서 조절. 점수에 마우스를 올리면 분해가 보입니다.</p>
        </div>

        <div className="legend-card">
          <h4>✅ "통과" 기준</h4>
          <ul>
            <li>관심 지역 + 허용 물건종류</li>
            <li>진짜 안전마진 ≥ {Math.round(cfg.minSafetyMargin * 100)}%</li>
            <li>인수금액 0원 (낙찰자 추가부담 없음)</li>
            <li>특수권리(유치권·지분 등 위험) 제외{cfg.excludeSpecialRights ? '' : ' — 현재 꺼짐'}</li>
          </ul>
          <p className="muted">상단 <b>🎯 추천</b> 탭 = 통과 매물만 · 점수순. 매일 밤 텔레그램으로도 발송됩니다.</p>
        </div>

        <div className="legend-card">
          <h4>🏷 배지 읽는 법</h4>
          <ul className="legend-chips">
            <li><span className="lowcomp-chip">🔥저경쟁</span> 관심수 적음 — 경쟁 덜한 딜</li>
            <li><span className="zero-pi-chip">★무피</span> 전세보증금≈낙찰가 → 실투자금 적음</li>
            <li><span className="badge reco-consider reco-badge">권장✦</span> AI 보고서 긍정 · <span className="badge reco-avoid reco-badge">⚠회피</span> 통과지만 AI 회피권고</li>
            <li><span className="case-multi-chip">외 N물건</span> 같은 사건 다물건(🗂 사건묶기 ON) </li>
            <li><span className="new-chip">NEW</span> 오늘 신규 수집 · <span className="badge badge-incomplete">등기?</span> 등기 미수집(분석 보류)</li>
            <li>🔴N 위험항목 · 🟡N 주의항목 (입찰 전 확인)</li>
          </ul>
        </div>

        <div className="legend-card">
          <h4>🧭 빠르게 쓰는 법</h4>
          <ul>
            <li>상단 <b>통계 칩</b>(오늘기일·7일이내·무피후보…)은 <b>클릭하면 필터</b>로 동작</li>
            <li><b>정렬</b>에서 <b>🔥 저경쟁순</b>·진짜마진순으로 좋은 딜 발굴</li>
            <li><b>🗂 사건묶기</b>로 한 사건 여러 물건을 1줄로 접어 검토 횟수↓</li>
            <li>행 클릭 → 상세에 <b>🧠 AI 투자 의견서</b>·권리·체크리스트</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

```
