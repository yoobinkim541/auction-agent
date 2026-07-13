import { useState, useEffect } from 'react';
import { eok, won, pct, type ListingItem, type RightsObj, type LocationObj } from './api.ts';
import { RISK, TYPE_LABEL, KIND_LABEL } from './labels.ts';
import { resolveRound } from './listing-utils.ts';
import { Section } from './ui.tsx';
import { EvictionBlock, IncomeBlock, ReportBlock, FieldVisitChecklist } from './detail-blocks.tsx';
import { CostCalculator } from './CostCalculator.tsx';

const CONF: Record<string, string> = { high: '높음', medium: '보통', low: '낮음' };

/** 매물 상세 드로어 — 권리/입지/취득비용·현장모드·키보드 내비게이션(←/→/o/c/f/Esc). */
export function Detail({ row, onClose, onFav, loading, onPrev, onNext, position }: {
  row: ListingItem; onClose: () => void; onFav: () => void;
  loading?: boolean; onPrev?: () => void; onNext?: () => void; position?: string;
}) {
  const rights: RightsObj | null = row.rights;
  const loc: LocationObj | null = row.location;
  const risk = RISK[rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };

  const [copied, setCopied] = useState(false);
  const [fieldMode, setFieldMode] = useState(false);
  const fieldwork = loc?.report?.fieldwork;
  const courtCheckUrl = row.court_check_url ?? (row.source === 'courtauction' ? row.source_url : null) ?? 'https://www.courtauction.go.kr/pgj/index.on';
  const deonakchalCheckUrl = row.deonakchal_check_url ?? (row.source === 'deonakchal' ? row.source_url : null) ?? 'https://www.xn--b20bu5cuwtpue8ui.com/auction/list.html';
  const itemHint = row.item_no && row.item_no !== '1' ? ` · 물건 ${row.item_no}` : '';
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
      if (e.key === 'o' && courtCheckUrl && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as Element)?.tagName)) {
        e.preventDefault();
        window.open(courtCheckUrl, '_blank', 'noopener,noreferrer');
      }
      if (e.key === 'd' && deonakchalCheckUrl && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as Element)?.tagName)) {
        e.preventDefault();
        window.open(deonakchalCheckUrl, '_blank', 'noopener,noreferrer');
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
  }, [onClose, onPrev, onNext, courtCheckUrl, deonakchalCheckUrl, row.case_no, onFav]);

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
            <div className="srclinks">
              <p className="srclink"><a href={courtCheckUrl} target="_blank" rel="noopener noreferrer">🔗 법원경매 더블체크{itemHint} ↗</a></p>
              <p className="srclink"><a href={deonakchalCheckUrl} target="_blank" rel="noopener noreferrer">🔎 더낙찰 더블체크{itemHint} ↗</a></p>
            </div>
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
        <div className="srclinks">
          <p className="srclink"><a href={courtCheckUrl} target="_blank" rel="noopener noreferrer">🔗 법원경매 더블체크{itemHint}(사건번호 ⧉ 복사 후 검색) ↗</a> <span className="key-hint" title="단축키">o</span></p>
          <p className="srclink"><a href={deonakchalCheckUrl} target="_blank" rel="noopener noreferrer">🔎 더낙찰 더블체크{itemHint} ↗</a> <span className="key-hint" title="단축키">d</span></p>
        </div>
        {row.source === 'courtauction' && (
          (rights?.malso_basis || (rights?.classified && rights.classified.length > 0)) ? (
            <div className="court-notice court-notice-soft" role="note">
              ℹ️ <strong>법원 매각물건명세서 기반</strong> — 최선순위설정·비고로 권리분석했습니다. 등기부 원본·임차인 상세는 입찰 전 <a href="https://www.courtauction.go.kr" target="_blank" rel="noopener noreferrer">법원경매정보</a>에서 직접 확인 권장.
            </div>
          ) : (
            <div className="court-notice" role="alert">
              ⚠️ <strong>법원경매 원천</strong> — 등기/명세서 미수집(상세 조회 실패). 권리분석 보류 — 입찰 전 반드시 <a href="https://www.courtauction.go.kr" target="_blank" rel="noopener noreferrer">법원경매정보</a>에서 직접 확인하세요.
            </div>
          )
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
          {(row.inq_cnt != null || row.interest_cnt != null) && (
            <div><span title="법원경매 조회수·관심물건 등록수 — 낮을수록 저경쟁(남들이 덜 본 매물)">경쟁(조회·관심)</span><b>{row.inq_cnt ?? '?'} · {row.interest_cnt ?? 0}</b></div>
          )}
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
                    <td>{KIND_LABEL[c.entry.kind] ?? c.entry.kind}</td><td className="mono">{c.entry.receiptDate}</td>
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
