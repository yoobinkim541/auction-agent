import { useEffect, useMemo, useRef, useState, useDeferredValue, useCallback, memo, lazy, Suspense, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react';
import { TYPE_LABEL, RISK, RECO, FEATURE_LABEL } from './labels.ts';
import { SkeletonList, Notice, ThSort, DDay, FieldProgress } from './ui.tsx';
import {
  setFavorite, fetchMlReview,
  apiBase, eok, pct,
  type ListingItem, type MlReview, type MlSurpriseRow, type DecisionEvent, type ListingDetailTarget, type CrawlStatus,
} from './api.ts';
import { scoreClient, scoreBreakdown, type ScoreConfig, type ClientScore } from './scoring.ts';
// 코드 스플릿 — 지도(leaflet)·비교·상세·설정·도움말은 열 때만 로드(초기 번들·첫 페인트 단축).
const MapView = lazy(() => import('./MapView.tsx').then((m) => ({ default: m.MapView })));
const CompareView = lazy(() => import('./CompareView.tsx').then((m) => ({ default: m.CompareView })));
const ConfigPanel = lazy(() => import('./ConfigPanel.tsx').then((m) => ({ default: m.ConfigPanel })));
const Legend = lazy(() => import('./Legend.tsx').then((m) => ({ default: m.Legend })));
const Detail = lazy(() => import('./Detail.tsx').then((m) => ({ default: m.Detail })));
import { applyListingFilters, sortRows, groupRowsByCase, caseGroupKey, type SortKey } from './filters.ts';
import { resolveRound, saleDaysDiff, localDateISO } from './listing-utils.ts';
import { useListings } from './useListings.ts';
import { useTodayActions } from './useTodayActions.ts';
import { TodayActions } from './TodayActions.tsx';
import { PrecisionInbox } from './PrecisionInbox.tsx';
import { useIncrementalList } from './useIncremental.ts';
import { exportCSV } from './export-csv.ts';
import { loadConfig, saveConfig } from './persistence.ts';
import { useMediaQuery } from './useMediaQuery.ts';
import { buildTriageCards, type TriageKind } from './triage.ts';
import { useBackendStatus } from './backend-status.ts';
import { useJobRunner } from './useJobRunner.ts';
import { usePrecisionInbox } from './usePrecisionInbox.ts';
import { useDetailSelection } from './useDetailSelection.ts';
import { useListingFilters } from './useListingFilters.ts';

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
  const backendStatus = useBackendStatus();
  const precisionInbox = usePrecisionInbox();
  const { items: precisionItems, loading: precisionLoading, error: precisionError, reload: loadPrecision, updateDecision } = precisionInbox;
  const detailSelection = useDetailSelection();
  const { selected, isDetailLoading, handleSelect, openCaseFromReview, closeDetail, courtChoices, syncFavorite, syncDecision } = detailSelection;
  const filters = useListingFilters();
  const {
    onlyPassed, setOnlyPassed,
    onlyFavorite, setOnlyFavorite,
    onlyDecided, setOnlyDecided,
    onlyMultiRound, setOnlyMultiRound,
    onlyZeroPi, setOnlyZeroPi,
    onlyConsider, setOnlyConsider,
    onlyPassedAvoid, setOnlyPassedAvoid,
    onlyUrgent, setOnlyUrgent,
    onlyToday, setOnlyToday,
    filterDate, setFilterDate,
    maxGapEok, setMaxGapEok,
    hideExpired, setHideExpired,
    hideIncomplete, setHideIncomplete,
    type, setType,
    q, setQ,
    sort, setSort,
    sortDir, setSortDir,
    groupByCase, setGroupByCase,
    handleSort,
  } = filters;

  const jobRunner = useJobRunner({
    onComplete: () => {
      load();
      reloadTodayActions();
      void loadPrecision();
    },
  });
  const { jobStatus, runJob, dismissJob } = jobRunner;

  const [showCompare, setShowCompare] = useState(false);
  // 한 화면 한 목적 — 오늘(무엇부터 볼지) · 목록(찾고 거르기) · 복기(지난 판단 검증).
  const [page, setPage] = useState<'today' | 'list' | 'review'>('today');
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [mapShowAll, setMapShowAll] = useState(true); // 지도는 기본 전체 매물(수집한 모든 데이터)
  const [cfg, setCfg] = useState<ScoreConfig>(loadConfig);
  const [showCfg, setShowCfg] = useState(false);
  const [showLegend, setShowLegend] = useState(false);

  useEffect(() => { saveConfig(cfg); }, [cfg]);

  const toggleFav = useCallback((item: ListingItem) => {
    const nv = !item.is_favorite;
    setRows((rs) => rs.map((r) => (r.id === item.id ? { ...r, is_favorite: nv } : r)));
    syncFavorite(item, nv);
    setFavorite(item.id, nv).catch(() => load());
  }, [setRows, syncFavorite, load]);

  const updateCurrentDecision = useCallback((event: DecisionEvent) => {
    updateDecision(event);
    syncDecision(event);
  }, [updateDecision, syncDecision]);
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
      cfg, hideExpired, hideIncomplete, onlyPassed, onlyFavorite, onlyDecided, onlyZeroPi, onlyConsider,
      onlyPassedAvoid, onlyToday, filterDate, onlyUrgent, maxGapEok, onlyMultiRound, type, q: dq, today: TODAY,
    });
    return sortRows(filtered, sort, sortDir);
  }, [scored, cfg, hideExpired, hideIncomplete, onlyPassed, onlyFavorite, onlyMultiRound, onlyZeroPi, onlyConsider, onlyPassedAvoid, onlyUrgent, onlyToday, filterDate, maxGapEok, type, dq, sort, sortDir]);

  // 사건 그룹핑: 한 사건의 여러 물건을 대표(현재 정렬 1위) 한 행으로 접어 검토 횟수를 줄인다.
  // caseSizes = 사건별 물건 수(접힌 행에 "외 N물건" 배지). 끄면 viewFull 그대로.
  const caseGroups = useMemo(() => groupRowsByCase(viewFull), [viewFull]);
  const view = useMemo(() => (groupByCase ? caseGroups.map((g) => g.rows[0]!) : viewFull), [groupByCase, caseGroups, viewFull]);
  const caseSizes = useMemo(() => new Map(caseGroups.map((g) => [g.key, g.rows.length] as const)), [caseGroups]);
  // 오늘 화면의 '먼저 볼 물건'은 목록 필터와 무관하게 통과·진행 중 매물에서 고른다(조건 설정만 반영).
  const triageCards = useMemo(() => {
    const base = applyListingFilters(scored, {
      cfg, hideExpired: true, hideIncomplete: false, onlyPassed: true, onlyFavorite: false, onlyDecided: false, onlyZeroPi: false,
      onlyConsider: false, onlyPassedAvoid: false, onlyToday: false, filterDate: null, onlyUrgent: false, maxGapEok: 0,
      onlyMultiRound: false, type: 'all', q: '', today: TODAY,
    });
    return buildTriageCards(sortRows(base, 'score', 'desc'), TODAY, 4);
  }, [scored, cfg]);

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
  const decidedCount = rows.filter((r) => r.current_decision != null).length;
  const listTab: ListTab = onlyDecided ? 'journal' : onlyFavorite ? 'fav' : onlyPassed ? 'recommend' : sort === 'fieldwork' ? 'fieldwork' : 'all';
  const activeTab = page === 'list' ? listTab : page;
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
    setOnlyDecided(false);
    setOnlyMultiRound(false); setOnlyZeroPi(false); setOnlyConsider(false); setOnlyUrgent(false);
    setOnlyPassedAvoid(false); setOnlyToday(false); setFilterDate(null); setMaxGapEok(0);
    setType('all'); setQ('');
  };
  const openToday = () => { setPage('today'); setShowCfg(false); window.scrollTo(0, 0); };
  const openReview = () => { setPage('review'); setShowCfg(false); window.scrollTo(0, 0); };
  const openConfig = () => { setPage('list'); setShowCfg(true); window.scrollTo(0, 0); };
  const openList = (tab: ListTab) => {
    setPage('list'); setShowCfg(false);
    setOnlyPassed(tab === 'recommend'); setOnlyFavorite(tab === 'fav'); setOnlyDecided(tab === 'journal');
    if (tab === 'fieldwork') { setSort('fieldwork'); setSortDir('desc'); }
    else if (sort === 'fieldwork') { setSort('score'); setSortDir('desc'); }
    window.scrollTo(0, 0);
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

  const hiddenCount = stats.total - viewFull.length;
  const weekDays = Object.entries(stats.weekDist).sort();

  return (
    <div className="app">
      <aside className="sidebar" aria-label="내비게이션">
        <div className="brand">경매<span>매물 검토</span></div>
        <nav className="nav">
          <button className={activeTab === 'today' ? 'on' : ''} onClick={openToday}>오늘</button>
          <div className="nav-gap" />
          <button className={activeTab === 'all' ? 'on' : ''} onClick={() => openList('all')}>전체 매물{!loading && <em>{num(stats.total)}</em>}</button>
          <button className={activeTab === 'recommend' ? 'on' : ''} onClick={() => openList('recommend')}>추천{!loading && <em>{num(stats.passed)}</em>}</button>
          <button className={activeTab === 'fav' ? 'on' : ''} onClick={() => openList('fav')}>관심<em>{num(favCount)}</em></button>
          <button className={activeTab === 'journal' ? 'on' : ''} onClick={() => openList('journal')}>결정 기록<em>{num(decidedCount)}</em></button>
          <button className={activeTab === 'fieldwork' ? 'on' : ''} onClick={() => openList('fieldwork')}>임장</button>
          <div className="nav-gap" />
          <button className={activeTab === 'review' ? 'on' : ''} onClick={openReview}>복기</button>
        </nav>
        <div className="sidebar-foot">
          <button className={page === 'list' && showCfg ? 'on' : ''} onClick={openConfig}>조건 설정</button>
          <button className={`status status-${backendStatus.view.tone}`} onClick={backendStatus.reload} title={backendStatus.view.detail}>
            {backendStatus.view.label}
          </button>
        </div>
      </aside>

      <main className="main">
        <CrawlBanner status={lastCrawl} />
        {courtChoices && (
          <div className="notice" role="dialog" aria-label="법원 선택">
            <p>같은 사건번호가 여러 법원에 있습니다. 법원을 고르면 그 법원만 다시 조회합니다.</p>
            <div className="calc-row">
              {courtChoices.courts.map((court) => (
                <button key={court} type="button" className="link-btn" onClick={() => openCaseFromReview({ ...courtChoices.target, court })}>{court}</button>
              ))}
            </div>
          </div>
        )}
        {err && <Notice>API 연결 오류: {err} <br />백엔드(<code>{apiBase}</code>) 실행 확인 (<code>server/run.sh</code>).</Notice>}

        {page === 'today' && (
          <>
            <header className="page-head">
              <div>
                <h1>오늘</h1>
                <p className="page-sub">{TODAY_LABEL}{lastCrawl && lastCrawl.daysAgo < 900 ? ` · ${lastCrawl.date} 수집 기준` : ''}</p>
              </div>
            </header>

            <section className="summary" aria-label="요약">
              <button type="button" onClick={() => openList('all')}><span>전체 매물</span><b>{loading ? '–' : num(stats.total)}</b></button>
              <button type="button" onClick={() => openList('recommend')}><span>통과</span><b>{loading ? '–' : num(stats.passed)}</b></button>
              <button type="button" onClick={() => { openList('recommend'); setOnlyToday(true); setFilterDate(null); }}><span>오늘 기일</span><b>{loading ? '–' : num(stats.todayUrgent)}</b></button>
              <button type="button" onClick={() => { openList('recommend'); setOnlyUrgent(true); }}><span>7일 이내</span><b>{loading ? '–' : num(stats.week)}</b></button>
            </section>

            {weekDays.length > 0 && (
              <section className="section" aria-label="이번 주 기일">
                <div className="section-head"><h2>이번 주 기일</h2><p>통과 / 전체</p></div>
                <div className="week">
                  {weekDays.map(([date, { total, passed }]) => {
                    const d = saleDaysDiff(date);
                    const dayLabel = ['일', '월', '화', '수', '목', '금', '토'][new Date(date).getDay()]!;
                    return (
                      <button
                        key={date} type="button" className={date === TODAY ? 'is-today' : ''}
                        onClick={() => { openList('all'); setFilterDate(date); setOnlyToday(false); }}
                        title={`${date} ${dayLabel}요일 — 통과 ${passed}건 / 전체 ${total}건`}
                      >
                        <span className="week-label">{date === TODAY ? '오늘' : `${dayLabel}요일${d != null ? ` · D-${d}` : ''}`}</span>
                        <b>{num(passed)}<small>/ {num(total)}</small></b>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            <PrecisionInbox
              items={precisionItems}
              loading={precisionLoading}
              error={precisionError}
              onOpen={handleSelect}
              onReload={() => { void loadPrecision(); }}
              onLegacy={() => openList('all')}
            />

            {!loading && !err && triageCards.length > 0 && (
              <section className="section" aria-label="먼저 볼 물건">
                <div className="section-head"><h2>먼저 볼 물건</h2><p>통과 매물 중 기일이 가깝거나 인수·임장이 남은 건</p></div>
                <ul className="rows">
                  {triageCards.map((card) => (
                    <li key={`${card.kind}:${card.row.id}`}>
                      <button type="button" className="row-btn" onClick={() => handleSelect(card.row)}>
                        <span className={`row-kind kind-${card.tone}`}>{card.label}</span>
                        <span className="row-main">
                          <strong>{card.subtitle}</strong>
                          <em>{card.title} · {card.footLeft} · {card.footRight}</em>
                        </span>
                        <span className="row-metric">{card.metric}<small>{TRIAGE_METRIC[card.kind]}</small></span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <TodayActions
              actions={todayActions}
              loading={todayActionsLoading}
              error={todayActionsError}
              onOpenCase={openCaseFromReview}
            />

            <p className="disclaimer">
              본 분석은 참고용 정보이며 법률자문이 아닙니다. 정확성을 보장하지 않으며 최종 판단과 책임은 이용자에게 있습니다.
              입찰 전 등기부등본·매각물건명세서·현장을 직접 확인하고 변호사나 법무사와 상담하세요.
            </p>
          </>
        )}

        {page === 'list' && (
          <>
            <header className="page-head">
              <div>
                <h1>{LIST_TITLE[listTab]}</h1>
                <p className="page-sub">
                  {loading ? '불러오는 중' : `${num(view.length)}건`}
                  {!loading && viewFull.length > 0 && hiddenCount > 0 && (
                    <span title="조건 설정의 지역·가격 조건과 필터가 목록을 좁힙니다."> · 조건·필터로 {num(hiddenCount)}건 숨김</span>
                  )}
                </p>
              </div>
              <div className="page-actions">
                <div className="seg" role="group" aria-label="보기 방식">
                  <button type="button" className={viewMode === 'list' ? 'on' : ''} aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')}>목록</button>
                  <button type="button" className={viewMode === 'map' ? 'on' : ''} aria-pressed={viewMode === 'map'} onClick={() => setViewMode('map')}>지도</button>
                </div>
                <details className="menu">
                  <summary>더보기</summary>
                  <div className="menu-pop" onClick={closeMenu}>
                    <button type="button" onClick={() => setShowCfg((s) => !s)}>{showCfg ? '조건 닫기' : '조건 설정'}</button>
                    <button type="button" onClick={() => setShowLegend((s) => !s)}>{showLegend ? '도움말 닫기' : '도움말'}</button>
                    {favCount >= 2 && <button type="button" onClick={() => setShowCompare(true)}>관심 {favCount}건 비교</button>}
                    <button type="button" onClick={() => exportCSV(view)}>CSV 내보내기</button>
                    <div className="menu-sep" />
                    <button type="button" onClick={load}>새로고침</button>
                    <button type="button" onClick={() => runJob('crawl', '크롤')} title="법원경매 수집 실행">크롤 실행</button>
                    <button type="button" onClick={() => runJob('analyze', '분석')} title="권리·입지·점수 재분석">분석 실행</button>
                  </div>
                </details>
              </div>
            </header>

            <div className="tabs">
              {LIST_TABS.map((tab) => (
                <button key={tab} type="button" className={listTab === tab ? 'on' : ''} onClick={() => openList(tab)}>{LIST_TAB_SHORT[tab]}</button>
              ))}
            </div>

            <div className="toolbar">
              <input type="search" className="search" placeholder="주소·사건번호 검색" aria-label="주소·사건번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
              <select aria-label="종류" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="all">전체 종류</option>
                {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select aria-label="정렬" value={sort} onChange={(e) => handleSort(e.target.value as SortKey)}>
                <option value="score">점수순</option>
                <option value="trueSafety">진짜마진순</option>
                <option value="safety">안전마진순</option>
                <option value="sale">임박순</option>
                <option value="price">최저가순</option>
                <option value="appraisal">감정가순</option>
                <option value="assumed">인수금액순</option>
                <option value="gap">갭(소자본)순</option>
                <option value="fieldwork">임장 진행도순</option>
                <option value="competition">저경쟁순</option>
              </select>
              <details className={`filter-menu${activeFilterCount > 0 ? ' active' : ''}`}>
                <summary>필터{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}</summary>
                <div className="filter-pop">
                  <label><input type="checkbox" checked={onlyPassed} onChange={(e) => setOnlyPassed(e.target.checked)} /> 통과만</label>
                  <label><input type="checkbox" checked={onlyFavorite} onChange={(e) => setOnlyFavorite(e.target.checked)} /> 관심만</label>
                  <label><input type="checkbox" checked={onlyMultiRound} onChange={(e) => setOnlyMultiRound(e.target.checked)} /> 2차 이상 유찰</label>
                  <label><input type="checkbox" checked={hideExpired} onChange={(e) => setHideExpired(e.target.checked)} /> 기일 지난 매물 숨김</label>
                  <label title="명세서 미수집·공개 전·기재 없음으로 권리분석이 보류된 물건을 숨깁니다"><input type="checkbox" checked={hideIncomplete} onChange={(e) => setHideIncomplete(e.target.checked)} /> 권리자료 없는 물건 제외{stats.incompleteCount > 0 ? ` (${num(stats.incompleteCount)})` : ''}</label>
                  <div className="filter-sep" />
                  <label title="같은 사건의 여러 물건을 대표 1건으로 묶습니다"><input type="checkbox" checked={groupByCase} onChange={(e) => setGroupByCase(e.target.checked)} /> 같은 사건 묶어 보기</label>
                  <select aria-label="갭 제한" value={maxGapEok} onChange={(e) => setMaxGapEok(Number(e.target.value))}>
                    <option value={0}>갭 제한 없음</option>
                    <option value={0.5}>갭 5천만 이하</option>
                    <option value={1}>갭 1억 이하</option>
                    <option value={2}>갭 2억 이하</option>
                    <option value={3}>갭 3억 이하</option>
                  </select>
                  {activeFilterCount > 0 && <button type="button" className="filter-clear" onClick={resetFilters}>필터 초기화</button>}
                </div>
              </details>
            </div>

            {!loading && rows.length > 0 && (
              <div className="chips" role="group" aria-label="빠른 필터">
                {filterDate && <FilterChip on onClick={() => setFilterDate(null)} title="기일 필터 해제">{filterDate.slice(5).replace('-', '.')} 기일 ×</FilterChip>}
                {stats.todayUrgent > 0 && (
                  <FilterChip on={onlyToday} count={stats.todayUrgent} onClick={() => { setOnlyToday((v) => !v); setFilterDate(null); }} title="오늘 기일 매물만 표시">오늘 기일</FilterChip>
                )}
                {stats.week > 0 && <FilterChip on={onlyUrgent} count={stats.week} onClick={() => setOnlyUrgent((v) => !v)} title="7일 이내 기일 매물만 표시">7일 이내</FilterChip>}
                {stats.considerCount > 0 && (
                  <FilterChip on={onlyConsider} count={stats.considerCount} onClick={() => { setOnlyConsider((v) => !v); setOnlyPassed(false); }} title="보고서가 검토를 권장한 매물만 표시">검토 권장</FilterChip>
                )}
                {stats.zeroPiCount > 0 && (
                  <FilterChip on={onlyZeroPi} count={stats.zeroPiCount} onClick={() => { setOnlyZeroPi((z) => !z); setOnlyPassed(false); }} title="낙찰 후 전세 보증금으로 투자금 대부분을 회수할 수 있는 후보">무피 후보</FilterChip>
                )}
                {stats.passedAvoidCount > 0 && (
                  <FilterChip on={onlyPassedAvoid} count={stats.passedAvoidCount} onClick={() => { setOnlyPassedAvoid((v) => !v); setOnlyPassed(false); }} title="통과 기준은 충족하지만 보고서가 회피를 권고한 매물">통과·회피 권고</FilterChip>
                )}
                {stats.reviewCount > 0 && (
                  <FilterChip
                    on={cfg.includeReviewRequired} count={stats.reviewCount}
                    onClick={() => { setCfg((c) => ({ ...c, includeReviewRequired: !c.includeReviewRequired })); setOnlyPassed(true); }}
                    title="권리 검토필요 매물을 통과에 포함"
                  >검토필요 포함</FilterChip>
                )}
              </div>
            )}

            {showLegend && <Suspense fallback={null}><Legend cfg={cfg} /></Suspense>}
            {showCfg && <Suspense fallback={null}><ConfigPanel cfg={cfg} setCfg={setCfg} /></Suspense>}

            {loading && <SkeletonList />}

            {!loading && !err && view.length === 0 && (
              <div className="empty-state">
                {activeFilterCount > 0 || q.trim() || type !== 'all' ? (
                  <>
                    <p>조건에 맞는 매물이 없습니다.</p>
                    <button type="button" onClick={resetFilters}>모든 필터 초기화</button>
                  </>
                ) : (
                  <p>표시할 매물이 없습니다. 더보기에서 크롤과 분석을 실행하세요.</p>
                )}
              </div>
            )}

            {viewMode === 'map' && (
              <Suspense fallback={<div className="list-more">지도 불러오는 중…</div>}>
                <MapView items={mapPoints} onSelect={handleSelect} showAll={mapShowAll} onToggleShowAll={() => setMapShowAll((s) => !s)} />
              </Suspense>
            )}

            {viewMode === 'list' && view.length > 0 && !isMobile && (
              <table className="grid">
                <colgroup>
                  <col className="col-star" /><col className="col-photo" /><col />
                  <col className="col-price" /><col className="col-price" /><col className="col-margin" />
                  <col className="col-assumed" /><col className="col-rights" /><col className="col-score" /><col className="col-sale" />
                </colgroup>
                <thead>
                  <tr>
                    <th aria-label="관심" /><th aria-label="사진" /><th>소재지</th>
                    <ThSort col="appraisal" cur={sort} dir={sortDir} onSort={handleSort} className="num">감정가</ThSort>
                    <ThSort col="price" cur={sort} dir={sortDir} onSort={handleSort} className="num">최저가</ThSort>
                    <ThSort col="safety" cur={sort} dir={sortDir} onSort={handleSort} className="num"><span title="안전마진(시세 대비 최저가). 아랫줄은 취득비용을 반영한 진짜마진">마진</span></ThSort>
                    <ThSort col="assumed" cur={sort} dir={sortDir} onSort={handleSort} className="num cell-assumed">인수</ThSort>
                    <th>권리</th>
                    <ThSort col="score" cur={sort} dir={sortDir} onSort={handleSort} className="num">점수</ThSort>
                    <ThSort col="sale" cur={sort} dir={sortDir} onSort={handleSort}>기일</ThSort>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(({ item, sc }) => (
                    <ListingRow key={item.id} item={item} sc={sc} onSelect={handleSelect} onFav={toggleFav}
                      today={TODAY} groupByCase={groupByCase} caseSize={caseSizes.get(caseGroupKey(item.court, item.case_no)) ?? 1} />
                  ))}
                </tbody>
              </table>
            )}

            {viewMode === 'list' && view.length > 0 && isMobile && (
              <ul className="cards">
                {visible.map(({ item, sc }) => (
                  <ListingCard key={item.id} item={item} sc={sc} onSelect={handleSelect} onFav={toggleFav}
                    groupByCase={groupByCase} caseSize={caseSizes.get(caseGroupKey(item.court, item.case_no)) ?? 1} />
                ))}
              </ul>
            )}

            {viewMode === 'list' && !listDone && (
              <div ref={sentinelRef} className="list-more">{num(visible.length)} / {num(listTotal)}건 — 아래로 스크롤하면 이어서 표시합니다</div>
            )}
          </>
        )}

        {page === 'review' && !err && <ReviewPanel onOpenCase={openCaseFromReview} />}
      </main>

      {selected && <Suspense fallback={null}><Detail
        row={selected} onClose={closeDetail} onFav={() => toggleFav(selected)}
        loading={isDetailLoading(selected)}
        onPrev={selNavPrev} onNext={selNavNext} position={selNavPos}
        onDecisionSaved={updateCurrentDecision}
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
        <div className={`job-toast${jobStatus.ok ? '' : ' job-toast-err'}`} role="status" onClick={dismissJob}>
          {jobStatus.msg}
        </div>
      )}

      <nav className="tabbar" aria-label="하단 메뉴">
        <button className={page === 'today' ? 'on' : ''} onClick={openToday}>오늘</button>
        <button className={page === 'list' && !showCfg ? 'on' : ''} onClick={() => { setPage('list'); setShowCfg(false); window.scrollTo(0, 0); }}>매물</button>
        <button className={page === 'review' ? 'on' : ''} onClick={openReview}>복기</button>
        <button className={page === 'list' && showCfg ? 'on' : ''} onClick={openConfig}>조건</button>
      </nav>
    </div>
  );
}

type ListTab = 'all' | 'recommend' | 'fav' | 'journal' | 'fieldwork';
const LIST_TABS: ListTab[] = ['all', 'recommend', 'fav', 'journal', 'fieldwork'];
const LIST_TITLE: Record<ListTab, string> = { all: '전체 매물', recommend: '추천', fav: '관심', journal: '결정 기록', fieldwork: '임장' };
const LIST_TAB_SHORT: Record<ListTab, string> = { all: '전체', recommend: '추천', fav: '관심', journal: '기록', fieldwork: '임장' };
const TRIAGE_METRIC: Record<TriageKind, string> = { urgent: '마진', assumed: '인수·마진', recommend: '점수', fieldwork: '임장' };
const TODAY_LABEL = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
const num = (n: number) => n.toLocaleString('ko-KR');
const closeMenu = (e: ReactMouseEvent<HTMLElement>) => { e.currentTarget.closest('details')?.removeAttribute('open'); };

function FilterChip({ on, count, onClick, title, children }: {
  on: boolean; count?: number; onClick: () => void; title?: string; children: ReactNode;
}) {
  return (
    <button type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick} title={title}>
      {children}{count != null && <em>{num(count)}</em>}
    </button>
  );
}

/** 수집 상태 배너 — 차단·실패가 우선, 그다음 오래된 데이터. 정상이면 아무것도 그리지 않는다. */
function CrawlBanner({ status }: { status: CrawlStatus | null }) {
  if (status?.blocked) {
    return (
      <div className="banner banner-blocked" role="alert">
        <strong>수집 차단 의심</strong>
        법원경매 최근 수집이 차단되었거나 실패했습니다{status.daysAgo < 900 ? ` (마지막 정상 수집 ${status.daysAgo}일 전)` : ''}.
        집 IP 프록시(터널) 상태를 확인한 뒤 다시 시도하세요.
      </div>
    );
  }
  if (status?.stale) {
    return (
      <div className="banner banner-stale" role="alert">
        <strong>데이터 오래됨</strong>
        마지막 수집이 {status.daysAgo}일 전입니다. 새 매각기일 물건이 빠졌을 수 있습니다.
      </div>
    );
  }
  return null;
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

function ReviewPanel({ onOpenCase }: { onOpenCase: (target: ListingDetailTarget) => void }) {
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

  if (loading || error || !data) {
    return (
      <section aria-label="복기">
        <header className="page-head"><div><h1>복기</h1></div></header>
        <Notice>{loading ? '복기 지표를 불러오는 중…' : `복기 지표를 불러오지 못했습니다: ${error ?? '데이터 없음'}`}</Notice>
      </section>
    );
  }
  const s = data.summary;
  const ready = (s.miss_rate ?? 1) < 0.3 && s.sale_ratio_labels >= 150;
  const markdownLines = data.reportMarkdown.split('\n').filter((line) => /^\| (hist_gbr|random_forest|current_expected_bid|dummy_median|dummy_prior)/.test(line));
  const surpriseGroups = [
    ['overpriced', '예상보다 비싸게 낙찰'],
    ['avoid_but_sold', '회피·미통과인데 낙찰'],
    ['passed_but_unsold', '추천·통과했는데 유찰'],
  ] as const;
  return (
    <section aria-label="복기">
      <header className="page-head">
        <div>
          <h1>복기</h1>
          <p className="page-sub">지난 판단을 실제 결과와 맞춰 보는 오프라인 검증입니다. 추천·입찰가에는 자동 반영하지 않습니다.</p>
        </div>
        <span className={`review-gate${ready ? ' gate-ok' : ''}`}>{ready ? '채택 검토 가능' : '운영 반영 대기'}</span>
      </header>

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
        <h3>예상과 달랐던 사건</h3>
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
          <table className="mini-table"><thead><tr><th>사건</th><th>경과일</th><th>우선</th><th>점수</th></tr></thead><tbody>
            {data.retryQueue.slice(0, 12).map((r) => <tr key={`${r.court ?? ''}-${r.case_no}-${r.item_no}`}><td><button className="link-btn mono" onClick={() => onOpenCase({ caseNo: r.case_no, itemNo: r.item_no, ...(r.court ? { court: r.court } : {}) })}>{r.case_no}{r.item_no !== '1' ? `-${r.item_no}` : ''}{r.court ? ` · ${r.court}` : ''}</button></td><td>{r.days_overdue}</td><td>{r.retry_priority}</td><td>{r.total_score ?? '-'}</td></tr>)}
          </tbody></table>
        </div>
        <div className="review-card">
          <h3>권리 리스크 복기</h3>
          <table className="mini-table"><thead><tr><th>권리</th><th>건수</th><th>낙찰률</th><th>마진</th><th>대항력</th></tr></thead><tbody>
            {data.rightsRisk.map((r) => <tr key={r.risk_grade}><td>{RISK[r.risk_grade]?.label ?? r.risk_grade}</td><td>{r.rows}</td><td>{fmtRate(r.sold_rate)}</td><td>{fmtRate(r.median_proxy_margin)}</td><td>{r.opposition_rows}</td></tr>)}
          </tbody></table>
        </div>
      </div>

      <div className="review-grid2">
        <div className="review-card">
          <h3>입력 커버리지</h3>
          <table className="mini-table"><thead><tr><th>항목</th><th>건수</th><th>확보율</th></tr></thead><tbody>
            {data.featureCoverage.map((r) => <tr key={r.feature}><td>{FEATURE_LABEL[r.feature] ?? r.feature}</td><td>{r.non_null_rows.toLocaleString('ko-KR')}</td><td>{fmtRate(r.coverage)}</td></tr>)}
          </tbody></table>
        </div>
        <div className="review-card">
          <h3>지역×종류 중앙 낙찰가율</h3>
          <table className="mini-table"><thead><tr><th>종류</th><th>지역</th><th>건수</th><th>낙찰가율</th><th>마진</th></tr></thead><tbody>
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

function SurpriseTable({ title, rows, onOpenCase }: { title: string; rows: MlSurpriseRow[]; onOpenCase: (target: ListingDetailTarget) => void }) {
  return (
    <div className="surprise-box">
      <h4>{title}</h4>
      {rows.length === 0 ? <p className="muted">케이스 없음</p> : (
        <table className="mini-table surprise-table"><thead><tr><th>사건</th><th>주소</th><th>핵심</th><th>마진</th></tr></thead><tbody>
          {rows.map((r) => <tr key={`${r.surprise_kind}-${r.court ?? ''}-${r.case_no}-${r.item_no}`}>
            <td><button className="link-btn mono" onClick={() => onOpenCase({ caseNo: r.case_no, itemNo: r.item_no, ...(r.court ? { court: r.court } : {}) })}>{r.case_no}{r.item_no !== '1' ? `-${r.item_no}` : ''}{r.court ? ` · ${r.court}` : ''}</button></td>
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

function ListingPhoto({ item }: { item: ListingItem }) {
  return (
    <div className="listing-photo">
      {item.cover_photo_url && <img src={item.cover_photo_url} loading="lazy" decoding="async" alt={`${item.case_no} 대표사진`} />}
    </div>
  );
}

function caseLabel(r: ListingItem): string {
  return `${r.case_no}${r.item_no && r.item_no !== '1' ? `-${r.item_no}` : ''}`;
}

function typeLabel(r: ListingItem): string {
  return `${TYPE_LABEL[r.property_type] ?? r.property_type}${r.area_m2 != null ? ` ${r.area_m2.toFixed(0)}㎡` : ''}`;
}

/** 마진 칸 툴팁 — 시세 신뢰도와 ML 참고가(운영 미반영)를 글자로. 표에는 숫자만 둔다. */
function marginHint(r: ListingItem): string | undefined {
  const hints: string[] = [];
  if (r.location?.safety_margin == null) hints.push('시세 미확보 — 안전마진 산정 불가');
  else if (r.location.market_confidence === 'low') hints.push('시세 추정 신뢰도 낮음(표본 부족)');
  const ml = calibrationHint(r);
  if (ml) hints.push(`${ml} · 운영 반영 전 참고용`);
  return hints.length ? hints.join(' · ') : undefined;
}

/** 권리 칸 아랫줄 — 보고서 권고·위험 건수·저경쟁을 색 없이 글자로. 위험·회피만 빨강. */
function rightsNotes(r: ListingItem, sc: ClientScore): { text: string; cls?: string; hint: string }[] {
  const report = r.location?.report;
  const out: { text: string; cls?: string; hint: string }[] = [];
  if (report?.recommendation === 'consider') out.push({ text: '검토 권장', hint: '보고서가 검토를 권장' });
  if (sc.passed && report?.recommendation === 'avoid') out.push({ text: '회피 권고', cls: 'neg', hint: '점수는 통과 기준이지만 보고서가 회피 권고 — 상세 확인 필요' });
  if ((report?.dangerCount ?? 0) > 0) out.push({ text: `위험 ${report!.dangerCount}`, cls: 'neg', hint: `위험항목 ${report!.dangerCount}건` });
  else if ((report?.warnCount ?? 0) > 0) out.push({ text: `주의 ${report!.warnCount}`, hint: `주의항목 ${report!.warnCount}건` });
  if (sc.competitionScore != null && sc.competitionScore >= 70) out.push({ text: '저경쟁', hint: `저경쟁 — 조회 ${r.inq_cnt ?? '?'}·관심 ${r.interest_cnt ?? 0}` });
  return out;
}

const ListingRow = memo(function ListingRow({ item: r, sc, onSelect, onFav, today, groupByCase, caseSize }: RowBaseProps & { today: string }) {
  const risk = RISK[r.rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
  const incomplete = r.location?.report?.headline?.startsWith('[데이터 불완전]') ?? false;
  const safety = r.location?.safety_margin;
  const trueMargin = r.location?.acquisition_cost?.trueSafetyMargin;
  const lowConf = r.location?.market_confidence === 'low';
  const round = resolveRound(r.location?.sale_rounds ?? [], r.sale_date, r.fail_count);
  const isNew = r.crawled_at != null && r.crawled_at.slice(0, 10) >= today;
  const notes = rightsNotes(r, sc);
  const open = () => onSelect(r);
  return (
    <tr className="row">
      <td className="star" onClick={() => onFav(r)} title="관심"><span className={r.is_favorite ? 'on' : ''}>{r.is_favorite ? '★' : '☆'}</span></td>
      <td onClick={open}><ListingPhoto item={r} /></td>
      <td onClick={open} title={r.address}>
        <span className="addr-main">{r.address}</span>
        <span className="addr-sub">
          {caseLabel(r)} · {typeLabel(r)}
          {isNew && <span className="meta-new" title={`신규 수집: ${r.crawled_at!.slice(0, 10)}`}> · 신규</span>}
          {groupByCase && caseSize > 1 && <span title={`이 사건에 물건 ${caseSize}개 — 대표 1건만 표시`}> · 외 {caseSize - 1}물건</span>}
          <FieldProgress r={r} />
        </span>
      </td>
      <td className="num" onClick={open}>{eok(r.appraisal_value)}</td>
      <td className="num" onClick={open}><b>{eok(r.min_bid_price)}</b></td>
      <td className="num" onClick={open} title={marginHint(r)}>
        {safety == null ? <span className="muted">–</span> : <b className={safety < 0 ? 'neg' : undefined}>{pct(safety)}</b>}
        <span className="cell-sub">
          {trueMargin != null && <span className={trueMargin < 0 ? 'neg' : undefined}>진짜 {pct(trueMargin)}</span>}
          {lowConf && safety != null && <span className="warn"> · 저신뢰</span>}
        </span>
      </td>
      <td className="num cell-assumed" onClick={open}>
        {r.rights ? (r.rights.assumed_amount ? <b className="neg">{eok(r.rights.assumed_amount)}</b> : <span className="muted">0</span>) : '-'}
      </td>
      <td onClick={open} title={notes.map((n) => n.hint).join(' · ') || undefined}>
        {incomplete
          ? <span className="badge badge-incomplete" title={r.location?.report?.headline}>권리자료 없음</span>
          : <span className={`badge ${risk.cls}`}>{risk.label}</span>}
        {notes.length > 0 && (
          <span className="cell-sub">
            {notes.map((n, i) => <span key={n.text} className={n.cls}>{i > 0 ? ' · ' : ''}{n.text}</span>)}
          </span>
        )}
      </td>
      <td className="num" onClick={open} title={[scoreBreakdown(sc), ...(sc.reasons.length ? ['—', ...sc.reasons] : [])].join(' · ')}>
        <b>{sc.totalScore}</b>
        {!sc.passed && <span className="cell-sub">미통과</span>}
      </td>
      <td onClick={open} title={r.sale_date ?? undefined}>
        {r.sale_date ? r.sale_date.slice(5).replace('-', '.') : '-'}
        <span className="cell-sub">
          <DDay dateStr={r.sale_date} />
          {round && round.n > 1 && (
            <span className="round-badge" title={round.est ? '분석 후 재매각기일 갱신 — 차수 추정값' : undefined}> · {round.n}차{round.est ? '+' : ''}</span>
          )}
        </span>
      </td>
    </tr>
  );
});

const ListingCard = memo(function ListingCard({ item: r, sc, onSelect, onFav, groupByCase, caseSize }: RowBaseProps) {
  const risk = RISK[r.rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
  const reco = r.location?.report?.recommendation;
  const margin = r.location?.acquisition_cost?.trueSafetyMargin ?? r.location?.safety_margin;
  const assumed = r.rights?.assumed_amount ?? 0;
  const round = resolveRound(r.location?.sale_rounds ?? [], r.sale_date, r.fail_count);
  const incomplete = r.location?.report?.headline?.startsWith('[데이터 불완전]') ?? false;
  return (
    <li className="card" onClick={() => onSelect(r)}>
      <div className="card-top">
        <ListingPhoto item={r} />
        <div className="card-body">
          <span className="card-addr">{r.address}</span>
          <span className="card-sub">
            {caseLabel(r)} · {typeLabel(r)}
            {groupByCase && caseSize > 1 && ` · 외 ${caseSize - 1}물건`}
          </span>
        </div>
        <button
          type="button" className={`card-star${r.is_favorite ? ' on' : ''}`} aria-label="관심" aria-pressed={!!r.is_favorite}
          onClick={(e) => { e.stopPropagation(); onFav(r); }}
        >{r.is_favorite ? '★' : '☆'}</button>
      </div>
      <div className="card-metrics">
        <div><span>최저가{round && round.n > 1 ? ` · ${round.n}차` : ''}</span><b>{eok(r.min_bid_price)}</b></div>
        <div><span>감정가</span><b>{eok(r.appraisal_value)}</b></div>
        <div><span>진짜마진</span><b className={(margin ?? 0) < 0 ? 'neg' : undefined}>{pct(margin)}</b></div>
        <div title={scoreBreakdown(sc)}><span>점수</span><b>{sc.totalScore}</b></div>
      </div>
      <div className="card-foot">
        {incomplete
          ? <span className="badge badge-incomplete" title={r.location?.report?.headline}>권리자료 없음</span>
          : <span className={`badge ${risk.cls}`} title={r.rights?.red_flags?.map((f) => f.message).join(' | ')}>{risk.label}</span>}
        {reco && <span>{RECO[reco]?.label ?? reco}</span>}
        {assumed > 0 && <span className="neg">인수 {eok(assumed)}</span>}
        {r.location?.income?.zeroPiCandidate && <span>무피 후보</span>}
        <FieldProgress r={r} />
        <DDay dateStr={r.sale_date} />
      </div>
    </li>
  );
});

// REGIONS·PRICE_BANDS·ALLOWED_TYPES는 ConfigPanel.tsx로 이동

// ConfigPanel은 ./ConfigPanel.tsx로 분리

// exportCSV/buildCsv는 ./export-csv.ts로 분리
