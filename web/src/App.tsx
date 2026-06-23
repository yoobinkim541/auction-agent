import { useEffect, useMemo, useRef, useState } from 'react';
import { MapView } from './MapView.tsx';
import { CompareView } from './CompareView.tsx';
import { ConfigPanel } from './ConfigPanel.tsx';
import { FLAG_LABEL, TYPE_LABEL, RISK, RECO } from './labels.ts';
import { SkeletonList, Notice, ThSort, DDay, FieldProgress } from './ui.tsx';
import {
  fetchDetail, triggerJob, fetchJobStatus, setFavorite,
  apiBase, eok, pct,
  type ListingItem,
} from './api.ts';
import { scoreClient, DEFAULT_CONFIG, type ScoreConfig, type ClientScore } from './scoring.ts';
import { applyListingFilters, sortRows, type SortKey } from './filters.ts';
import { resolveRound, saleDaysDiff, localDateISO } from './listing-utils.ts';
import { useListings } from './useListings.ts';
import { Detail } from './Detail.tsx';

const TODAY = localDateISO(); // KST 기준 로컬 날짜(UTC slice는 00:00~09:00 KST 구간에서 어제 날짜)

// saleDaysDiff는 listing-utils.ts로 이동

// DDay는 ui.tsx로 이동

// sale_rounds 에서 현재 차수를 결정. 날짜 불일치(분석 이후 재매각기일 갱신) 시 추정.
// resolveRound는 listing-utils.ts로 이동

// FLAG_LABEL·TYPE_LABEL·RISK는 labels.ts에서 import
// pct는 api.ts로 이동(won·eok와 포매터 통합)
// CONF(시세 신뢰도 라벨)·Detail 컴포넌트는 Detail.tsx로 이동

// SortKey는 filters.ts에서 import
const CFG_KEY = 'gm_score_config';
const UI_KEY = 'gm_ui_state';

const SORT_DEFAULT_DIR: Record<SortKey, 'asc' | 'desc'> = {
  score: 'desc', safety: 'desc', trueSafety: 'desc', sale: 'asc',
  price: 'asc', appraisal: 'desc', assumed: 'asc', gap: 'asc', fieldwork: 'desc',
};

/** 임장 진행 가중치: 진행중(체크 일부) > 메모만 > 미시작 > 완료(끝난 건 뒤로). 진행도순 정렬·배지 공용. */
// fieldworkRank는 filters.ts로 이동

// FieldProgress는 ui.tsx로 이동

/** 마진(진짜마진 우선) → 핀 색. 시세 없으면 회색. */
// marginColor는 listing-utils.ts로 이동

/** 지도 뷰 — 위경도 있는 매물을 마진색 원형 핀으로. 핀 팝업 → 상세. Leaflet 명령형 제어. */
// MapView는 ./MapView.tsx로 분리

/** 관심 매물 나란히 비교 — slim 데이터만으로 핵심 지표를 표로. 항목별 최우수 셀을 초록 강조. */
// CompareView는 ./CompareView.tsx로 분리

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
  const { rows, setRows, loading, err, lastCrawl, load } = useListings();
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

  // 데이터 로드(rows·lastCrawl·load)는 useListings()로 이동(위 destructure)
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
    const filtered = applyListingFilters(scored, {
      cfg, hideExpired, hideIncomplete, onlyPassed, onlyFavorite, onlyZeroPi, onlyConsider,
      onlyPassedAvoid, onlyToday, filterDate, onlyUrgent, maxGapEok, onlyMultiRound, type, q, today: TODAY,
    });
    return sortRows(filtered, sort, sortDir);
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
        <h1>경매 매물 분석 <span className="sub">권리분석 · 입지분석</span>{lastCrawl && <span className="crawl-date">데이터 기준 {lastCrawl.date}</span>}</h1>
        {lastCrawl?.blocked && (
          <div className="stale-banner blocked" role="alert">
            ⛔ <strong>크롤 차단 중</strong> — 더낙찰옥션 수집이 막혀 있습니다. 데이터가 {lastCrawl.daysAgo}일 전 기준입니다.
            프록시 IP 변경 후 재시도 필요.
          </div>
        )}
        {!lastCrawl?.blocked && lastCrawl?.stale && (
          <div className="stale-banner" role="alert">
            ⚠️ <strong>데이터 오래됨</strong> — 마지막 수집 {lastCrawl.daysAgo}일 전. 새 매각기일 물건이 누락됐을 수 있습니다.
          </div>
        )}
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

// REGIONS·PRICE_BANDS·ALLOWED_TYPES는 ConfigPanel.tsx로 이동

// ConfigPanel은 ./ConfigPanel.tsx로 분리

// exportCSV/buildCsv는 ./export-csv.ts로 분리

