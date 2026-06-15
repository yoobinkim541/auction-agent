import { useEffect, useMemo, useState } from 'react';
import {
  fetchListings, triggerJob, setFavorite, apiBase, won, eok,
  type ListingItem, type RightsObj, type LocationObj,
} from './api.ts';
import { scoreClient, DEFAULT_CONFIG, type ScoreConfig } from './scoring.ts';

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

type SortKey = 'score' | 'safety' | 'sale';
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
  const [type, setType] = useState('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('score');
  const [selected, setSelected] = useState<ListingItem | null>(null);
  const [cfg, setCfg] = useState<ScoreConfig>(loadConfig);
  const [showCfg, setShowCfg] = useState(false);

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
    if (type !== 'all') v = v.filter((x) => x.item.property_type === type);
    if (q.trim()) v = v.filter((x) => x.item.address.includes(q.trim()) || x.item.case_no.includes(q.trim()));
    v.sort((a, b) => {
      if (sort === 'safety') return (b.item.location?.safety_margin ?? -1) - (a.item.location?.safety_margin ?? -1);
      if (sort === 'sale') return (b.item.sale_date ?? '').localeCompare(a.item.sale_date ?? '');
      return b.sc.totalScore - a.sc.totalScore;
    });
    return v;
  }, [rows, cfg, onlyPassed, onlyFavorite, type, q, sort]);

  const favCount = rows.filter((r) => r.is_favorite).length;

  return (
    <div className="app">
      <header>
        <h1>경매 매물 분석 <span className="sub">권리분석 · 입지분석</span></h1>
        <p className="disclaimer">
          ⚠️ 본 분석은 <b>참고용 정보</b>이며 법률자문이 아닙니다. 정확성을 보장하지 않으며 최종 판단·책임은 이용자에게 있습니다.
          입찰 전 반드시 등기부등본·매각물건명세서·현장 확인 및 변호사/법무사 상담을 권장합니다.
        </p>
      </header>

      <div className="controls">
        <label><input type="checkbox" checked={onlyPassed} onChange={(e) => setOnlyPassed(e.target.checked)} /> 통과만</label>
        <label><input type="checkbox" checked={onlyFavorite} onChange={(e) => setOnlyFavorite(e.target.checked)} /> ★관심만 ({favCount})</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">전체 종류</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input placeholder="주소·사건번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="score">점수순</option>
          <option value="safety">안전마진순</option>
          <option value="sale">매각기일순</option>
        </select>
        <button onClick={() => setShowCfg((s) => !s)}>{showCfg ? '조건 닫기' : '⚙ 조건·기준'}</button>
        <button onClick={load}>새로고침</button>
        <button onClick={() => triggerJob('crawl')} title="더낙찰옥션 크롤">크롤</button>
        <button onClick={() => triggerJob('analyze')} title="분석 실행">분석</button>
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
              <th>안전마진</th><th>인수금액</th><th>권리</th><th>점수</th>
            </tr>
          </thead>
          <tbody>
            {view.map(({ item: r, sc }) => {
              const risk = RISK[r.rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
              return (
                <tr key={r.id} className="row">
                  <td className="star" onClick={() => toggleFav(r)} title="관심">{r.is_favorite ? '★' : '☆'}</td>
                  <td className="mono" onClick={() => setSelected(r)}>{r.case_no}</td>
                  <td onClick={() => setSelected(r)}>{TYPE_LABEL[r.property_type] ?? r.property_type}</td>
                  <td className="addr" onClick={() => setSelected(r)}>{r.address}</td>
                  <td className="num" onClick={() => setSelected(r)}>{eok(r.appraisal_value)}</td>
                  <td className="num" onClick={() => setSelected(r)}>{eok(r.min_bid_price)}</td>
                  <td className="num" onClick={() => setSelected(r)}>{pct(r.location?.safety_margin)}</td>
                  <td className="num" onClick={() => setSelected(r)}>{r.rights ? (r.rights.assumed_amount ? eok(r.rights.assumed_amount) : '0') : '-'}</td>
                  <td onClick={() => setSelected(r)}><span className={`badge ${risk.cls}`}>{risk.label}</span></td>
                  <td className="num" onClick={() => setSelected(r)}><b>{sc.totalScore}</b></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selected && <Detail row={selected} onClose={() => setSelected(null)} onFav={() => toggleFav(selected)} />}
    </div>
  );
}

const REGIONS = ['서울', '경기', '인천'];

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

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="notice">{children}</div>;
}

function Detail({ row, onClose, onFav }: { row: ListingItem; onClose: () => void; onFav: () => void }) {
  const rights: RightsObj | null = row.rights;
  const loc: LocationObj | null = row.location;
  const risk = RISK[rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
  return (
    <div className="drawer-bg" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>✕</button>
        <h2>
          <span className="star" onClick={onFav} title="관심">{row.is_favorite ? '★' : '☆'}</span>{' '}
          {row.case_no} <span className={`badge ${risk.cls}`}>{risk.label}</span>
        </h2>
        <p className="addr">{row.address} · {TYPE_LABEL[row.property_type]} · {row.court}</p>

        <div className="kv">
          <div><span>감정가</span><b>{eok(row.appraisal_value)}</b></div>
          <div><span>최저매각가</span><b>{eok(row.min_bid_price)}</b></div>
          <div><span>추정시세</span><b>{eok(loc?.market_price)}{loc?.market_confidence ? ` · 신뢰도 ${CONF[loc.market_confidence]}` : ''}</b></div>
          <div><span>예상낙찰가</span><b>{eok(loc?.expected_bid_price)}</b></div>
          <div><span>안전마진(최저가)</span><b>{pct(loc?.safety_margin)}</b></div>
          <div><span title="시세 − 총취득비용(취득세·명도비·채권·인수 포함)">진짜 안전마진</span><b className={(loc?.acquisition_cost?.trueSafetyMargin ?? 0) < 0 ? 'danger' : ''}>{pct(loc?.acquisition_cost?.trueSafetyMargin)}</b></div>
          <div><span>총 인수금액</span><b className={rights?.assumed_amount ? 'danger' : ''}>{won(rights?.assumed_amount ?? 0)}</b></div>
          <div><span>최대안전입찰가</span><b>{won(rights?.max_safe_bid)}</b></div>
        </div>

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

        {loc?.acquisition_cost && (
          <Section title="취득비용 · 진짜 안전마진">
            <p className="muted">가정 낙찰가: {won(loc.acquisition_cost.bidPrice)} ({loc.acquisition_cost.bidBasis})</p>
            <table className="mini">
              <tbody>
                <tr><td>낙찰가</td><td className="num">{won(loc.acquisition_cost.bidPrice)}</td></tr>
                <tr><td>취득세 ({loc.acquisition_cost.acqTaxRatePct}%)</td><td className="num">{won(loc.acquisition_cost.acqTax)}</td></tr>
                <tr><td>명도비</td><td className="num">{won(loc.acquisition_cost.moveOutCost)}</td></tr>
                <tr><td>국민주택채권(본인부담)</td><td className="num">{won(loc.acquisition_cost.bondCost)}</td></tr>
                {loc.acquisition_cost.assumedAmount > 0 && <tr><td className="danger">권리 인수금액</td><td className="num danger">{won(loc.acquisition_cost.assumedAmount)}</td></tr>}
                <tr className="total"><td><b>총 취득비용</b></td><td className="num"><b>{won(loc.acquisition_cost.totalCost)}</b></td></tr>
                <tr><td><b>진짜 안전마진</b> (시세 대비)</td><td className="num"><b className={(loc.acquisition_cost.trueSafetyMargin ?? 0) < 0 ? 'danger' : ''}>{pct(loc.acquisition_cost.trueSafetyMargin)}</b></td></tr>
              </tbody>
            </table>
            {loc.acquisition_cost.notes.length > 0 && (
              <ul className="warns">{loc.acquisition_cost.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            )}
            <p className="muted">※ 취득세·채권은 개인 1주택 가정·참고용 추정. 등기 시점 위택스·주택도시기금 재확인 필요.</p>
          </Section>
        )}

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
