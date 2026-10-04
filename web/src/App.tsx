import { useEffect, useMemo, useRef, useState, useDeferredValue, useCallback, memo, lazy, Suspense } from 'react';
import { FLAG_LABEL, TYPE_LABEL, RISK, RECO } from './labels.ts';
import { SkeletonList, Notice, ThSort, DDay, FieldProgress } from './ui.tsx';
import {
  fetchDetail, triggerJob, fetchJobStatus, setFavorite, fetchMlReview,
  apiBase, eok, pct,
  type ListingItem, type MlReview, type MlSurpriseRow,
} from './api.ts';
import { scoreClient, scoreBreakdown, type ScoreConfig, type ClientScore } from './scoring.ts';
// 코드 스플릿 — 지도(leaflet)·비교·상세·설정·도움말은 열 때만 로드(초기 번들·첫 페인트 단축).
const MapView = lazy(() => import('./MapView.tsx').then((m) => ({ default: m.MapView })));
const CompareView = lazy(() => import('./CompareView.tsx').then((m) => ({ default: m.CompareView })));
const ConfigPanel = lazy(() => import('./ConfigPanel.tsx').then((m) => ({ default: m.ConfigPanel })));
const Legend = lazy(() => import('./Legend.tsx').then((m) => ({ default: m.Legend })));
const Detail = lazy(() => import('./Detail.tsx').then((m) => ({ default: m.Detail })));
import { applyListingFilters, sortRows, groupRowsByCase, type SortKey } from './filters.ts';
import { resolveRound, saleDaysDiff, localDateISO } from './listing-utils.ts';
import { useListings } from './useListings.ts';
import { useTodayActions } from './useTodayActions.ts';
import { TodayActions } from './TodayActions.tsx';
import { useIncrementalList } from './useIncremental.ts';
import { exportCSV } from './export-csv.ts';
import { loadConfig, saveConfig, loadUIState, saveUIState } from './persistence.ts';
import { useMediaQuery } from './useMediaQuery.ts';

const TODAY = localDateISO(); // KST 기준 로컬 날짜(UTC slice는 00:00~09:00 KST 구간에서 어제 날짜)

// saleDaysDiff는 listing-utils.ts로 이동

// DDay는 ui.tsx로 이동

// sale_rounds 에서 현재 차수를 결정. 날짜 불일치(분석 이후 재매각기일 갱신) 시 추정.
// resolveRound는 listing-utils.ts로 이동

// FLAG_LABEL·TYPE_LABEL·RISK는 labels.ts에서 import
// pct는 api.ts로 이동(won·eok와 포매터 통합)
// CONF(시세 신뢰도 라벨)·Detail 컴포넌트는 Detail.tsx로 이동

// SortKey는 filters.ts에서 import
// CFG_KEY/UI_KEY·config/UI 영속화(load/save)는 persistence.ts로 이동

const SORT_DEFAULT_DIR: Record<SortKey, 'asc' | 'desc'> = {
  score: 'desc', safety: 'desc', trueSafety: 'desc', sale: 'asc',
  price: 'asc', appraisal: 'desc', assumed: 'asc', gap: 'asc', fieldwork: 'desc',
  competition: 'desc', // 경쟁점수 높을수록(=저경쟁) 앞
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

// loadConfig/loadUIState(+UIState 타입)는 persistence.ts로 이동

export default function App() {
  const { rows, setRows, loading, err, lastCrawl, load } = useListings();
  const { actions: todayActions, loading: todayActionsLoading, error: todayActionsError, reload: reloadTodayActions } = useTodayActions(20);
  const [onlyPassed, setOnlyPassed] = useState<boolean>(() => loadUIState().onlyPassed ?? false);
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
  const [groupByCase, setGroupByCase] = useState<boolean>(() => loadUIState().groupByCase ?? false);
  const [selected, setSelected] = useState<ListingItem | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [mapShowAll, setMapShowAll] = useState(true); // 지도는 기본 전체 매물(수집한 모든 데이터)
  const [cfg, setCfg] = useState<ScoreConfig>(loadConfig);
  const [showCfg, setShowCfg] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const detailCacheRef = useRef(new Map<string, ListingItem>());
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const jobTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 데이터 로드(rows·lastCrawl·load)는 useListings()로 이동(위 destructure)
  // 딥링크: URL #case=<사건번호> 로 진입하면 해당 매물 상세를 자동으로 연다(다이제스트/봇 링크용).
  useEffect(() => {
    const m = window.location.hash.match(/#case=(.+)/);
    if (!m) return;
    fetchDetail(decodeURIComponent(m[1]!)).then((full) => { if (full) setSelected(full); }).catch(() => {});
  }, []);
  useEffect(() => { saveConfig(cfg); }, [cfg]);
  useEffect(() => { saveUIState({ sort, sortDir, type, hideExpired, onlyPassed, onlyMultiRound, hideIncomplete, groupByCase }); }, [sort, sortDir, type, hideExpired, onlyPassed, onlyMultiRound, hideIncomplete, groupByCase]);

  // useCallback — 안정 참조여야 React.memo 행이 스킵된다(load도 useListings에서 안정화).
  const toggleFav = useCallback((item: ListingItem) => {
    const nv = !item.is_favorite;
    setRows((rs) => rs.map((r) => (r.id === item.id ? { ...r, is_favorite: nv } : r)));
    // 함수형 업데이트 — 상세 로드로 교체된 최신 selected(전체 데이터)를 slim 으로 덮어쓰지 않도록
    setSelected((cur) => (cur && cur.id === item.id ? { ...cur, is_favorite: nv } : cur));
    // 상세 캐시도 동기화 — 재오픈 시 별 상태가 토글 이전 값으로 되돌아가는 문제 방지
    const cached = detailCacheRef.current.get(item.case_no);
    if (cached) detailCacheRef.current.set(item.case_no, { ...cached, is_favorite: nv });
    setFavorite(item.id, nv).catch(() => load());
  }, [setRows, load]);

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
              reloadTodayActions();
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

  const handleSelect = useCallback((item: ListingItem) => {
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
  }, []);

  const openCaseFromReview = useCallback((caseNo: string) => {
    const cached = detailCacheRef.current.get(caseNo);
    if (cached) { setSelected(cached); return; }
    setDetailLoading(caseNo);
    fetchDetail(caseNo)
      .then((full) => { detailCacheRef.current.set(caseNo, full); setSelected(full); })
      .catch(() => {})
      .finally(() => setDetailLoading((cur) => (cur === caseNo ? null : cur)));
  }, []);

  // 단일 패스 스코어링 — rows·cfg 변경 시에만 1회. (과거: view/stats/allScored 3중 패스가 매 상호작용 재계산)
  // 항목 ref+cfg ref 키 캐시 — ★토글 등으로 일부 행만 바뀌면 변경된 항목만 재스코어, 나머지 sc 참조 안정
  // → React.memo 행이 실제로 스킵된다(불변 업데이트 패턴 활용).
  const scoreCacheRef = useRef(new Map<ListingItem, { cfg: ScoreConfig; sc: ClientScore }>());
  const scored = useMemo(() => {
    const prev = scoreCacheRef.current;
    const next = new Map<ListingItem, { cfg: ScoreConfig; sc: ClientScore }>();
    const out = rows.map((item) => {
      const hit = prev.get(item);
      const sc = hit && hit.cfg === cfg ? hit.sc : scoreClient(item, cfg);
      next.set(item, { cfg, sc });
      return { item, sc };
    });
    scoreCacheRef.current = next;
    return out;
  }, [rows, cfg]);
  // 검색어는 deferred — 타이핑 즉시 반응, 무거운 목록 재계산은 지연.
  const dq = useDeferredValue(q);

  const viewFull = useMemo(() => {
    const filtered = applyListingFilters(scored, {
      cfg, hideExpired, hideIncomplete, onlyPassed, onlyFavorite, onlyZeroPi, onlyConsider,
      onlyPassedAvoid, onlyToday, filterDate, onlyUrgent, maxGapEok, onlyMultiRound, type, q: dq, today: TODAY,
    });
    return sortRows(filtered, sort, sortDir);
  }, [scored, cfg, hideExpired, hideIncomplete, onlyPassed, onlyFavorite, onlyMultiRound, onlyZeroPi, onlyConsider, onlyPassedAvoid, onlyUrgent, onlyToday, filterDate, maxGapEok, type, dq, sort, sortDir]);

  // 사건 그룹핑: 한 사건의 여러 물건을 대표(현재 정렬 1위) 한 행으로 접어 검토 횟수를 줄인다.
  // caseSizes = 사건별 물건 수(접힌 행에 "외 N물건" 배지). 끄면 viewFull 그대로.
  const caseGroups = useMemo(() => groupRowsByCase(viewFull), [viewFull]);
  const view = useMemo(() => (groupByCase ? caseGroups.map((g) => g.rows[0]!) : viewFull), [groupByCase, caseGroups, viewFull]);
  const caseSizes = useMemo(() => new Map(caseGroups.map((g) => [g.caseNo, g.rows.length] as const)), [caseGroups]);

  // 점진 렌더 — 처음 60행만 마운트, 스크롤 시 60씩 추가(표·카드 공용).
  // 필터/정렬/탭 변경은 view 참조가 바뀌어 자동으로 처음부터. (수천 행 일괄 마운트가 렌더링 병목이었음)
  const { visible, sentinelRef, done: listDone, total: listTotal } = useIncrementalList(view, 60);

  // 지도용 포인트 — 전체(수집한 모든 매물=scored) 또는 현재 목록(필터). 통과 여부로 마커 스타일 구분.
  const mapPoints = useMemo(
    () => (mapShowAll ? scored : viewFull).map((x) => ({ item: x.item, passed: x.sc.passed })),
    [mapShowAll, scored, viewFull],
  );

  // 활성 레이아웃만 렌더(표 또는 카드) — 둘 다 DOM에 만들던 것을 하나로(노드 절반↓).
  const isMobile = useMediaQuery('(max-width: 760px)');
  const favCount = rows.filter((r) => r.is_favorite).length;
  const activeTab = showReview ? 'review' : showCfg ? 'config' : onlyFavorite ? 'fav' : onlyPassed ? 'recommend' : 'all';
  // 배지 카운트 — 결과를 좁히는 '숨은' 필터(오늘기일·달력일·갭·발품회피 등)까지 포함해야
  // 목록이 비었을 때 원인을 알 수 있다(과거: 절반 누락 → 0건인데 배지 0).
  // 설정(ConfigPanel)의 지역·가격 조건도 목록을 항상 자르므로 포함 — "전체 3200인데 목록 800" 미스터리 방지.
  const cfgFilterCount = [
    cfg.regionKeywords.length > 0, cfg.priceMinEok > 0, cfg.priceMaxEok > 0,
    cfg.apprMinEok > 0, cfg.apprMaxEok > 0,
  ].filter(Boolean).length;
  const activeFilterCount = [
    hideExpired, hideIncomplete, onlyPassed, onlyFavorite, onlyMultiRound,
    onlyZeroPi, onlyConsider, onlyUrgent, onlyPassedAvoid, onlyToday,
    !!filterDate, maxGapEok > 0,
  ].filter(Boolean).length + cfgFilterCount;

  // 모든 필터 초기화(검색어·종류 포함) — 팝오버/빈상태 버튼이 동일하게 사용
  const resetFilters = () => {
    setHideExpired(false); setHideIncomplete(false); setOnlyPassed(false); setOnlyFavorite(false);
    setOnlyMultiRound(false); setOnlyZeroPi(false); setOnlyConsider(false); setOnlyUrgent(false);
    setOnlyPassedAvoid(false); setOnlyToday(false); setFilterDate(null); setMaxGapEok(0);
    setType('all'); setQ('');
  };

  const stats = useMemo(() => {
    const all = scored; // 단일 패스 재사용(별도 scoreClient 패스 제거)
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
            ⛔ <strong>크롤 차단 의심</strong> — 법원경매 최근 수집이 0건/실패입니다{lastCrawl.daysAgo < 900 ? ` (마지막 정상 수집 ${lastCrawl.daysAgo}일 전)` : ''}.
            집 IP 프록시(터널) 상태 확인 후 재시도 필요.
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

      <TodayActions
        actions={todayActions}
        loading={todayActionsLoading}
        error={todayActionsError}
        onOpenCase={openCaseFromReview}
      />

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
          <option value="competition">🔥 저경쟁순</option>
        </select>
        <select value={maxGapEok} onChange={(e) => setMaxGapEok(Number(e.target.value))}>
          <option value={0}>갭 제한 없음</option>
          <option value={0.5}>갭 5천만↓</option>
          <option value={1}>갭 1억↓</option>
          <option value={2}>갭 2억↓</option>
          <option value={3}>갭 3억↓</option>
        </select>
        <button className={`viewmode-btn${groupByCase ? ' on' : ''}`} onClick={() => setGroupByCase((g) => !g)} title="같은 사건의 여러 물건을 대표 1건으로 묶어 검토 횟수↓">
          {groupByCase ? '🗂 사건묶음✓' : '🗂 사건묶기'}
        </button>
        <button className={`viewmode-btn${viewMode === 'map' ? ' on' : ''}`} onClick={() => setViewMode((m) => (m === 'list' ? 'map' : 'list'))} title="목록/지도 전환">
          {viewMode === 'list' ? '🗺 지도' : '📋 목록'}
        </button>

        <span className="ctrl-sep" />
        <button className={`help-btn${showLegend ? ' on' : ''}`} onClick={() => setShowLegend((s) => !s)} title="점수·통과 기준·배지 의미 도움말">❓ 도움말</button>
        <button className={`viewmode-btn${showReview ? ' on' : ''}`} onClick={() => { setShowReview((s) => !s); setShowCfg(false); window.scrollTo(0, 0); }} title="Phase2 복기와 ML 오프라인 지표">🧠 복기/ML</button>
        <button onClick={() => { setShowCfg((s) => !s); setShowReview(false); }}>{showCfg ? '조건 닫기' : '⚙ 조건·기준'}</button>
        <button onClick={() => exportCSV(view)} title="현재 목록을 CSV로 내보내기">↓ CSV</button>
        {favCount >= 2 && <button className="cmp-btn" onClick={() => setShowCompare(true)} title="관심 매물을 나란히 비교">⚖ 비교 ({favCount})</button>}

        <span className="ctrl-sep" />
        <button className="admin-btn" onClick={load} title="목록 새로고침">↻ 새로고침</button>
        <button className="admin-btn" onClick={() => runJob('crawl', '크롤')} title="크롤 실행(법원경매·더낙찰옥션)">크롤</button>
        <button className="admin-btn" onClick={() => runJob('analyze', '분석')} title="권리·입지·점수 재분석">분석</button>
        <span className="count">{view.length}건</span>
      </div>

      {showLegend && <Suspense fallback={null}><Legend cfg={cfg} /></Suspense>}
      {showCfg && <Suspense fallback={null}><ConfigPanel cfg={cfg} setCfg={setCfg} /></Suspense>}

      {loading && <SkeletonList />}
      {err && <Notice>API 연결 오류: {err} <br />백엔드(<code>{apiBase}</code>) 실행 확인 (<code>server/run.sh</code>).</Notice>}
      {showReview && !err && <ReviewPanel onOpenCase={openCaseFromReview} />}

      {!showReview && !loading && !err && view.length === 0 && (
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

      {!showReview && viewMode === 'map' && (
        <Suspense fallback={<div className="list-more">지도 불러오는 중…</div>}>
          <MapView items={mapPoints} onSelect={handleSelect} showAll={mapShowAll} onToggleShowAll={() => setMapShowAll((s) => !s)} />
        </Suspense>
      )}

      {!showReview && viewMode === 'list' && viewFull.length > 0 && stats.total > viewFull.length && (
        <div className="hidden-note" title="설정의 지역·가격 조건과 필터 토글이 목록을 좁힙니다. 상단 ❌ 필터해제 또는 ⚙️ 설정에서 조정.">
          표시 {viewFull.length} / 전체 {stats.total}건 — 조건·필터로 {stats.total - viewFull.length}건 숨김
          {cfgFilterCount > 0 && ' (⚙️ 설정의 지역·가격 조건 포함)'}
        </div>
      )}

      {!showReview && viewMode === 'list' && view.length > 0 && !isMobile && (
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
            {visible.map(({ item, sc }) => (
              <ListingRow key={item.id} item={item} sc={sc} onSelect={handleSelect} onFav={toggleFav}
                today={TODAY} groupByCase={groupByCase} caseSize={caseSizes.get(item.case_no) ?? 1} />
            ))}
          </tbody>
        </table>
      )}

      {!showReview && viewMode === 'list' && view.length > 0 && isMobile && (
        <ul className="cards">
          {visible.map(({ item, sc }, i) => (
            <ListingCard key={item.id} item={item} sc={sc} onSelect={handleSelect} onFav={toggleFav}
              groupByCase={groupByCase} caseSize={caseSizes.get(item.case_no) ?? 1} index={i} />
          ))}
        </ul>
      )}

      {!showReview && viewMode === 'list' && !listDone && (
        <div ref={sentinelRef} className="list-more">{visible.length}/{listTotal}건 렌더링 중 — 아래로 스크롤하면 더 붙입니다</div>
      )}

      {selected && <Suspense fallback={null}><Detail
        row={selected} onClose={() => setSelected(null)} onFav={() => toggleFav(selected)}
        loading={detailLoading === selected.case_no}
        onPrev={selNavPrev} onNext={selNavNext} position={selNavPos}
      /></Suspense>}

      {showCompare && (
        <Suspense fallback={null}>
          <CompareView
            items={rows.filter((r) => r.is_favorite)}
            cfg={cfg}
            onClose={() => setShowCompare(false)}
            onSelect={handleSelect}
          />
        </Suspense>
      )}

      {jobStatus && (
        <div className={`job-toast${jobStatus.ok ? '' : ' job-toast-err'}`} onClick={() => setJobStatus(null)}>
          {jobStatus.msg}
        </div>
      )}

      <nav className="tabbar">
        <button className={activeTab === 'recommend' ? 'on' : ''} onClick={() => { setShowReview(false); setShowCfg(false); setOnlyFavorite(false); setOnlyPassed(true); window.scrollTo(0, 0); }}>
          <span className="tb-ico">🎯</span>추천
        </button>
        <button className={activeTab === 'all' ? 'on' : ''} onClick={() => { setShowReview(false); setShowCfg(false); setOnlyFavorite(false); setOnlyPassed(false); window.scrollTo(0, 0); }}>
          <span className="tb-ico">📋</span>전체
        </button>
        <button className={activeTab === 'fav' ? 'on' : ''} onClick={() => { setShowReview(false); setShowCfg(false); setOnlyFavorite(true); window.scrollTo(0, 0); }}>
          <span className="tb-ico">★</span>관심{favCount > 0 && <i className="tb-badge">{favCount}</i>}
        </button>
        <button className={activeTab === 'review' ? 'on' : ''} onClick={() => { setShowReview((s) => !s); setShowCfg(false); window.scrollTo(0, 0); }}>
          <span className="tb-ico">🧠</span>복기
        </button>
        <button className={activeTab === 'config' ? 'on' : ''} onClick={() => { setShowCfg((s) => !s); setShowReview(false); }}>
          <span className="tb-ico">⚙</span>조건
        </button>
      </nav>
    </div>
  );
}


function fmtRate(n: number | null | undefined): string {
  return n == null ? '-' : `${(n * 100).toFixed(1)}%`;
}

function fmtNum(n: number | null | undefined, digits = 3): string {
  return n == null ? '-' : n.toFixed(digits);
}

function calibrationHint(row: ListingItem): string | null {
  const c = row.ml_calibration;
  if (!c || c.reference_bid_price == null) return null;
  const delta = c.delta_vs_expected_bid == null ? '' : ` · 현재예상 대비 ${c.delta_vs_expected_bid >= 0 ? '+' : ''}${eok(c.delta_vs_expected_bid)}`;
  return `ML 참고가 ${eok(c.reference_bid_price)} · ${c.region} ${c.sample_size}건 중앙 낙찰가율 ${fmtRate(c.median_sale_ratio)}${delta}`;
}

function overbidCaution(row: ListingItem): boolean {
  const c = row.ml_calibration;
  if (!c || c.delta_vs_expected_bid == null || row.appraisal_value == null || row.appraisal_value <= 0) return false;
  return c.delta_vs_expected_bid < 0 && Math.abs(c.delta_vs_expected_bid) / row.appraisal_value >= 0.05;
}

function CalibrationChip({ row }: { row: ListingItem }) {
  const hint = calibrationHint(row);
  if (!hint || row.ml_calibration?.reference_bid_price == null) return null;
  const delta = row.ml_calibration.delta_vs_expected_bid;
  const caution = overbidCaution(row);
  const cls = caution ? ' ml-overbid' : delta == null ? '' : delta > 0 ? ' ml-up' : delta < 0 ? ' ml-down' : '';
  return <span className={`ml-ref-chip${cls}`} title={`${hint} · 운영 반영 전 참고용`}>{caution ? '과다주의' : 'ML'} {eok(row.ml_calibration.reference_bid_price)}</span>;
}

function ReviewPanel({ onOpenCase }: { onOpenCase: (caseNo: string) => void }) {
  const [data, setData] = useState<MlReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchMlReview()
      .then((res) => { if (alive) { setData(res); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return <div className="review-panel"><Notice>복기/ML 지표 불러오는 중…</Notice></div>;
  if (error || !data) return <div className="review-panel"><Notice>복기/ML API 오류: {error ?? '데이터 없음'}</Notice></div>;
  const s = data.summary;
  const ready = (s.miss_rate ?? 1) < 0.3 && s.sale_ratio_labels >= 150;
  const markdownLines = data.reportMarkdown.split('\n').filter((line) => /^\| (hist_gbr|random_forest|current_expected_bid|dummy_median|dummy_prior)/.test(line));
  const surpriseGroups = [
    ['overpriced', '🔺 예상보다 비싸게 낙찰'],
    ['avoid_but_sold', '🟠 회피/미통과인데 낙찰'],
    ['passed_but_unsold', '🔻 추천/통과했는데 유찰'],
  ] as const;
  return (
    <section className="review-panel">
      <div className="review-head">
        <div>
          <h2>🧠 Phase2 복기/ML</h2>
          <p>DB를 수정하지 않는 오프라인 검증입니다. 추천·입찰가에는 아직 자동 반영하지 않습니다.</p>
        </div>
        <span className={`review-gate${ready ? ' gate-ok' : ' gate-wait'}`}>{ready ? '채택 검토 가능' : '운영 반영 대기'}</span>
      </div>

      <div className="review-kpis">
        <div><span>지난 스냅샷</span><b>{s.past_snapshots.toLocaleString('ko-KR')}</b></div>
        <div><span>결과 매칭</span><b>{s.matched.toLocaleString('ko-KR')}</b><em>낙찰 {s.sold.toLocaleString('ko-KR')} · 유찰 {s.unsold.toLocaleString('ko-KR')}</em></div>
        <div><span>미매칭률</span><b className={(s.miss_rate ?? 1) > 0.3 ? 'danger' : 'good'}>{fmtRate(s.miss_rate)}</b></div>
        <div><span>낙찰가율 라벨</span><b>{s.sale_ratio_labels.toLocaleString('ko-KR')}</b></div>
        <div><span>현재 예상가 MAE</span><b>{fmtRate(s.current_expected_mae)}</b></div>
        <div><span>양수 마진률</span><b>{fmtRate(s.positive_margin_rate)}</b></div>
      </div>

      <div className="review-card">
        <h3>참고가 성능 추적</h3>
        <div className="review-kpis review-kpis-compact">
          <div><span>비교 가능 행</span><b>{data.calibrationPerformance.rows.toLocaleString('ko-KR')}</b></div>
          <div><span>참고가 MAE</span><b>{fmtRate(data.calibrationPerformance.reference_mae)}</b></div>
          <div><span>현재예상 MAE</span><b>{fmtRate(data.calibrationPerformance.current_mae)}</b></div>
          <div><span>참고가 승률</span><b>{fmtRate(data.calibrationPerformance.reference_win_rate)}</b></div>
        </div>
      </div>

      {markdownLines.length > 0 && (
        <div className="review-card">
          <h3>최근 오프라인 모델 결과</h3>
          <ul className="ml-lines">{markdownLines.map((line) => <li key={line}><code>{line}</code></li>)}</ul>
        </div>
      )}

      <div className="review-card">
        <h3>서프라이즈 복기 케이스</h3>
        <div className="surprise-grid">
          {surpriseGroups.map(([kind, label]) => {
            const rows = data.surprises.filter((r) => r.surprise_kind === kind).slice(0, 5);
            return <SurpriseTable key={kind} title={label} rows={rows} onOpenCase={onOpenCase} />;
          })}
        </div>
      </div>

      <div className="review-grid2">
        <div className="review-card">
          <h3>결과 미매칭 재시도 큐</h3>
          <table className="mini-table"><thead><tr><th>사건</th><th>D+</th><th>우선</th><th>점수</th></tr></thead><tbody>
            {data.retryQueue.slice(0, 12).map((r) => <tr key={`${r.case_no}-${r.item_no}`}><td><button className="link-btn mono" onClick={() => onOpenCase(r.case_no)}>{r.case_no}{r.item_no !== '1' ? `-${r.item_no}` : ''}</button></td><td>{r.days_overdue}</td><td>{r.retry_priority}</td><td>{r.total_score ?? '-'}</td></tr>)}
          </tbody></table>
        </div>
        <div className="review-card">
          <h3>권리 리스크 복기</h3>
          <table className="mini-table"><thead><tr><th>권리</th><th>rows</th><th>낙찰률</th><th>마진</th><th>대항력</th></tr></thead><tbody>
            {data.rightsRisk.map((r) => <tr key={r.risk_grade}><td>{RISK[r.risk_grade]?.label ?? r.risk_grade}</td><td>{r.rows}</td><td>{fmtRate(r.sold_rate)}</td><td>{fmtRate(r.median_proxy_margin)}</td><td>{r.opposition_rows}</td></tr>)}
          </tbody></table>
        </div>
      </div>

      <div className="review-grid2">
        <div className="review-card">
          <h3>Feature Coverage Watchlist</h3>
          <table className="mini-table"><thead><tr><th>feature</th><th>rows</th><th>coverage</th></tr></thead><tbody>
            {data.featureCoverage.map((r) => <tr key={r.feature}><td>{r.feature}</td><td>{r.non_null_rows.toLocaleString('ko-KR')}</td><td>{fmtRate(r.coverage)}</td></tr>)}
          </tbody></table>
        </div>
        <div className="review-card">
          <h3>지역×종류 중앙 낙찰가율</h3>
          <table className="mini-table"><thead><tr><th>종류</th><th>지역</th><th>n</th><th>낙찰가율</th><th>마진</th></tr></thead><tbody>
            {data.groupMedian.slice(0, 12).map((r) => <tr key={`${r.property_type}-${r.region}`}><td>{TYPE_LABEL[r.property_type] ?? r.property_type}</td><td>{r.region}</td><td>{r.rows}</td><td>{fmtNum(r.median_sale_ratio)}</td><td>{fmtNum(r.median_realized_margin)}</td></tr>)}
          </tbody></table>
        </div>
      </div>
    </section>
  );
}


function surpriseMetric(row: MlSurpriseRow): string {
  if (row.surprise_kind === 'overpriced') return `오차 ${fmtRate(row.residual_pct)}`;
  if (row.surprise_kind === 'avoid_but_sold') return `낙찰가율 ${fmtRate(row.sale_ratio)}`;
  return `점수 ${row.total_score ?? '-'}`;
}

function SurpriseTable({ title, rows, onOpenCase }: { title: string; rows: MlSurpriseRow[]; onOpenCase: (caseNo: string) => void }) {
  return (
    <div className="surprise-box">
      <h4>{title}</h4>
      {rows.length === 0 ? <p className="muted">케이스 없음</p> : (
        <table className="mini-table surprise-table"><thead><tr><th>사건</th><th>주소</th><th>핵심</th><th>마진</th></tr></thead><tbody>
          {rows.map((r) => <tr key={`${r.surprise_kind}-${r.case_no}-${r.item_no}`}>
            <td><button className="link-btn mono" onClick={() => onOpenCase(r.case_no)}>{r.case_no}{r.item_no !== '1' ? `-${r.item_no}` : ''}</button></td>
            <td title={r.address}>{r.address.slice(0, 18)}</td>
            <td>{surpriseMetric(r)}</td>
            <td>{fmtRate(r.realized_bid_margin ?? r.true_margin)}</td>
          </tr>)}
        </tbody></table>
      )}
    </div>
  );
}

// ── 목록 행/카드 — React.memo + 안정 콜백(handleSelect/toggleFav useCallback) + 행별 점수 캐시 →
//    정렬·필터·★토글·잡 폴링 시 변경 안 된 행은 재렌더 스킵(1355행 reconcile 비용↓).
interface RowBaseProps {
  item: ListingItem; sc: ClientScore;
  onSelect: (item: ListingItem) => void; onFav: (item: ListingItem) => void;
  groupByCase: boolean; caseSize: number;
}

const ListingRow = memo(function ListingRow({ item: r, sc, onSelect, onFav, today, groupByCase, caseSize }: RowBaseProps & { today: string }) {
  const risk = RISK[r.rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
  return (
    <tr className={`row${r.location?.report?.recommendation === 'consider' ? ' row-consider' : ''}${sc.passed && r.location?.report?.recommendation === 'avoid' ? ' row-pass-avoid' : ''}`}>
      <td className="star" onClick={() => onFav(r)} title="관심">{r.is_favorite ? '★' : '☆'}</td>
      <td className="mono" onClick={() => onSelect(r)}>
        {r.case_no}
        {r.crawled_at && r.crawled_at.slice(0, 10) >= today && <span className="new-chip" title={`신규 수집: ${r.crawled_at.slice(0, 10)}`}>NEW</span>}
        {groupByCase && caseSize > 1 && (
          <span className="case-multi-chip" title={`이 사건에 물건 ${caseSize}개 — 대표 1건만 표시(사건묶기)`}>외 {caseSize - 1}물건</span>
        )}
        <FieldProgress r={r} />
      </td>
      <td onClick={() => onSelect(r)} title={r.area_m2 != null ? `전용 ${r.area_m2.toFixed(1)}㎡` : undefined}>{TYPE_LABEL[r.property_type] ?? r.property_type}</td>
      <td className="addr" onClick={() => onSelect(r)}>{r.address}</td>
      <td className="num" onClick={() => onSelect(r)}>{eok(r.appraisal_value)}</td>
      <td className="num" onClick={() => onSelect(r)}>{eok(r.min_bid_price)}</td>
      <td className="num safety-cell" onClick={() => onSelect(r)}>
        {r.location?.safety_margin == null
          ? <span className="no-mkt" title="시세 미확보 — 안전마진 산정 불가">?</span>
          : pct(r.location.safety_margin)}
        {r.location?.acquisition_cost?.trueSafetyMargin != null && (
          <span className={`true-margin${(r.location.acquisition_cost.trueSafetyMargin ?? 0) < 0 ? ' neg-margin' : ''}`} title="진짜 안전마진(취득비용 반영)"> / {pct(r.location.acquisition_cost.trueSafetyMargin)}</span>
        )}
        {r.location?.market_confidence === 'low' && <span className="conf-dot conf-low" title="시세 추정 신뢰도: 낮음(표본 부족)">●</span>}
        {r.location?.market_confidence === 'medium' && <span className="conf-dot conf-med" title="시세 추정 신뢰도: 보통">●</span>}
        <CalibrationChip row={r} />
      </td>
      <td className="num" onClick={() => onSelect(r)}>{r.rights ? (r.rights.assumed_amount ? eok(r.rights.assumed_amount) : '0') : '-'}</td>
      <td onClick={() => onSelect(r)}>
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
        {sc.competitionScore != null && sc.competitionScore >= 70 && (
          <span className="lowcomp-chip" title={`저경쟁 — 조회 ${r.inq_cnt ?? '?'}·관심 ${r.interest_cnt ?? 0} (남들이 덜 본 매물)`}>🔥저경쟁</span>
        )}
      </td>
      <td className="num" onClick={() => onSelect(r)} title={[scoreBreakdown(sc), ...(sc.reasons.length ? ['—', ...sc.reasons] : [])].join(' · ')}>
        <b className={sc.totalScore >= 70 ? 'good' : sc.totalScore < 40 ? 'danger' : ''}>{sc.totalScore}</b>
        {!sc.passed && sc.reasons.length > 0 && <span className="score-fail-hint">{sc.reasons[0]}</span>}
      </td>
      <td onClick={() => onSelect(r)}>
        <DDay dateStr={r.sale_date} /><span className="sale-date-txt">{r.sale_date ?? '-'}</span>
        {(() => {
          const rr = resolveRound(r.location?.sale_rounds ?? [], r.sale_date, r.fail_count);
          if (!rr || rr.n <= 1) return null;
          return <span className={`round-badge${rr.est ? ' round-badge-est' : ''}`} style={{ marginLeft: 3 }} title={rr.est ? '분석 후 재매각기일 갱신 — 차수 추정값' : ''}>{rr.n}차{rr.est ? '+' : ''}</span>;
        })()}
      </td>
    </tr>
  );
});

const ListingCard = memo(function ListingCard({ item: r, sc, onSelect, onFav, groupByCase, caseSize, index }: RowBaseProps & { index: number }) {
  const risk = RISK[r.rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
  const reco = r.location?.report?.recommendation;
  const tm = r.location?.acquisition_cost?.trueSafetyMargin;
  const assumed = r.rights?.assumed_amount ?? 0;
  const resolvedRound = resolveRound(r.location?.sale_rounds ?? [], r.sale_date, r.fail_count);
  const currentRound = resolvedRound?.n ?? null;
  const expBid = r.location?.expected_bid_price;
  const isIncomplete = r.location?.report?.headline?.startsWith('[데이터 불완전]') ?? false;
  const passedAvoid = sc.passed && reco === 'avoid';
  return (
    <li
      className={`card reco-edge-${reco ?? 'none'}${passedAvoid ? ' card-pass-avoid' : ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}
      onClick={() => onSelect(r)}
    >
      <div className="card-top">
        <span className="card-addr">{r.address}</span>
        <span className="card-star" onClick={(e) => { e.stopPropagation(); onFav(r); }}>{r.is_favorite ? '★' : '☆'}</span>
      </div>
      <div className="card-sub">
        <span>{TYPE_LABEL[r.property_type] ?? r.property_type}{r.area_m2 != null ? ` · ${r.area_m2.toFixed(0)}㎡` : ''}</span>
        <span className="mono">{r.case_no}</span>
        {groupByCase && caseSize > 1 && (
          <span className="case-multi-chip" title={`이 사건에 물건 ${caseSize}개 — 대표 1건만 표시`}>외 {caseSize - 1}물건</span>
        )}
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
        {r.ml_calibration?.reference_bid_price != null && <div><span>ML참고가</span><b>{eok(r.ml_calibration.reference_bid_price)}</b></div>}
      </div>
      <div className="card-foot">
        <span className="card-score" title={scoreBreakdown(sc)}>점수 <b>{sc.totalScore}</b></span>
        {assumed > 0 && <span className="card-assumed">인수 {eok(assumed)}</span>}
        {r.location?.income?.zeroPiCandidate && <span className="zero-pi-chip">★무피</span>}
        {currentRound && currentRound > 1 && <span className="round-badge">{currentRound}차 진행</span>}
        <FieldProgress r={r} />
        <DDay dateStr={r.sale_date} />
        <span className="card-go">자세히 ›</span>
      </div>
    </li>
  );
});

// REGIONS·PRICE_BANDS·ALLOWED_TYPES는 ConfigPanel.tsx로 이동

// ConfigPanel은 ./ConfigPanel.tsx로 분리

// exportCSV/buildCsv는 ./export-csv.ts로 분리
