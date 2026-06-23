import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  fetchListings, fetchDetail, fetchLastCrawl, triggerJob, fetchJobStatus, setFavorite,
  fetchFieldworkNotes, saveFieldworkNote, apiBase, won, eok,
  type ListingItem, type RightsObj, type LocationObj,
} from './api.ts';
import { scoreClient, DEFAULT_CONFIG, type ScoreConfig, type ClientScore } from './scoring.ts';
import { acquisitionTaxRate } from './cost.ts';

const TODAY = new Date().toISOString().slice(0, 10);

function saleDaysDiff(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const ms = new Date(dateStr).getTime() - new Date(TODAY).getTime();
  return Math.round(ms / 86_400_000);
}

function DDay({ dateStr }: { dateStr?: string | null }) {
  const d = saleDaysDiff(dateStr);
  if (d === null) return null;
  const label = d === 0 ? 'D-Day' : d < 0 ? `D+${-d}` : `D-${d}`;
  const cls = d <= 0 ? 'dday-urgent' : d <= 3 ? 'dday-warn' : d <= 7 ? 'dday-soon' : 'dday-ok';
  return <span className={`dday ${cls}`} title={dateStr ?? ''}>{label}</span>;
}

// sale_rounds 에서 현재 차수를 결정. 날짜 불일치(분석 이후 재매각기일 갱신) 시 추정.
function resolveRound(rounds: { date: string; round: number }[], saleDate?: string | null, failCount?: number | null): { n: number; est: boolean } | null {
  if (!rounds.length) return null;
  const match = saleDate ? rounds.find((s) => s.date === saleDate) : null;
  if (match) return { n: match.round, est: false };
  const last = rounds[rounds.length - 1]!;
  if (saleDate && last.date < saleDate) {
    // sale_rounds 가 구형(분석 후 sale_date 재갱신) → 최소 last.round+1 차수로 추정
    const n = (failCount != null && failCount > 0) ? failCount + 1 : last.round + 1;
    return { n, est: true };
  }
  return { n: last.round, est: false };
}

const FLAG_LABEL: Record<string, string> = {
  yuchigwon: '유치권', beopjeong_jisangwon: '법정지상권', bunmyo_gijigwon: '분묘기지권',
  daejigwon_mideungi: '대지권미등기', toji_byeoldo_deungi: '토지별도등기',
  jesioe_building: '제시외건물', nongchi: '농취증', senior_tenant: '대항력임차인',
  senior_gadeungi: '선순위가등기', cheolgeo_gacheobun: '건물철거가처분',
};

const TYPE_LABEL: Record<string, string> = {
  apartment: '아파트', villa: '다세대·연립', officetel: '오피스텔',
  house: '단독·다가구', land: '토지', commercial: '상가', other: '기타',
};
const RISK: Record<string, { label: string; cls: string }> = {
  clean: { label: '깨끗', cls: 'risk-clean' },
  caution: { label: '주의', cls: 'risk-caution' },
  risky: { label: '위험', cls: 'risk-risky' },
  review_required: { label: '검토필요', cls: 'risk-review' },
};
const pct = (n: number | null | undefined) => (n == null ? '-' : (n * 100).toFixed(1) + '%');
const CONF: Record<string, string> = { high: '높음', medium: '보통', low: '낮음' };

type SortKey = 'score' | 'safety' | 'trueSafety' | 'sale' | 'price' | 'appraisal' | 'assumed' | 'gap' | 'fieldwork';
const CFG_KEY = 'gm_score_config';
const UI_KEY = 'gm_ui_state';

const SORT_DEFAULT_DIR: Record<SortKey, 'asc' | 'desc'> = {
  score: 'desc', safety: 'desc', trueSafety: 'desc', sale: 'asc',
  price: 'asc', appraisal: 'desc', assumed: 'asc', gap: 'asc', fieldwork: 'desc',
};

/** 임장 진행 가중치: 진행중(체크 일부) > 메모만 > 미시작 > 완료(끝난 건 뒤로). 진행도순 정렬·배지 공용. */
function fieldworkRank(r: ListingItem): number {
  const total = r.field_total ?? 0;
  const done = r.field_done ?? 0;
  const notes = r.field_notes ?? 0;
  if (total > 0 && done >= total) return 1;          // 완료 → 맨 뒤
  if (done > 0) return 1000 + done;                   // 진행중(많이 한 것 우선)
  if (notes > 0) return 500 + notes;                  // 메모만
  return 0;                                            // 미시작
}

/** 임장 진행 배지 — 현장 체크를 시작한 매물에만 표시(미시작은 숨겨 목록을 깔끔히). */
function FieldProgress({ r }: { r: ListingItem }) {
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

/** 마진(진짜마진 우선) → 핀 색. 시세 없으면 회색. */
function marginColor(r: ListingItem): string {
  const tm = r.location?.acquisition_cost?.trueSafetyMargin ?? r.location?.safety_margin ?? null;
  if (tm == null) return '#7a8699';
  if (tm >= 0.3) return '#1ec758';
  if (tm >= 0.1) return '#a3d977';
  if (tm >= 0) return '#f5a623';
  return '#f04545';
}

/** 지도 뷰 — 위경도 있는 매물을 마진색 원형 핀으로. 핀 팝업 → 상세. Leaflet 명령형 제어. */
function MapView({ items, onSelect }: { items: ListingItem[]; onSelect: (r: ListingItem) => void }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  const pts = useMemo(() => items.filter((r) => r.lat != null && r.lng != null), [items]);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { scrollWheelZoom: true, attributionControl: true }).setView([37.55, 126.98], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layer = L.layerGroup().addTo(map);
    const bounds: [number, number][] = [];
    for (const r of pts) {
      const lat = r.lat!, lng = r.lng!;
      bounds.push([lat, lng]);
      const tm = r.location?.acquisition_cost?.trueSafetyMargin ?? r.location?.safety_margin ?? null;
      const m = L.circleMarker([lat, lng], { radius: 8, color: '#0b0e14', weight: 1, fillColor: marginColor(r), fillOpacity: 0.92 });
      m.bindPopup(
        `<div class="map-pop"><b>${r.address}</b><br/><span class="map-pop-sub">${TYPE_LABEL[r.property_type] ?? r.property_type} · ${r.case_no}</span><br/>` +
        `최저가 ${eok(r.min_bid_price)} · 마진 ${tm != null ? (tm * 100).toFixed(1) + '%' : '-'}<br/>` +
        `<button class="map-open" type="button">상세 보기 ›</button></div>`,
      );
      m.on('popupopen', (e) => {
        const root = (e as unknown as { popup: L.Popup }).popup.getElement();
        root?.querySelector<HTMLButtonElement>('.map-open')?.addEventListener('click', () => onSelectRef.current(r));
      });
      m.addTo(layer);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    // 철거된 맵에서 invalidateSize 호출 방지 — 타이머 핸들 정리 + 살아있는지 확인
    const sizeTimer = setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 60);
    return () => { clearTimeout(sizeTimer); layer.remove(); };
  }, [pts]);

  return (
    <div className="map-wrap">
      <div ref={elRef} className="map-canvas" />
      <div className="map-legend">
        <span><i style={{ background: '#1ec758' }} />마진 30%↑</span>
        <span><i style={{ background: '#a3d977' }} />10–30%</span>
        <span><i style={{ background: '#f5a623' }} />0–10%</span>
        <span><i style={{ background: '#f04545' }} />음수</span>
        <span><i style={{ background: '#7a8699' }} />시세없음</span>
      </div>
      <p className="map-count muted">{pts.length}건 표시 · 좌표 없는 {items.length - pts.length}건 제외</p>
    </div>
  );
}

/** 관심 매물 나란히 비교 — slim 데이터만으로 핵심 지표를 표로. 항목별 최우수 셀을 초록 강조. */
function CompareView({ items, cfg, onClose, onSelect }: {
  items: ListingItem[]; cfg: ScoreConfig; onClose: () => void; onSelect: (r: ListingItem) => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  type Row = { label: string; rank?: (r: ListingItem) => number | null; dir?: 'max' | 'min'; cell: (r: ListingItem) => React.ReactNode };
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

function loadConfig(): ScoreConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

type UIState = { sort?: SortKey; sortDir?: 'asc' | 'desc'; type?: string; hideExpired?: boolean; onlyPassed?: boolean; onlyMultiRound?: boolean; hideIncomplete?: boolean };
function loadUIState(): UIState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) return JSON.parse(raw) as UIState;
  } catch { /* ignore */ }
  return {};
}

export default function App() {
  const [rows, setRows] = useState<ListingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [onlyPassed, setOnlyPassed] = useState<boolean>(() => loadUIState().onlyPassed ?? true);
  const [onlyFavorite, setOnlyFavorite] = useState(false);
  const [onlyMultiRound, setOnlyMultiRound] = useState<boolean>(() => loadUIState().onlyMultiRound ?? false);
  const [onlyZeroPi, setOnlyZeroPi] = useState(false);
  const [onlyConsider, setOnlyConsider] = useState(false);
  const [onlyPassedAvoid, setOnlyPassedAvoid] = useState(false);
  const [onlyUrgent, setOnlyUrgent] = useState(false);
  const [onlyToday, setOnlyToday] = useState(false);
  const [filterDate, setFilterDate] = useState<string | null>(null);
  const [maxGapEok, setMaxGapEok] = useState(0);
  const [hideExpired, setHideExpired] = useState<boolean>(() => loadUIState().hideExpired ?? true);
  const [hideIncomplete, setHideIncomplete] = useState<boolean>(() => loadUIState().hideIncomplete ?? false);
  const [type, setType] = useState<string>(() => loadUIState().type ?? 'all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>(() => loadUIState().sort ?? 'score');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(() => loadUIState().sortDir ?? 'desc');
  const [selected, setSelected] = useState<ListingItem | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [cfg, setCfg] = useState<ScoreConfig>(loadConfig);
  const [showCfg, setShowCfg] = useState(false);
  const detailCacheRef = useRef(new Map<string, ListingItem>());
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const jobTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [lastCrawl, setLastCrawl] = useState<string | null>(null);

  const load = () => {
    setLoading(true); setErr(null);
    fetchListings().then(setRows).catch((e) => setErr(String(e))).finally(() => setLoading(false));
    fetchLastCrawl().then((r) => { if (r) setLastCrawl(r.date); });
  };
  useEffect(load, []);
  useEffect(() => { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }, [cfg]);
  useEffect(() => { localStorage.setItem(UI_KEY, JSON.stringify({ sort, sortDir, type, hideExpired, onlyPassed, onlyMultiRound, hideIncomplete })); }, [sort, sortDir, type, hideExpired, onlyPassed, onlyMultiRound, hideIncomplete]);

  const toggleFav = (item: ListingItem) => {
    const nv = !item.is_favorite;
    setRows((rs) => rs.map((r) => (r.id === item.id ? { ...r, is_favorite: nv } : r)));
    // 함수형 업데이트 — 상세 로드로 교체된 최신 selected(전체 데이터)를 slim 으로 덮어쓰지 않도록
    setSelected((cur) => (cur && cur.id === item.id ? { ...cur, is_favorite: nv } : cur));
    // 상세 캐시도 동기화 — 재오픈 시 별 상태가 토글 이전 값으로 되돌아가는 문제 방지
    const cached = detailCacheRef.current.get(item.case_no);
    if (cached) detailCacheRef.current.set(item.case_no, { ...cached, is_favorite: nv });
    setFavorite(item.id, nv).catch(() => load());
  };

  const showJob = (msg: string, ok: boolean, ttl = ok ? 4000 : 7000) => {
    if (jobTimerRef.current) clearTimeout(jobTimerRef.current);
    setJobStatus({ msg, ok });
    if (ttl > 0) jobTimerRef.current = setTimeout(() => setJobStatus(null), ttl);
  };
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  const runJob = (job: 'crawl' | 'analyze' | 'eval' | 'ingest-legal', label: string) => {
    stopPoll();
    showJob(`${label} 시작 중…`, true, 0);
    triggerJob(job)
      .then(() => {
        showJob(`${label} 실행 중…`, true, 0);
        const start = Date.now();
        pollRef.current = setInterval(async () => {
          const elapsed = Math.round((Date.now() - start) / 1000);
          const mins = Math.floor(elapsed / 60), secs = elapsed % 60;
          const elapsedStr = mins > 0 ? `${mins}분 ${secs}초` : `${secs}초`;
          try {
            const st = await fetchJobStatus();
            const s = st[job];
            if (s?.state === 'ok') {
              stopPoll();
              showJob(`✓ ${label} 완료 (${elapsedStr})`, true);
              load();
            } else if (s?.state === 'error') {
              stopPoll();
              showJob(`✕ ${label} 실패`, false);
            } else {
              showJob(`${label} 실행 중… ${elapsedStr}`, true, 0);
            }
          } catch { /* ignore poll errors */ }
        }, 8000);
      })
      .catch((e: unknown) => showJob(`오류: ${e instanceof Error ? e.message : String(e)}`, false));
  };

  const handleSort = (key: SortKey) => {
    if (sort === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setSortDir(SORT_DEFAULT_DIR[key]); }
  };

  const handleSelect = (item: ListingItem) => {
    const cached = detailCacheRef.current.get(item.case_no);
    if (cached) { setSelected(cached); return; }
    setSelected(item);
    setDetailLoading(item.case_no);
    fetchDetail(item.case_no)
      .then((full) => {
        detailCacheRef.current.set(item.case_no, full);
        setSelected((cur) => (cur?.case_no === item.case_no ? full : cur));
      })
      .catch(() => {})
      .finally(() => setDetailLoading((cur) => (cur === item.case_no ? null : cur)));
  };

  const view = useMemo(() => {
    const scored = rows.map((item) => ({ item, sc: scoreClient(item, cfg) }));
    let v = scored;
    // 조건 필터(통과 여부와 무관하게 항상 적용): 지역 · 가격대
    if (cfg.regionKeywords.length) v = v.filter((x) => cfg.regionKeywords.some((k) => x.item.address.includes(k)));
    if (cfg.priceMinEok > 0) v = v.filter((x) => (x.item.min_bid_price ?? 0) >= cfg.priceMinEok * 1e8);
    if (cfg.priceMaxEok > 0) v = v.filter((x) => (x.item.min_bid_price ?? 0) <= cfg.priceMaxEok * 1e8);
    if (cfg.apprMinEok > 0) v = v.filter((x) => (x.item.appraisal_value ?? 0) >= cfg.apprMinEok * 1e8);
    if (cfg.apprMaxEok > 0) v = v.filter((x) => (x.item.appraisal_value ?? 0) <= cfg.apprMaxEok * 1e8);
    if (hideExpired) v = v.filter((x) => !x.item.sale_date || x.item.sale_date >= TODAY);
    if (hideIncomplete) v = v.filter((x) => !x.item.location?.report?.headline?.startsWith('[데이터 불완전]'));
    if (onlyPassed) v = v.filter((x) => x.sc.passed);
    if (onlyFavorite) v = v.filter((x) => x.item.is_favorite);
    if (onlyZeroPi) v = v.filter((x) => x.item.location?.income?.zeroPiCandidate === true);
    if (onlyConsider) v = v.filter((x) => x.item.location?.report?.recommendation === 'consider');
    if (onlyPassedAvoid) v = v.filter((x) => x.sc.passed && x.item.location?.report?.recommendation === 'avoid');
    if (onlyToday) v = v.filter((x) => x.item.sale_date === TODAY);
    if (filterDate) v = v.filter((x) => x.item.sale_date === filterDate);
    if (onlyUrgent) {
      const sevenDaysStr = new Date(new Date(TODAY).getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
      v = v.filter((x) => x.item.sale_date && x.item.sale_date >= TODAY && x.item.sale_date <= sevenDaysStr);
    }
    if (maxGapEok > 0) v = v.filter((x) => {
      const gap = x.item.location?.income?.gapInvestment;
      return gap == null || gap <= maxGapEok * 1e8;
    });
    if (onlyMultiRound) v = v.filter((x) => {
      const rs = x.item.location?.sale_rounds ?? [];
      const rnd = rs.find((s) => s.date === x.item.sale_date)?.round ?? (rs.length > 0 ? rs[rs.length - 1]!.round : null);
      return (rnd != null && rnd >= 2) || (rs.length === 0 && (x.item.fail_count ?? 0) >= 1);
    });
    if (type !== 'all') v = v.filter((x) => x.item.property_type === type);
    if (q.trim()) {
      const qt = q.trim();
      v = v.filter((x) => x.item.address.includes(qt) || x.item.case_no.includes(qt) || (x.item.court ?? '').includes(qt));
    }
    v.sort((a, b) => {
      let diff = 0;
      if (sort === 'safety') diff = (a.item.location?.safety_margin ?? -1) - (b.item.location?.safety_margin ?? -1);
      else if (sort === 'sale') diff = (a.item.sale_date ?? '9999').localeCompare(b.item.sale_date ?? '9999');
      else if (sort === 'trueSafety') diff = (a.item.location?.acquisition_cost?.trueSafetyMargin ?? -1) - (b.item.location?.acquisition_cost?.trueSafetyMargin ?? -1);
      else if (sort === 'price') diff = (a.item.min_bid_price ?? Infinity) - (b.item.min_bid_price ?? Infinity);
      else if (sort === 'appraisal') diff = (a.item.appraisal_value ?? 0) - (b.item.appraisal_value ?? 0);
      else if (sort === 'assumed') diff = (a.item.rights?.assumed_amount ?? 0) - (b.item.rights?.assumed_amount ?? 0);
      else if (sort === 'gap') {
        const ga = a.item.location?.income?.gapInvestment ?? Infinity;
        const gb = b.item.location?.income?.gapInvestment ?? Infinity;
        diff = ga - gb;
      }
      else if (sort === 'fieldwork') diff = fieldworkRank(a.item) - fieldworkRank(b.item);
      else diff = a.sc.totalScore - b.sc.totalScore;
      return sortDir === 'asc' ? diff : -diff;
    });
    return v;
  }, [rows, cfg, hideExpired, hideIncomplete, onlyPassed, onlyFavorite, onlyMultiRound, onlyZeroPi, onlyConsider, onlyPassedAvoid, onlyUrgent, onlyToday, filterDate, maxGapEok, type, q, sort, sortDir]);

  const favCount = rows.filter((r) => r.is_favorite).length;
  const activeTab = showCfg ? 'config' : onlyFavorite ? 'fav' : onlyPassed ? 'recommend' : 'all';
  // 배지 카운트 — 결과를 좁히는 '숨은' 필터(오늘기일·달력일·갭·발품회피 등)까지 포함해야
  // 목록이 비었을 때 원인을 알 수 있다(과거: 절반 누락 → 0건인데 배지 0).
  const activeFilterCount = [
    hideExpired, hideIncomplete, onlyPassed, onlyFavorite, onlyMultiRound,
    onlyZeroPi, onlyConsider, onlyUrgent, onlyPassedAvoid, onlyToday,
    !!filterDate, maxGapEok > 0,
  ].filter(Boolean).length;

  // 모든 필터 초기화(검색어·종류 포함) — 팝오버/빈상태 버튼이 동일하게 사용
  const resetFilters = () => {
    setHideExpired(false); setHideIncomplete(false); setOnlyPassed(false); setOnlyFavorite(false);
    setOnlyMultiRound(false); setOnlyZeroPi(false); setOnlyConsider(false); setOnlyUrgent(false);
    setOnlyPassedAvoid(false); setOnlyToday(false); setFilterDate(null); setMaxGapEok(0);
    setType('all'); setQ('');
  };

  const stats = useMemo(() => {
    const all = rows.map((item) => ({ item, sc: scoreClient(item, cfg) }));
    const upcoming = all.filter((x) => !x.item.sale_date || x.item.sale_date >= TODAY);
    const passed = upcoming.filter((x) => x.sc.passed).length;
    const todayStr = TODAY;
    const todayUrgent = upcoming.filter((x) => x.sc.passed && x.item.sale_date === todayStr).length;
    const week = upcoming.filter((x) => {
      if (!x.sc.passed || !x.item.sale_date) return false;
      const d = saleDaysDiff(x.item.sale_date);
      return d !== null && d >= 0 && d <= 7;
    }).length;
    const reviewCount = upcoming.filter((x) => x.item.rights?.risk_grade === 'review_required').length;
    const zeroPiCount = upcoming.filter((x) => x.item.location?.income?.zeroPiCandidate === true).length;
    const considerCount = upcoming.filter((x) => x.item.location?.report?.recommendation === 'consider').length;
    const passedAvoidCount = upcoming.filter((x) => x.sc.passed && x.item.location?.report?.recommendation === 'avoid').length;
    const incompleteCount = rows.filter((r) => r.location?.report?.headline?.startsWith('[데이터 불완전]')).length;
    const weekDist: Record<string, { total: number; passed: number }> = {};
    for (const x of upcoming) {
      if (!x.item.sale_date) continue;
      const d = saleDaysDiff(x.item.sale_date);
      if (d === null || d < 0 || d > 6) continue;
      const k = x.item.sale_date;
      if (!weekDist[k]) weekDist[k] = { total: 0, passed: 0 };
      weekDist[k]!.total++;
      if (x.sc.passed) weekDist[k]!.passed++;
    }
    return { total: rows.length, passed, todayUrgent, week, reviewCount, zeroPiCount, considerCount, passedAvoidCount, incompleteCount, weekDist };
  }, [rows, cfg]);

  const selNavIdx = selected ? view.findIndex((x) => x.item.id === selected.id) : -1;
  const selNavPrev = selNavIdx > 0 ? () => handleSelect(view[selNavIdx - 1]!.item) : undefined;
  const selNavNext = selNavIdx >= 0 && selNavIdx < view.length - 1 ? () => handleSelect(view[selNavIdx + 1]!.item) : undefined;
  const selNavPos = selNavIdx >= 0 ? `${selNavIdx + 1} / ${view.length}` : undefined;

  return (
    <div className="app">
      <header>
        <h1>경매 매물 분석 <span className="sub">권리분석 · 입지분석</span>{lastCrawl && <span className="crawl-date">데이터 기준 {lastCrawl}</span>}</h1>
        <p className="disclaimer">
          ⚠️ 본 분석은 <b>참고용 정보</b>이며 법률자문이 아닙니다. 정확성을 보장하지 않으며 최종 판단·책임은 이용자에게 있습니다.
          입찰 전 반드시 등기부등본·매각물건명세서·현장 확인 및 변호사/법무사 상담을 권장합니다.
        </p>
      </header>

      {!loading && rows.length > 0 && (
        <div className="stat-banner">
          <div className="stat-item">
            <span className="stat-label">전체</span>
            <b className="stat-num">{stats.total}</b>
          </div>
          <div className="stat-item good">
            <span className="stat-label">통과</span>
            <b className="stat-num">{stats.passed}</b>
          </div>
          {stats.todayUrgent > 0 && (
            <div
              className={`stat-item stat-urgent${onlyToday ? ' on' : ''}`}
              onClick={() => { setOnlyToday((v) => !v); setFilterDate(null); }}
              title="클릭하면 오늘 기일 매물만 표시"
              style={{ cursor: 'pointer' }}
            >
              <span className="stat-label">오늘 기일</span>
              <b className="stat-num">{stats.todayUrgent}</b>
            </div>
          )}
          {stats.week > 0 && (
            <div
              className={`stat-item stat-soon${onlyUrgent ? ' on' : ''}`}
              onClick={() => setOnlyUrgent((v) => !v)}
              title="클릭하면 7일 이내 기일 매물만 표시"
              style={{ cursor: 'pointer' }}
            >
              <span className="stat-label">7일 이내</span>
              <b className="stat-num">{stats.week}</b>
            </div>
          )}
          {stats.reviewCount > 0 && (
            <div
              className={`stat-item stat-review${cfg.includeReviewRequired ? ' on' : ''}`}
              onClick={() => { setCfg((c) => ({ ...c, includeReviewRequired: !c.includeReviewRequired })); setOnlyPassed(true); }}
              title="클릭하면 검토필요 매물을 통과에 포함"
              style={{ cursor: 'pointer' }}
            >
              <span className="stat-label">검토필요</span>
              <b className="stat-num">{stats.reviewCount}</b>
            </div>
          )}
          {stats.zeroPiCount > 0 && (
            <div
              className={`stat-item stat-zeropi${onlyZeroPi ? ' on' : ''}`}
              onClick={() => { setOnlyZeroPi((z) => !z); setOnlyPassed(false); }}
              title="클릭하면 무피(無피) 후보만 표시"
              style={{ cursor: 'pointer' }}
            >
              <span className="stat-label">무피후보★</span>
              <b className="stat-num">{stats.zeroPiCount}</b>
            </div>
          )}
          {stats.considerCount > 0 && (
            <div
              className={`stat-item stat-consider${onlyConsider ? ' on' : ''}`}
              onClick={() => { setOnlyConsider((v) => !v); setOnlyPassed(false); }}
              title="클릭하면 검토 권장 매물만 표시"
              style={{ cursor: 'pointer' }}
            >
              <span className="stat-label">검토권장 ✦</span>
              <b className="stat-num">{stats.considerCount}</b>
            </div>
          )}
          {stats.passedAvoidCount > 0 && (
            <div
              className={`stat-item stat-pass-avoid${onlyPassedAvoid ? ' on' : ''}`}
              onClick={() => { setOnlyPassedAvoid((v) => !v); setOnlyPassed(false); }}
              title={`통과 기준 충족이지만 AI 보고서가 '회피' 권고 — 클릭하면 이 목록만 표시`}
              style={{ cursor: 'pointer' }}
            >
              <span className="stat-label">통과+회피⚠</span>
              <b className="stat-num">{stats.passedAvoidCount}</b>
            </div>
          )}
          {stats.incompleteCount > 0 && (
            <div className="stat-item stat-incomplete" title={`등기 미수집(빌라 ${stats.incompleteCount}건) — 권리분석 보류 상태`}>
              <span className="stat-label">등기미수집</span>
              <b className="stat-num">{stats.incompleteCount}</b>
            </div>
          )}
        </div>
      )}

      {!loading && Object.keys(stats.weekDist).length > 0 && (
        <div className="week-cal">
          {Object.entries(stats.weekDist).sort().map(([date, { total, passed }]) => {
            const d = saleDaysDiff(date);
            const dayLabel = ['일', '월', '화', '수', '목', '금', '토'][new Date(date).getDay()]!;
            const isToday = date === TODAY;
            const isSelected = filterDate === date;
            return (
              <div
                key={date}
                className={`wc-day${isToday ? ' wc-today' : ''}${isSelected ? ' wc-sel' : ''}`}
                onClick={() => { setFilterDate((fd) => fd === date ? null : date); setOnlyToday(false); }}
                title={`${date} ${dayLabel}요일 — 통과 ${passed}건 / 전체 ${total}건`}
              >
                <span className="wc-label">{isToday ? '오늘' : `${dayLabel}${d != null ? `(D-${d})` : ''}`}</span>
                <b className="wc-cnt">{passed}</b>
                <span className="wc-total">/{total}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="controls">
        <details className="filter-menu">
          <summary>🔎 필터{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}</summary>
          <div className="filter-pop">
            <label><input type="checkbox" checked={onlyPassed} onChange={(e) => setOnlyPassed(e.target.checked)} /> 통과만</label>
            <label><input type="checkbox" checked={onlyFavorite} onChange={(e) => setOnlyFavorite(e.target.checked)} /> ★관심만 ({favCount})</label>
            <label><input type="checkbox" checked={onlyConsider} onChange={(e) => setOnlyConsider(e.target.checked)} /> ✦검토권장</label>
            <label><input type="checkbox" checked={onlyZeroPi} onChange={(e) => setOnlyZeroPi(e.target.checked)} /> ★무피후보</label>
            <label><input type="checkbox" checked={onlyUrgent} onChange={(e) => setOnlyUrgent(e.target.checked)} /> ⚡7일이내</label>
            <label><input type="checkbox" checked={onlyMultiRound} onChange={(e) => setOnlyMultiRound(e.target.checked)} /> 2차↑ 유찰</label>
            <div className="filter-sep" />
            <label><input type="checkbox" checked={hideExpired} onChange={(e) => setHideExpired(e.target.checked)} /> 기일경과 숨김</label>
            <label title="등기 미수집(빌라 일부) 제외"><input type="checkbox" checked={hideIncomplete} onChange={(e) => setHideIncomplete(e.target.checked)} /> 등기미수집 제외</label>
            {activeFilterCount > 0 && (
              <button className="filter-clear" onClick={resetFilters}>필터 초기화</button>
            )}
          </div>
        </details>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">전체 종류</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input placeholder="주소·사건번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => handleSort(e.target.value as SortKey)}>
          <option value="score">점수순</option>
          <option value="trueSafety">진짜마진순</option>
          <option value="safety">안전마진순</option>
          <option value="sale">임박순</option>
          <option value="price">최저가순</option>
          <option value="appraisal">감정가순</option>
          <option value="assumed">인수금액순</option>
          <option value="gap">갭(소자본)순</option>
          <option value="fieldwork">🚶 임장 진행도순</option>
        </select>
        <select value={maxGapEok} onChange={(e) => setMaxGapEok(Number(e.target.value))}>
          <option value={0}>갭 제한 없음</option>
          <option value={0.5}>갭 5천만↓</option>
          <option value={1}>갭 1억↓</option>
          <option value={2}>갭 2억↓</option>
          <option value={3}>갭 3억↓</option>
        </select>
        <button onClick={() => setShowCfg((s) => !s)}>{showCfg ? '조건 닫기' : '⚙ 조건·기준'}</button>
        <button onClick={load}>새로고침</button>
        <button onClick={() => runJob('crawl', '크롤')} title="더낙찰옥션 크롤">크롤</button>
        <button onClick={() => runJob('analyze', '분석')} title="분석 실행">분석</button>
        <button onClick={() => exportCSV(view)} title="현재 목록을 CSV로 내보내기">↓ CSV</button>
        {favCount >= 2 && <button className="cmp-btn" onClick={() => setShowCompare(true)} title="관심 매물을 나란히 비교">⚖ 비교 ({favCount})</button>}
        <button className={`viewmode-btn${viewMode === 'map' ? ' on' : ''}`} onClick={() => setViewMode((m) => (m === 'list' ? 'map' : 'list'))} title="목록/지도 전환">
          {viewMode === 'list' ? '🗺 지도' : '📋 목록'}
        </button>
        <span className="count">{view.length}건</span>
      </div>

      {showCfg && <ConfigPanel cfg={cfg} setCfg={setCfg} />}

      {loading && <SkeletonList />}
      {err && <Notice>API 연결 오류: {err} <br />백엔드(<code>{apiBase}</code>) 실행 확인 (<code>server/run.sh</code>).</Notice>}
      {!loading && !err && view.length === 0 && (
        <div className="empty-state">
          <div className="empty-emoji">🔍</div>
          {activeFilterCount > 0 || q.trim() || type !== 'all' || filterDate || onlyToday || maxGapEok > 0 ? (
            <>
              <p>조건에 맞는 매물이 없습니다.</p>
              <button onClick={resetFilters}>모든 필터 초기화</button>
            </>
          ) : (
            <p>표시할 매물이 없습니다. 상단 <b>크롤</b>→<b>분석</b>으로 매물을 수집·분석하세요.</p>
          )}
        </div>
      )}

      {viewMode === 'map' && view.length > 0 && (
        <MapView items={view.map((v) => v.item)} onSelect={handleSelect} />
      )}

      {viewMode === 'list' && view.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th></th><th>사건번호</th><th>종류</th><th>소재지</th>
              <ThSort col="appraisal" cur={sort} dir={sortDir} onSort={handleSort}>감정가</ThSort>
              <ThSort col="price" cur={sort} dir={sortDir} onSort={handleSort}>최저가</ThSort>
              <ThSort col="safety" cur={sort} dir={sortDir} onSort={handleSort}><span title="안전마진 / 진짜마진(취득비용 반영)">마진</span></ThSort>
              <ThSort col="assumed" cur={sort} dir={sortDir} onSort={handleSort}>인수금액</ThSort>
              <th>권리</th>
              <ThSort col="score" cur={sort} dir={sortDir} onSort={handleSort}>점수</ThSort>
              <ThSort col="sale" cur={sort} dir={sortDir} onSort={handleSort}>매각기일</ThSort>
            </tr>
          </thead>
          <tbody>
            {view.map(({ item: r, sc }) => {
              const risk = RISK[r.rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
              return (
                <tr key={r.id} className={`row${r.location?.report?.recommendation === 'consider' ? ' row-consider' : ''}${sc.passed && r.location?.report?.recommendation === 'avoid' ? ' row-pass-avoid' : ''}`}>
                  <td className="star" onClick={() => toggleFav(r)} title="관심">{r.is_favorite ? '★' : '☆'}</td>
                  <td className="mono" onClick={() => handleSelect(r)}>
                    {r.case_no}
                    {r.crawled_at && r.crawled_at.slice(0, 10) >= TODAY && <span className="new-chip" title={`신규 수집: ${r.crawled_at.slice(0, 10)}`}>NEW</span>}
                    <FieldProgress r={r} />
                  </td>
                  <td onClick={() => handleSelect(r)} title={r.area_m2 != null ? `전용 ${r.area_m2.toFixed(1)}㎡` : undefined}>{TYPE_LABEL[r.property_type] ?? r.property_type}</td>
                  <td className="addr" onClick={() => handleSelect(r)}>{r.address}</td>
                  <td className="num" onClick={() => handleSelect(r)}>{eok(r.appraisal_value)}</td>
                  <td className="num" onClick={() => handleSelect(r)}>{eok(r.min_bid_price)}</td>
                  <td className="num safety-cell" onClick={() => handleSelect(r)}>
                    {r.location?.safety_margin == null
                      ? <span className="no-mkt" title="시세 미확보 — 안전마진 산정 불가">?</span>
                      : pct(r.location.safety_margin)}
                    {r.location?.acquisition_cost?.trueSafetyMargin != null && (
                      <span className={`true-margin${(r.location.acquisition_cost.trueSafetyMargin ?? 0) < 0 ? ' neg-margin' : ''}`} title="진짜 안전마진(취득비용 반영)"> / {pct(r.location.acquisition_cost.trueSafetyMargin)}</span>
                    )}
                    {r.location?.market_confidence === 'low' && <span className="conf-dot conf-low" title="시세 추정 신뢰도: 낮음(표본 부족)">●</span>}
                    {r.location?.market_confidence === 'medium' && <span className="conf-dot conf-med" title="시세 추정 신뢰도: 보통">●</span>}
                  </td>
                  <td className="num" onClick={() => handleSelect(r)}>{r.rights ? (r.rights.assumed_amount ? eok(r.rights.assumed_amount) : '0') : '-'}</td>
                  <td onClick={() => handleSelect(r)}>
                    {r.location?.report?.headline?.startsWith('[데이터 불완전]')
                      ? <span className="badge badge-incomplete" title="등기 미수집 — 권리분석 보류(재수집 필요)">등기?</span>
                      : <span className={`badge ${risk.cls}`}>{risk.label}</span>}
                    {r.location?.report?.recommendation === 'consider' && <span className="badge reco-consider reco-badge">권장✦</span>}
                    {sc.passed && r.location?.report?.recommendation === 'avoid' && (
                      <span className="badge reco-avoid reco-badge pass-avoid-badge" title="점수는 통과 기준이지만 AI 보고서가 회피 권고 — 상세 확인 필요">⚠회피</span>
                    )}
                    {(r.location?.report?.dangerCount ?? 0) > 0 && (
                      <span className="danger-cnt-chip" title={`위험항목 ${r.location!.report!.dangerCount}건`}>🔴{r.location!.report!.dangerCount}</span>
                    )}
                    {(r.location?.report?.dangerCount ?? 0) === 0 && (r.location?.report?.warnCount ?? 0) > 0 && (
                      <span className="warn-cnt-chip" title={`주의항목 ${r.location!.report!.warnCount}건`}>🟡{r.location!.report!.warnCount}</span>
                    )}
                  </td>
                  <td className="num" onClick={() => handleSelect(r)} title={sc.reasons.length ? sc.reasons.join(' · ') : undefined}>
                    <b className={sc.totalScore >= 70 ? 'good' : sc.totalScore < 40 ? 'danger' : ''}>{sc.totalScore}</b>
                    {!sc.passed && sc.reasons.length > 0 && <span className="score-fail-hint">{sc.reasons[0]}</span>}
                  </td>
                  <td onClick={() => handleSelect(r)}>
                    <DDay dateStr={r.sale_date} /><span className="sale-date-txt">{r.sale_date ?? '-'}</span>
                    {(() => {
                      const rr = resolveRound(r.location?.sale_rounds ?? [], r.sale_date, r.fail_count);
                      if (!rr || rr.n <= 1) return null;
                      return <span className={`round-badge${rr.est ? ' round-badge-est' : ''}`} style={{ marginLeft: 3 }} title={rr.est ? '분석 후 재매각기일 갱신 — 차수 추정값' : ''}>{rr.n}차{rr.est ? '+' : ''}</span>;
                    })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {viewMode === 'list' && view.length > 0 && (
        <ul className="cards">
          {view.map(({ item: r, sc }, i) => {
            const risk = RISK[r.rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
            const reco = r.location?.report?.recommendation;
            const tm = r.location?.acquisition_cost?.trueSafetyMargin;
            const assumed = r.rights?.assumed_amount ?? 0;
            const rounds = r.location?.sale_rounds ?? [];
            const resolvedRound = resolveRound(rounds, r.sale_date, r.fail_count);
            const currentRound = resolvedRound?.n ?? null;
            const expBid = r.location?.expected_bid_price;
            const isIncomplete = r.location?.report?.headline?.startsWith('[데이터 불완전]') ?? false;
            const passedAvoid = sc.passed && reco === 'avoid';
            return (
              <li
                key={r.id}
                className={`card reco-edge-${reco ?? 'none'}${passedAvoid ? ' card-pass-avoid' : ''}`}
                style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                onClick={() => handleSelect(r)}
              >
                <div className="card-top">
                  <span className="card-addr">{r.address}</span>
                  <span className="card-star" onClick={(e) => { e.stopPropagation(); toggleFav(r); }}>{r.is_favorite ? '★' : '☆'}</span>
                </div>
                <div className="card-sub">
                  <span>{TYPE_LABEL[r.property_type] ?? r.property_type}{r.area_m2 != null ? ` · ${r.area_m2.toFixed(0)}㎡` : ''}</span>
                  <span className="mono">{r.case_no}</span>
                  {isIncomplete
                    ? <span className="badge badge-incomplete" title="등기 미수집 — 권리분석 보류">등기?</span>
                    : <span className={`badge ${risk.cls}`} title={r.rights?.red_flags?.map((f) => f.message).join(' | ')}>{risk.label}</span>}
                  {reco && <span className={`badge ${RECO[reco]?.cls ?? ''}`}>{RECO[reco]?.label ?? reco}</span>}
                  {r.rights?.risk_grade === 'review_required' && (r.rights.red_flags ?? []).slice(0, 2).map((f) => (
                    <span key={f.kind} className="flag-chip" title={f.message}>{FLAG_LABEL[f.kind] ?? f.kind}</span>
                  ))}
                </div>
                <div className="card-metrics">
                  <div><span>감정가</span><b>{eok(r.appraisal_value)}</b></div>
                  <div><span>최저가{currentRound && currentRound > 1 ? ` (${currentRound}차)` : ''}</span><b>{eok(r.min_bid_price)}</b></div>
                  <div><span>안전마진</span><b>{pct(r.location?.safety_margin)}</b></div>
                  {expBid ? <div><span>예상낙찰가</span><b className="good">{eok(expBid)}</b></div>
                    : <div><span>진짜마진</span><b className={(tm ?? 0) < 0 ? 'danger' : 'good'}>{pct(tm)}</b></div>}
                </div>
                <div className="card-foot">
                  <span className="card-score">점수 <b>{sc.totalScore}</b></span>
                  {assumed > 0 && <span className="card-assumed">인수 {eok(assumed)}</span>}
                  {r.location?.income?.zeroPiCandidate && <span className="zero-pi-chip">★무피</span>}
                  {currentRound && currentRound > 1 && <span className="round-badge">{currentRound}차 진행</span>}
                  <FieldProgress r={r} />
                  <DDay dateStr={r.sale_date} />
                  <span className="card-go">자세히 ›</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {selected && <Detail
        row={selected} onClose={() => setSelected(null)} onFav={() => toggleFav(selected)}
        loading={detailLoading === selected.case_no}
        onPrev={selNavPrev} onNext={selNavNext} position={selNavPos}
      />}

      {showCompare && (
        <CompareView
          items={rows.filter((r) => r.is_favorite)}
          cfg={cfg}
          onClose={() => setShowCompare(false)}
          onSelect={handleSelect}
        />
      )}

      {jobStatus && (
        <div className={`job-toast${jobStatus.ok ? '' : ' job-toast-err'}`} onClick={() => setJobStatus(null)}>
          {jobStatus.msg}
        </div>
      )}

      <nav className="tabbar">
        <button className={activeTab === 'recommend' ? 'on' : ''} onClick={() => { setShowCfg(false); setOnlyFavorite(false); setOnlyPassed(true); window.scrollTo(0, 0); }}>
          <span className="tb-ico">🎯</span>추천
        </button>
        <button className={activeTab === 'all' ? 'on' : ''} onClick={() => { setShowCfg(false); setOnlyFavorite(false); setOnlyPassed(false); window.scrollTo(0, 0); }}>
          <span className="tb-ico">📋</span>전체
        </button>
        <button className={activeTab === 'fav' ? 'on' : ''} onClick={() => { setShowCfg(false); setOnlyFavorite(true); window.scrollTo(0, 0); }}>
          <span className="tb-ico">★</span>관심{favCount > 0 && <i className="tb-badge">{favCount}</i>}
        </button>
        <button className={activeTab === 'config' ? 'on' : ''} onClick={() => setShowCfg((s) => !s)}>
          <span className="tb-ico">⚙</span>조건
        </button>
      </nav>
    </div>
  );
}

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

function ConfigPanel({ cfg, setCfg }: { cfg: ScoreConfig; setCfg: (c: ScoreConfig) => void }) {
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
        <button onClick={() => setCfg(DEFAULT_CONFIG)}>기본값</button>
      </div>
    </div>
  );
}

function exportCSV(rows: Array<{ item: ListingItem; sc: ClientScore }>) {
  const BOM = '﻿'; // Excel Korean UTF-8 BOM
  const headers = [
    '사건번호', '종류', '면적(㎡)', '주소', '법원', '감정가(만원)', '최저가(만원)',
    '안전마진%', '인수금액(만원)', '권리등급', '점수', '통과', '미통과사유', '매각기일',
    '추정시세(만원)', '진짜마진%', '전세시세(만원)', '갭(만원)', '수익률%',
    '현재차수', '예상낙찰가(만원)', 'AI권고', '위험항목수', '주의항목수', '등기미수집', '관심',
  ];
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

  const csv = BOM + [headers.map(esc).join(','), ...lines].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `경매분석_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 목록 로딩 스켈레톤 — 빈 화면 대신 shimmer 행으로 체감 지연 완화. */
function SkeletonList() {
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

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="notice">{children}</div>;
}

function Detail({ row, onClose, onFav, loading, onPrev, onNext, position }: {
  row: ListingItem; onClose: () => void; onFav: () => void;
  loading?: boolean; onPrev?: () => void; onNext?: () => void; position?: string;
}) {
  const rights: RightsObj | null = row.rights;
  const loc: LocationObj | null = row.location;
  const risk = RISK[rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };

  const [copied, setCopied] = useState(false);
  const [fieldMode, setFieldMode] = useState(false);
  const fieldwork = loc?.report?.fieldwork;
  useEffect(() => { setFieldMode(false); }, [row.case_no]); // 매물 바뀌면 현장모드 해제
  const copyCase = () => {
    navigator.clipboard.writeText(row.case_no).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && onPrev) { e.preventDefault(); onPrev(); }
      if (e.key === 'ArrowRight' && onNext) { e.preventDefault(); onNext(); }
      if (e.key === 'o' && row.source_url && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as Element)?.tagName)) {
        e.preventDefault();
        window.open(row.source_url, '_blank', 'noopener,noreferrer');
      }
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as Element)?.tagName)) {
        e.preventDefault();
        copyCase();
      }
      if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as Element)?.tagName)) {
        e.preventDefault();
        onFav();
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose, onPrev, onNext, row.source_url, row.case_no, onFav]);

  const detailRounds = loc?.sale_rounds ?? [];
  const detailResolvedRound = resolveRound(detailRounds, row.sale_date, row.fail_count);
  const currentRound = detailResolvedRound?.n ?? null;

  return (
    <div className="drawer-bg" onClick={onClose}>
      <aside className={`drawer${fieldMode ? ' drawer-fieldmode' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-topbar">
          <div className="drawer-nav">
            <button className="nav-btn" disabled={!onPrev} onClick={onPrev} title="이전 (←)">‹</button>
            {position && <span className="nav-pos">{position}</span>}
            <button className="nav-btn" disabled={!onNext} onClick={onNext} title="다음 (→)">›</button>
          </div>
          {fieldwork && (
            <button className={`fieldmode-btn${fieldMode ? ' on' : ''}`} onClick={() => setFieldMode((v) => !v)} title="현장에서 체크리스트만 크게 보기">
              🚶 {fieldMode ? '분석 보기' : '현장모드'}
            </button>
          )}
          <button className="close" onClick={onClose}>✕</button>
        </div>

        {fieldMode && fieldwork && (
          <div className="fieldmode">
            <h2><span className="star" onClick={onFav}>{row.is_favorite ? '★' : '☆'}</span> {row.case_no}</h2>
            <p className="addr">{row.address} · {TYPE_LABEL[row.property_type]}</p>
            {row.source_url && <p className="srclink"><a href={row.source_url} target="_blank" rel="noopener noreferrer">🔗 원본 상세페이지 ↗</a></p>}
            <FieldVisitChecklist listingId={row.id} items={fieldwork.fieldChecklist} big />
          </div>
        )}
        {loading && <p className="detail-loading">상세 분석 불러오는 중…</p>}
        <h2>
          <span className="star" onClick={onFav} title="관심 (단축키: f)">{row.is_favorite ? '★' : '☆'}</span>{' '}
          {row.case_no}{' '}
          <button className="copy-btn" onClick={copyCase} title="사건번호 복사 (단축키: c)">{copied ? '✓' : '⧉'}</button>{' '}
          <span className={`badge ${risk.cls}`}>{risk.label}</span>
        </h2>
        <p className="addr">{row.address} · {TYPE_LABEL[row.property_type]} · {row.court}</p>
        {row.source_url && (
          <p className="srclink"><a href={row.source_url} target="_blank" rel="noopener noreferrer">🔗 원본 상세페이지에서 더블체크 ↗</a> <span className="key-hint" title="단축키">o</span></p>
        )}
        {row.source === 'courtauction' && (
          <div className="court-notice" role="alert">
            ⚠️ <strong>법원경매 원천</strong> — 등기부·임차인 데이터가 제공되지 않습니다. 권리분석은 참고 불가하며, 입찰 전 반드시 <a href="https://www.courtauction.go.kr" target="_blank" rel="noopener noreferrer">법원경매정보</a>에서 직접 확인하세요.
          </div>
        )}
        {loc?.photos && loc.photos.length > 0 && (
          <div className="gallery">
            {loc.photos.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noopener noreferrer" className="gphoto">
                <img src={src} loading="lazy" alt={`매물 사진 ${i + 1}`} />
              </a>
            ))}
          </div>
        )}

        <div className="kv">
          <div><span>감정가</span><b>{eok(row.appraisal_value)}</b></div>
          <div><span>최저매각가</span><b>{eok(row.min_bid_price)}</b></div>
          {row.area_m2 != null && <div><span>전용면적</span><b>{row.area_m2.toFixed(2)}㎡{` (${(row.area_m2 / 3.3058).toFixed(1)}평)`}</b></div>}
          <div><span>매각기일</span><b>{row.sale_date ?? '-'}</b></div>
          {currentRound != null && (
            <div><span>현재 차수</span><b className={currentRound > 1 ? 'danger' : ''} title={detailResolvedRound?.est ? '분석 후 재매각기일 갱신 — 차수 추정값' : ''}>{currentRound}차{detailResolvedRound?.est ? '+' : ''}{currentRound > 1 ? ` · 유찰 ${currentRound - 1}회${detailResolvedRound?.est ? '~' : ''}` : ''}</b></div>
          )}
          <div><span>추정시세</span><b>{loc?.market_price == null ? <span className="muted">미확보 — 안전마진 산정 불가</span> : <>{eok(loc.market_price)}{loc.market_confidence ? ` · 신뢰도 ${CONF[loc.market_confidence]}` : ''}</>}</b></div>
          <div><span>예상낙찰가</span><b>{eok(loc?.expected_bid_price)}</b></div>
          <div><span>안전마진(최저가)</span><b>{pct(loc?.safety_margin)}</b></div>
          <div><span title="시세 − 총취득비용(취득세·명도비·채권·인수 포함)">진짜 안전마진</span><b className={(loc?.acquisition_cost?.trueSafetyMargin ?? 0) < 0 ? 'danger' : ''}>{pct(loc?.acquisition_cost?.trueSafetyMargin)}</b></div>
          <div><span>총 인수금액</span><b className={rights?.assumed_amount ? 'danger' : ''}>{won(rights?.assumed_amount ?? 0)}</b></div>
          <div><span>최대안전입찰가</span><b>{won(rights?.max_safe_bid)}</b></div>
        </div>

        {/* 목록(slim) report에는 checklist/fieldwork가 없음 → 풀 상세 로드 후에만 렌더(빈 드로어 크래시 방지) */}
        {loc?.report && Array.isArray(loc.report.checklist) && <ReportBlock report={loc.report} listingId={row.id} />}

        <Section title="권리분석">
          <p className="muted">말소기준권리: {rights?.malso_basis?.note ?? '-'}</p>
          {rights?.assumed_breakdown && rights.assumed_breakdown.length > 0 && (
            <ul className="list">
              {rights.assumed_breakdown.map((b, i) => (
                <li key={i}><b className="danger">{won(b.amount)}</b> — {b.label}: {b.reason}</li>
              ))}
            </ul>
          )}
          {rights?.classified && (
            <table className="mini">
              <thead><tr><th>권리</th><th>접수일</th><th>처리</th><th>근거</th></tr></thead>
              <tbody>
                {rights.classified.map((c, i) => (
                  <tr key={i}>
                    <td>{c.entry.kind}</td><td className="mono">{c.entry.receiptDate}</td>
                    <td>{c.disposition === 'assumed' ? <span className="danger">인수</span> : '소멸'}</td>
                    <td className="muted">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rights?.tenants && rights.tenants.length > 0 && (
            <div className="tenants">
              <h4>임차인</h4>
              {rights.tenants.map((t, i) => (
                <div key={i} className="tenant">
                  {t.tenant.name ?? '임차인'} · 보증금 {won(t.tenant.deposit)} ·
                  {t.hasOpposition ? <span className="danger"> 대항력 있음</span> : ' 대항력 없음'}
                  {t.isSmallTenant ? ' · 소액임차인' : ''}
                </div>
              ))}
            </div>
          )}
          {rights?.red_flags && rights.red_flags.length > 0 && (
            <div className="flags">
              {rights.red_flags.map((f, i) => <span key={i} className={`flag flag-${f.severity}`}>{f.message}</span>)}
            </div>
          )}
          {rights?.warnings && rights.warnings.length > 0 && (
            <ul className="warns">{rights.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
        </Section>

        {loc?.acquisition_cost?.bidPrice && <CostCalculator row={row} loc={loc} />}
        {loc?.income && <IncomeBlock income={loc.income} />}
        {loc?.eviction && <EvictionBlock ev={loc.eviction} />}

        {loc?.land_use_flags && loc.land_use_flags.length > 0 && (
          <Section title="토지이용 규제 · 이슈">
            <div className="flags">
              {loc.land_use_flags.map((f, i) => (
                <span key={i} className={`flag flag-luf-${f.kind}`} title={f.impact}>
                  {f.kind === 'opportunity' ? '🟢' : f.kind === 'risk' ? '🔴' : 'ℹ️'} {f.label}
                </span>
              ))}
            </div>
            <ul className="warns">
              {loc.land_use_flags.filter((f) => f.kind !== 'info' && f.impact).map((f, i) => (
                <li key={i}><b>{f.label}</b>: {f.impact}</li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="입지분석">
          {loc?.comp_basis && <p className="muted">시세 비교군: {loc.comp_basis}</p>}
          <div className="kv">
            <div><span>최근접역</span><b>{loc?.transit?.nearestStation ?? '-'}{loc?.transit?.walkMinutes ? ` (도보 ${loc.transit.walkMinutes}분)` : ''}</b></div>
            <div><span>학교/학원</span><b>{loc?.schools?.schoolCount ?? '-'} / {loc?.schools?.academyCount ?? '-'}</b></div>
          </div>
          {loc?.transit?.stations && loc.transit.stations.length > 0 && (
            <div className="amen">{loc.transit.stations.map((s, i) => <span key={i}>{s.line} {s.station} {s.distanceM}m</span>)}</div>
          )}
          {loc?.building && (
            <p className="muted">
              건물: {loc.building.mainUse ?? ''} {loc.building.households ? `${loc.building.households}세대` : ''}
              {loc.building.approvalDate ? ` · 사용승인 ${loc.building.approvalDate}` : ''}
              {loc.building.floorsAbove ? ` · 지상${loc.building.floorsAbove}/지하${loc.building.floorsBelow ?? 0}층` : ''}
              {loc.building.far ? ` · 용적률 ${loc.building.far}%` : ''}
            </p>
          )}
          {loc?.site_comps && loc.site_comps.length > 0 && (
            <>
              <h4>동일건물 실거래 (사이트)</h4>
              <table className="mini">
                <thead><tr><th>계약월</th><th>전용</th><th>층</th><th className="num">거래가</th></tr></thead>
                <tbody>
                  {loc.site_comps.slice(0, 8).map((c, i) => (
                    <tr key={i}><td className="mono">{c.dealYm}</td><td>{c.areaM2}㎡{c.pyeong ? `(${c.pyeong}평)` : ''}</td><td>{c.floor ?? '-'}</td><td className="num">{(c.dealManwon / 10000).toFixed(2)}억</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {loc?.sale_rounds && loc.sale_rounds.length > 0 && (
            <>
              <h4>매각기일 차수</h4>
              <div className="amen">{loc.sale_rounds.map((s, i) => <span key={i} className={i === 0 ? 'flag-high' : ''}>{s.round}차 {s.date} {eok(s.minPrice)}{s.ratioPct ? ` (${s.ratioPct}%↓)` : ''}</span>)}</div>
            </>
          )}
          {loc?.expected_bid_basis && <p className="muted">예상낙찰가 근거: {loc.expected_bid_basis}</p>}
          {loc?.amenities && (
            <div className="amen">{Object.entries(loc.amenities).map(([k, v]) => <span key={k}>{k}: {v}</span>)}</div>
          )}
          {loc?.dev_signals && loc.dev_signals.length > 0 && (
            <div className="amen">{loc.dev_signals.map((s, i) => <span key={i}>{s}</span>)}</div>
          )}
          {loc?.admin_offices && Object.keys(loc.admin_offices).length > 0 && (
            <p className="muted">관할: {Object.entries(loc.admin_offices).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
          )}
        </Section>
        <div className="drawer-shortcuts">
          <span title="이전 매물">← 이전</span>
          <span title="다음 매물">→ 다음</span>
          <span title="관심 토글">f 관심</span>
          <span title="원본 페이지 열기">o 원본</span>
          <span title="사건번호 복사">c 복사</span>
          <span title="닫기">Esc 닫기</span>
        </div>
      </aside>
    </div>
  );
}

function ThSort({ col, cur, dir, onSort, children }: {
  col: SortKey; cur: SortKey; dir: 'asc' | 'desc'; onSort: (c: SortKey) => void; children: React.ReactNode;
}) {
  const active = col === cur;
  return (
    <th className={`sortable${active ? ' sorted' : ''}`} onClick={() => onSort(col)}>
      {children}{active ? <span className="sort-ind">{dir === 'asc' ? ' ↑' : ' ↓'}</span> : null}
    </th>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="sect"><h3>{title}</h3>{children}</section>;
}

const DIFF: Record<string, { label: string; cls: string }> = {
  easy: { label: '쉬움', cls: 'reco-consider' }, medium: { label: '보통', cls: 'reco-caution' }, hard: { label: '어려움', cls: 'reco-avoid' },
};
/** 명도 난이도·인도명령·비용/기간 */
function EvictionBlock({ ev }: { ev: import('./api.ts').EvictionObj }) {
  const d = DIFF[ev.difficulty] ?? DIFF.medium!;
  return (
    <Section title="명도 난이도">
      <p className="report-head">{ev.occupantLabel} · <span className={`badge ${d.cls}`}>{d.label}</span> · {ev.remedyLabel}{ev.writEligible ? '(인도명령 가능)' : ''}</p>
      <p className="muted">{ev.reason}</p>
      <div className="kv">
        <div><span>예상 명도비</span><b>{eok(ev.costBase)} <span className="muted">({won(ev.costLow)}~{won(ev.costHigh)})</span></b></div>
        <div><span>예상 기간</span><b>{ev.monthsLow}~{ev.monthsHigh}개월</b></div>
      </div>
      <p className="muted">🤝 협상: {ev.negotiationBrief}</p>
      {ev.laws.length > 0 && <p className="lrf-laws">근거: {ev.laws.map((l) => `${l.name}${l.article ? ' ' + l.article : ''}`).join(' · ')}</p>}
      {ev.notes.length > 0 && <ul className="warns">{ev.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </Section>
  );
}

/** 임대수익·출구(양도세) — '이거 사면 돈 되나' */
function IncomeBlock({ income: inc }: { income: import('./api.ts').IncomeObj }) {
  const pctv = (n: number | null) => (n == null ? '-' : n.toFixed(1) + '%');
  return (
    <Section title={`임대수익 · 출구 (세후)${inc.estimated ? ' · 추정' : ''}`}>
      {inc.zeroPiCandidate && !inc.estimated && (
        <p className="zero-pi-badge">★ 무피(無피) 가능성 — 전세보증금이 총취득비용을 충당. 자기 자본 투입 최소화 가능(현장·보증보험 확인 필요)</p>
      )}
      {inc.zeroPiCandidate && inc.estimated && (
        <p className="zero-pi-badge">★ 무피(無피) 가능성 (추정) — 전세가율 가정 기준 갭이 0 이하. 실제 전세 시세 확인 시 무피 투자 구조 가능성 있음(현장·보증보험 필수 확인)</p>
      )}
      {inc.estimated && <p className="warn-badge">⚠ 전월세 실거래 미확보 — 전세가율 가정 기반 <b>추정치</b>(저신뢰). 갭만 참고하고 실제 임대시세는 별도 확인하세요.</p>}
      <p className="muted">임대시세: {inc.rentBasis || '표본 부족'}</p>
      <div className="kv">
        {inc.jeonseDeposit != null && <div><span>전세 시세{inc.estimated ? '(추정)' : ''}</span><b>{eok(inc.jeonseDeposit)}</b></div>}
        {inc.jeonseRatioPct != null && <div><span>전세가율</span><b>{pctv(inc.jeonseRatioPct)}</b></div>}
        {inc.gapInvestment != null && <div><span title="총취득비용 − 전세보증금">갭(전세 실투자)</span><b className={inc.gapInvestment <= 0 ? 'good' : ''}>{eok(inc.gapInvestment)}</b></div>}
        {inc.monthlyRent != null && <div><span>월세 시세</span><b>{won(inc.monthlyRent)}</b></div>}
        {inc.grossYieldPct != null && <div><span>표면 수익률</span><b className={inc.grossYieldPct >= 4 ? 'good' : ''}>{pctv(inc.grossYieldPct)}</b></div>}
        {inc.monthlyCashflow != null && <div><span>월 현금흐름</span><b className={inc.monthlyCashflow < 0 ? 'danger' : 'good'}>{won(inc.monthlyCashflow)}</b></div>}
        {inc.hiddenTenantDeposit != null && <div><span className="danger">점유 임차인 보증금(추정)</span><b className="danger">{eok(inc.hiddenTenantDeposit)}</b></div>}
      </div>
      {(inc.saleScenarios?.length ?? 0) > 0 && (
        <>
          <h4>보유기간별 세후 매도 순익 (시세 동결 가정)</h4>
          <table className="mini">
            <thead><tr><th>보유</th><th>장특공</th><th className="num">양도세</th><th className="num">세후 순익</th></tr></thead>
            <tbody>
              {inc.saleScenarios.map((s) => (
                <tr key={s.holdYears}>
                  <td>{s.holdYears}년</td><td>{(s.ltdRate * 100).toFixed(0)}%</td>
                  <td className="num">{won(s.yangdoTax)}</td>
                  <td className="num"><b className={s.netCashProfit < 0 ? 'danger' : 'good'}>{eok(s.netCashProfit)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {(inc.notes?.length ?? 0) > 0 && <ul className="warns">{inc.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </Section>
  );
}

const RECO: Record<string, { label: string; cls: string }> = {
  consider: { label: '검토 권장', cls: 'reco-consider' },
  caution: { label: '주의 검토', cls: 'reco-caution' },
  avoid: { label: '신중·회피', cls: 'reco-avoid' },
};
const CAT_LABEL: Record<string, string> = {
  등기인수: '등기·인수', 임차인배당: '임차인·배당', 물건하자: '물건 하자', 공법규제: '공법 규제', 절차비용: '절차·비용',
};
const SEV_ICON: Record<string, string> = { danger: '🔴', warn: '🟡', info: 'ℹ️' };
const LRISK: Record<string, { label: string; cls: string }> = {
  manageable: { label: '감당 가능', cls: 'reco-consider' },
  caution: { label: '주의', cls: 'reco-caution' },
  severe: { label: '리스크 큼', cls: 'reco-avoid' },
  avoid: { label: '회피', cls: 'reco-avoid' },
};

/** 매물별 종합 보고서 + 입찰 전 필수 확인사항 */
/**
 * 현장 임장 체크리스트 — 매물 맞춤 확인 항목별로 체크 + 메모.
 * 입력은 gm_fieldwork_notes(매물ID, 항목라벨)에 저장돼 매일 재분석에도 보존된다.
 * 체크 토글은 즉시 저장, 메모는 입력 후 포커스 해제(blur) 시 저장.
 */
function FieldVisitChecklist({ listingId, items, big }: {
  listingId: number; items: { label: string; why: string }[]; big?: boolean;
}) {
  const [state, setState] = useState<Record<string, { checked: boolean; note: string }>>({});
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setState({});
    fetchFieldworkNotes(listingId)
      .then((notes) => {
        if (!active) return;
        const m: Record<string, { checked: boolean; note: string }> = {};
        for (const n of notes) m[n.item_key] = { checked: n.checked, note: n.note };
        setState(m);
      })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [listingId]);

  const cur = (key: string) => state[key] ?? { checked: false, note: '' };
  const persist = (key: string, next: { checked: boolean; note: string }) => {
    saveFieldworkNote(listingId, key, next.checked, next.note)
      .then(() => {
        setError(false);
        setSavedKey(key);
        setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1400);
      })
      .catch(() => setError(true));
  };
  const toggle = (key: string) => {
    const next = { ...cur(key), checked: !cur(key).checked };
    setState((s) => ({ ...s, [key]: next }));
    persist(key, next);
  };
  const editNote = (key: string, note: string) =>
    setState((s) => ({ ...s, [key]: { ...cur(key), note } }));
  const blurNote = (key: string) => persist(key, cur(key));

  const doneCount = items.filter((it) => cur(it.label).checked).length;

  return (
    <div className={big ? 'fw-list fw-big' : 'fw-list'}>
      <h4>🚶 현장 가서 이것만 확인하세요
        <span className={`fw-progress${doneCount === items.length ? ' fw-progress-done' : ''}`}>
          {doneCount}/{items.length} 확인
        </span>
        {error && <span className="fw-err" title="저장 실패 — 다시 시도하세요">⚠ 저장 오류</span>}
      </h4>
      {items.map((f) => {
        const c = cur(f.label);
        return (
          <div key={f.label} className={`fw-item fw-check${c.checked ? ' fw-checked' : ''}`}>
            <label className="fw-row">
              <input type="checkbox" checked={c.checked} onChange={() => toggle(f.label)} />
              <span className="fw-label"><b>{f.label}</b><div className="muted">{f.why}</div></span>
              {savedKey === f.label && <span className="fw-saved">저장됨 ✓</span>}
            </label>
            <textarea
              className="fw-note"
              rows={2}
              placeholder="현장 메모 (예: 천장 모서리 누수 흔적 / 점유자 부재·우편물 쌓임 / 미납 관리비 32만원 …)"
              value={c.note}
              onChange={(e) => editNote(f.label, e.target.value)}
              onBlur={() => blurNote(f.label)}
            />
          </div>
        );
      })}
      <p className="muted" style={{ marginTop: 8 }}>※ 체크·메모는 자동 저장됩니다(메모는 입력 후 칸 밖을 클릭하면 저장). 매물별로 보관돼 재분석에도 유지됩니다.</p>
    </div>
  );
}

function ReportBlock({ report, listingId }: { report: import('./api.ts').ReportObj; listingId: number }) {
  const reco = RECO[report.recommendation] ?? RECO.caution!;
  const danger = report.checklist.filter((c) => c.severity === 'danger');
  const warn = report.checklist.filter((c) => c.severity === 'warn');
  const info = report.checklist.filter((c) => c.severity === 'info');
  return (
    <>
      <section className="sect report-sect">
        <h3>종합 보고서 <span className={`badge ${reco.cls}`}>{reco.label}</span></h3>
        <p className="report-head">{report.headline}</p>
        <ul className="report-sum">{report.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
        <p className="muted"><b>권리</b> {report.rightsSummary}</p>
        <p className="muted"><b>입지</b> {report.locationSummary}</p>
        <p className="muted"><b>비용</b> {report.costSummary}</p>
      </section>

      {report.fieldwork && (
        <Section title={`발품 절감 — 원격 분석 ${report.fieldwork.legworkSavedPct}% 완료`}>
          <div className="fw-bar"><div className="fw-fill" style={{ width: `${report.fieldwork.legworkSavedPct}%` }} /></div>
          <div className="fw-done">
            {report.fieldwork.remoteDone.map((r, i) => (
              <span key={i} className={r.ok ? 'fw-ok' : 'fw-no'}>{r.ok ? '✓' : '·'} {r.label}</span>
            ))}
          </div>
          <FieldVisitChecklist listingId={listingId} items={report.fieldwork.fieldChecklist} />
        </Section>
      )}

      {report.legalRisk && (
        <section className="sect">
          <h3>법적 리스크 평가 <span className={`badge ${LRISK[report.legalRisk.grade]?.cls ?? ''}`}>{LRISK[report.legalRisk.grade]?.label ?? report.legalRisk.grade}</span>
            <span className={`mng ${report.legalRisk.manageable ? 'mng-ok' : 'mng-no'}`}>{report.legalRisk.manageable ? '감당 가능' : '감당 어려움'}</span>
          </h3>
          <p className="muted">{report.legalRisk.reasoning}</p>
          {report.legalRisk.factors.map((f, i) => (
            <div key={i} className="lrf">
              <div className="lrf-head"><b>{f.label}</b> <span className={`tag tag-${f.itemRisk}`}>{f.itemRisk}</span></div>
              {f.laws.length > 0 && <div className="lrf-laws">근거: {f.laws.map((l) => `${l.name}${l.article ? ' ' + l.article : ''}`).join(' · ')}</div>}
              {f.action && <div className="lrf-act">→ {f.action}</div>}
            </div>
          ))}
          <p className="muted">※ 법령 매칭은 법제처 코퍼스 기반 참고용. 최종 판단은 등기부·명세서 원본과 전문가 확인.</p>
        </section>
      )}

      <Section title={`입찰 전 필수 확인사항 (위험 ${report.dangerCount} · 주의 ${report.warnCount})`}>
        {[...danger, ...warn, ...info].map((c) => (
          <div key={c.id} className={`chk chk-${c.severity}`}>
            <div className="chk-head">
              <span className="chk-sev">{SEV_ICON[c.severity]}</span>
              <b>{c.label}</b>
              <span className="chk-cat">{CAT_LABEL[c.category] ?? c.category}</span>
            </div>
            <div className="chk-detail">{c.detail}</div>
            <div className="chk-verify">📋 출처 {c.source}{c.verify ? ` · 확인: ${c.verify}` : ''}</div>
          </div>
        ))}
        {!report.checklist.length && <p className="muted">특이 확인사항 없음.</p>}
        <p className="muted" style={{ marginTop: 10 }}>※ 참고용 자동 분석. 입찰 전 원본 공부서류(등기부·매각물건명세서·현황조사서)를 반드시 직접 확인하세요.</p>
      </Section>

      {report.glossary && report.glossary.length > 0 && (
        <details className="sect glossary">
          <summary>📖 초보자 용어 풀이 ({report.glossary.length})</summary>
          {report.glossary.map((g) => (
            <div key={g.term} className="gl-item">
              <b>{g.term}</b> <span className="gl-cat">{g.category}</span>
              <div className="gl-easy">{g.easy}</div>
              <div className="gl-why">💡 {g.why}</div>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

/** 희망 낙찰가 입력 → 취득세·총취득비용·진짜 안전마진 실시간 계산기 (더낙찰옥션 추가비용표 + 순마진). */
function CostCalculator({ row, loc }: { row: ListingItem; loc: LocationObj }) {
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
