import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchListings, fetchDetail, triggerJob, setFavorite, apiBase, won, eok,
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

type SortKey = 'score' | 'safety' | 'sale' | 'price';
const CFG_KEY = 'gm_score_config';

function loadConfig(): ScoreConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

export default function App() {
  const [rows, setRows] = useState<ListingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [onlyPassed, setOnlyPassed] = useState(true);
  const [onlyFavorite, setOnlyFavorite] = useState(false);
  const [onlyMultiRound, setOnlyMultiRound] = useState(false);
  const [type, setType] = useState('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('score');
  const [selected, setSelected] = useState<ListingItem | null>(null);
  const [cfg, setCfg] = useState<ScoreConfig>(loadConfig);
  const [showCfg, setShowCfg] = useState(false);
  const detailCacheRef = useRef(new Map<string, ListingItem>());
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const jobTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = () => {
    setLoading(true); setErr(null);
    fetchListings().then(setRows).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  };
  useEffect(load, []);
  useEffect(() => { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }, [cfg]);

  const toggleFav = (item: ListingItem) => {
    const nv = !item.is_favorite;
    setRows((rs) => rs.map((r) => (r.id === item.id ? { ...r, is_favorite: nv } : r)));
    if (selected?.id === item.id) setSelected({ ...selected, is_favorite: nv });
    setFavorite(item.id, nv).catch(() => load());
  };

  const showJob = (msg: string, ok: boolean, ttl = ok ? 4000 : 7000) => {
    if (jobTimerRef.current) clearTimeout(jobTimerRef.current);
    setJobStatus({ msg, ok });
    jobTimerRef.current = setTimeout(() => setJobStatus(null), ttl);
  };
  const runJob = (job: 'crawl' | 'analyze' | 'eval' | 'ingest-legal', label: string) => {
    showJob(`${label} 시작 중…`, true, 60000);
    triggerJob(job)
      .then(() => showJob(`${label} 실행됨`, true))
      .catch((e: unknown) => showJob(`오류: ${e instanceof Error ? e.message : String(e)}`, false));
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
    if (onlyPassed) v = v.filter((x) => x.sc.passed);
    if (onlyFavorite) v = v.filter((x) => x.item.is_favorite);
    if (onlyMultiRound) v = v.filter((x) => {
      const rs = x.item.location?.sale_rounds ?? [];
      const rnd = rs.find((s) => s.date === x.item.sale_date)?.round ?? (rs.length > 0 ? rs[rs.length - 1]!.round : null);
      return rnd != null && rnd >= 2;
    });
    if (type !== 'all') v = v.filter((x) => x.item.property_type === type);
    if (q.trim()) v = v.filter((x) => x.item.address.includes(q.trim()) || x.item.case_no.includes(q.trim()));
    v.sort((a, b) => {
      if (sort === 'safety') return (b.item.location?.safety_margin ?? -1) - (a.item.location?.safety_margin ?? -1);
      if (sort === 'sale') {
        const da = a.item.sale_date ?? '9999';
        const db = b.item.sale_date ?? '9999';
        return da.localeCompare(db);
      }
      if (sort === 'price') return (a.item.min_bid_price ?? Infinity) - (b.item.min_bid_price ?? Infinity);
      return b.sc.totalScore - a.sc.totalScore;
    });
    return v;
  }, [rows, cfg, onlyPassed, onlyFavorite, onlyMultiRound, type, q, sort]);

  const favCount = rows.filter((r) => r.is_favorite).length;
  const activeTab = showCfg ? 'config' : onlyFavorite ? 'fav' : onlyPassed ? 'recommend' : 'all';

  const stats = useMemo(() => {
    const all = rows.map((item) => ({ item, sc: scoreClient(item, cfg) }));
    const passed = all.filter((x) => x.sc.passed).length;
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayUrgent = all.filter((x) => x.sc.passed && x.item.sale_date === todayStr).length;
    const week = all.filter((x) => {
      if (!x.sc.passed || !x.item.sale_date) return false;
      const d = saleDaysDiff(x.item.sale_date);
      return d !== null && d >= 0 && d <= 7;
    }).length;
    return { total: rows.length, passed, todayUrgent, week };
  }, [rows, cfg]);

  return (
    <div className="app">
      <header>
        <h1>경매 매물 분석 <span className="sub">권리분석 · 입지분석</span></h1>
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
            <div className="stat-item stat-urgent">
              <span className="stat-label">오늘 기일</span>
              <b className="stat-num">{stats.todayUrgent}</b>
            </div>
          )}
          {stats.week > 0 && (
            <div className="stat-item stat-soon">
              <span className="stat-label">7일 이내</span>
              <b className="stat-num">{stats.week}</b>
            </div>
          )}
        </div>
      )}

      <div className="controls">
        <label><input type="checkbox" checked={onlyPassed} onChange={(e) => setOnlyPassed(e.target.checked)} /> 통과만</label>
        <label><input type="checkbox" checked={onlyFavorite} onChange={(e) => setOnlyFavorite(e.target.checked)} /> ★관심만 ({favCount})</label>
        <label><input type="checkbox" checked={onlyMultiRound} onChange={(e) => setOnlyMultiRound(e.target.checked)} /> 2차↑ 유찰</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">전체 종류</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input placeholder="주소·사건번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="score">점수순</option>
          <option value="safety">안전마진순</option>
          <option value="sale">임박순</option>
          <option value="price">최저가순</option>
        </select>
        <button onClick={() => setShowCfg((s) => !s)}>{showCfg ? '조건 닫기' : '⚙ 조건·기준'}</button>
        <button onClick={load}>새로고침</button>
        <button onClick={() => runJob('crawl', '크롤')} title="더낙찰옥션 크롤">크롤</button>
        <button onClick={() => runJob('analyze', '분석')} title="분석 실행">분석</button>
        <button onClick={() => exportCSV(view)} title="현재 목록을 CSV로 내보내기">↓ CSV</button>
        <span className="count">{view.length}건</span>
      </div>

      {showCfg && <ConfigPanel cfg={cfg} setCfg={setCfg} />}

      {loading && <Notice>불러오는 중…</Notice>}
      {err && <Notice>API 연결 오류: {err} <br />백엔드(<code>{apiBase}</code>) 실행 확인 (<code>server/run.sh</code>).</Notice>}
      {!loading && !err && view.length === 0 && (
        <Notice>표시할 매물이 없습니다. 상단 <b>크롤</b>→<b>분석</b> 또는 기준을 완화해 보세요.</Notice>
      )}

      {view.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th></th><th>사건번호</th><th>종류</th><th>소재지</th><th>감정가</th><th>최저가</th>
              <th>안전마진</th><th>인수금액</th><th>권리</th><th>점수</th><th>매각기일</th>
            </tr>
          </thead>
          <tbody>
            {view.map(({ item: r, sc }) => {
              const risk = RISK[r.rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
              return (
                <tr key={r.id} className="row">
                  <td className="star" onClick={() => toggleFav(r)} title="관심">{r.is_favorite ? '★' : '☆'}</td>
                  <td className="mono" onClick={() => handleSelect(r)}>{r.case_no}</td>
                  <td onClick={() => handleSelect(r)}>{TYPE_LABEL[r.property_type] ?? r.property_type}</td>
                  <td className="addr" onClick={() => handleSelect(r)}>{r.address}</td>
                  <td className="num" onClick={() => handleSelect(r)}>{eok(r.appraisal_value)}</td>
                  <td className="num" onClick={() => handleSelect(r)}>{eok(r.min_bid_price)}</td>
                  <td className="num" onClick={() => handleSelect(r)}>{pct(r.location?.safety_margin)}</td>
                  <td className="num" onClick={() => handleSelect(r)}>{r.rights ? (r.rights.assumed_amount ? eok(r.rights.assumed_amount) : '0') : '-'}</td>
                  <td onClick={() => handleSelect(r)}><span className={`badge ${risk.cls}`}>{risk.label}</span></td>
                  <td className="num" onClick={() => handleSelect(r)}><b className={sc.totalScore >= 70 ? 'good' : sc.totalScore < 40 ? 'danger' : ''}>{sc.totalScore}</b></td>
                  <td onClick={() => handleSelect(r)}><DDay dateStr={r.sale_date} /><span className="sale-date-txt">{r.sale_date ?? '-'}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {view.length > 0 && (
        <ul className="cards">
          {view.map(({ item: r, sc }, i) => {
            const risk = RISK[r.rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
            const reco = r.location?.report?.recommendation;
            const tm = r.location?.acquisition_cost?.trueSafetyMargin;
            const assumed = r.rights?.assumed_amount ?? 0;
            const rounds = r.location?.sale_rounds ?? [];
            const currentRound = rounds.find((s) => s.date === r.sale_date)?.round
              ?? (rounds.length > 0 ? rounds[rounds.length - 1]!.round : null);
            const expBid = r.location?.expected_bid_price;
            return (
              <li
                key={r.id}
                className={`card reco-edge-${reco ?? 'none'}`}
                style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                onClick={() => handleSelect(r)}
              >
                <div className="card-top">
                  <span className="card-addr">{r.address}</span>
                  <span className="card-star" onClick={(e) => { e.stopPropagation(); toggleFav(r); }}>{r.is_favorite ? '★' : '☆'}</span>
                </div>
                <div className="card-sub">
                  <span>{TYPE_LABEL[r.property_type] ?? r.property_type}</span>
                  <span className="mono">{r.case_no}</span>
                  <span className={`badge ${risk.cls}`} title={r.rights?.red_flags?.map((f) => f.message).join(' | ')}>{risk.label}</span>
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
                  {currentRound && currentRound > 1 && <span className="round-badge">{currentRound}차 진행</span>}
                  <DDay dateStr={r.sale_date} />
                  <span className="card-go">자세히 ›</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {selected && <Detail row={selected} onClose={() => setSelected(null)} onFav={() => toggleFav(selected)} loading={detailLoading === selected.case_no} />}

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

function ConfigPanel({ cfg, setCfg }: { cfg: ScoreConfig; setCfg: (c: ScoreConfig) => void }) {
  const safetyPct = Math.round(cfg.wSafety * 100);
  const toggleRegion = (r: string) => {
    const has = cfg.regionKeywords.includes(r);
    setCfg({ ...cfg, regionKeywords: has ? cfg.regionKeywords.filter((x) => x !== r) : [...cfg.regionKeywords, r] });
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
        <label>안전마진 만점 기준: {(cfg.safetyMaxAt * 100).toFixed(0)}%</label>
        <input type="range" min={10} max={60} value={Math.round(cfg.safetyMaxAt * 100)}
          onChange={(e) => setCfg({ ...cfg, safetyMaxAt: +e.target.value / 100 })} />
      </div>
      <div className="cfg-row cfg-checks">
        <label><input type="checkbox" checked={cfg.requireCleanRights} onChange={(e) => setCfg({ ...cfg, requireCleanRights: e.target.checked })} /> 인수금액 0만 통과</label>
        <label><input type="checkbox" checked={cfg.includeReviewRequired} onChange={(e) => setCfg({ ...cfg, includeReviewRequired: e.target.checked })} /> 검토필요(특수권리)도 통과에 포함</label>
        <button onClick={() => setCfg(DEFAULT_CONFIG)}>기본값</button>
      </div>
    </div>
  );
}

function exportCSV(rows: Array<{ item: ListingItem; sc: ClientScore }>) {
  const BOM = '﻿'; // Excel Korean UTF-8 BOM
  const headers = [
    '사건번호', '종류', '주소', '법원', '감정가(만원)', '최저가(만원)',
    '안전마진%', '인수금액(만원)', '권리등급', '점수', '매각기일',
    '추정시세(만원)', '진짜마진%', '전세시세(만원)', '갭(만원)', '수익률%',
    '현재차수', '예상낙찰가(만원)', '관심',
  ];
  const toMw = (v: number | null | undefined) => (v != null ? Math.round(v / 10000) : '');
  const pctStr = (v: number | null | undefined) => (v != null ? (v * 100).toFixed(1) : '');
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const lines = rows.map(({ item: r, sc }) => {
    const rounds = r.location?.sale_rounds ?? [];
    const currentRound =
      rounds.find((s) => s.date === r.sale_date)?.round ??
      (rounds.length > 0 ? rounds[rounds.length - 1]!.round : null);
    return [
      r.case_no, TYPE_LABEL[r.property_type] ?? r.property_type, r.address, r.court ?? '',
      toMw(r.appraisal_value), toMw(r.min_bid_price),
      pctStr(r.location?.safety_margin),
      toMw(r.rights?.assumed_amount ?? 0),
      RISK[r.rights?.risk_grade ?? '']?.label ?? '-',
      sc.totalScore, r.sale_date ?? '',
      toMw(r.location?.market_price),
      pctStr(r.location?.acquisition_cost?.trueSafetyMargin),
      toMw(r.location?.income?.jeonseDeposit),
      toMw(r.location?.income?.gapInvestment),
      r.location?.income?.grossYieldPct != null ? r.location.income.grossYieldPct.toFixed(1) : '',
      currentRound ?? '',
      toMw(r.location?.expected_bid_price),
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

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="notice">{children}</div>;
}

function Detail({ row, onClose, onFav, loading }: { row: ListingItem; onClose: () => void; onFav: () => void; loading?: boolean }) {
  const rights: RightsObj | null = row.rights;
  const loc: LocationObj | null = row.location;
  const risk = RISK[rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const detailRounds = loc?.sale_rounds ?? [];
  const currentRound =
    detailRounds.find((s) => s.date === row.sale_date)?.round ??
    (detailRounds.length > 0 ? detailRounds[detailRounds.length - 1]!.round : null);

  return (
    <div className="drawer-bg" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>✕</button>
        {loading && <p className="detail-loading">상세 분석 불러오는 중…</p>}
        <h2>
          <span className="star" onClick={onFav} title="관심">{row.is_favorite ? '★' : '☆'}</span>{' '}
          {row.case_no} <span className={`badge ${risk.cls}`}>{risk.label}</span>
        </h2>
        <p className="addr">{row.address} · {TYPE_LABEL[row.property_type]} · {row.court}</p>
        {row.source_url && (
          <p className="srclink"><a href={row.source_url} target="_blank" rel="noopener noreferrer">🔗 원본 상세페이지에서 더블체크 ↗</a></p>
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
          <div><span>매각기일</span><b>{row.sale_date ?? '-'}</b></div>
          {currentRound != null && (
            <div><span>현재 차수</span><b className={currentRound > 1 ? 'danger' : ''}>{currentRound}차{currentRound > 1 ? ` · 유찰 ${currentRound - 1}회` : ''}</b></div>
          )}
          <div><span>추정시세</span><b>{eok(loc?.market_price)}{loc?.market_confidence ? ` · 신뢰도 ${CONF[loc.market_confidence]}` : ''}</b></div>
          <div><span>예상낙찰가</span><b>{eok(loc?.expected_bid_price)}</b></div>
          <div><span>안전마진(최저가)</span><b>{pct(loc?.safety_margin)}</b></div>
          <div><span title="시세 − 총취득비용(취득세·명도비·채권·인수 포함)">진짜 안전마진</span><b className={(loc?.acquisition_cost?.trueSafetyMargin ?? 0) < 0 ? 'danger' : ''}>{pct(loc?.acquisition_cost?.trueSafetyMargin)}</b></div>
          <div><span>총 인수금액</span><b className={rights?.assumed_amount ? 'danger' : ''}>{won(rights?.assumed_amount ?? 0)}</b></div>
          <div><span>최대안전입찰가</span><b>{won(rights?.max_safe_bid)}</b></div>
        </div>

        {loc?.report && <ReportBlock report={loc.report} />}

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

        {loc?.acquisition_cost && <CostCalculator row={row} loc={loc} />}
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
      </aside>
    </div>
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
      {inc.saleScenarios.length > 0 && (
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
      {inc.notes.length > 0 && <ul className="warns">{inc.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
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
function ReportBlock({ report }: { report: import('./api.ts').ReportObj }) {
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
          <h4>🚶 현장 가서 이것만 확인하세요</h4>
          {report.fieldwork.fieldChecklist.map((f, i) => (
            <div key={i} className="fw-item"><b>{f.label}</b><div className="muted">{f.why}</div></div>
          ))}
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
