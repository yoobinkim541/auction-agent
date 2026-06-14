import { useEffect, useMemo, useState } from 'react';
import {
  fetchListings, supabaseReady, won, eok,
  type ListingRow, type RightsRow, type LocationRow, type ScoreRow,
} from './supabase.ts';

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

const first = <T,>(a: T[] | null | undefined): T | undefined => (a && a.length ? a[0] : undefined);
const pct = (n: number | null | undefined) => (n == null ? '-' : (n * 100).toFixed(1) + '%');

type SortKey = 'score' | 'safety' | 'sale';

export default function App() {
  const [rows, setRows] = useState<ListingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [onlyPassed, setOnlyPassed] = useState(true);
  const [type, setType] = useState<string>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('score');
  const [selected, setSelected] = useState<ListingRow | null>(null);

  useEffect(() => {
    if (!supabaseReady) { setLoading(false); return; }
    fetchListings().then(setRows).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  }, []);

  const view = useMemo(() => {
    let v = rows.slice();
    if (onlyPassed) v = v.filter((r) => first(r.gm_scores)?.passed_filter);
    if (type !== 'all') v = v.filter((r) => r.property_type === type);
    if (q.trim()) v = v.filter((r) => r.address.includes(q.trim()) || r.case_no.includes(q.trim()));
    v.sort((a, b) => {
      if (sort === 'score') return (first(b.gm_scores)?.total_score ?? -1) - (first(a.gm_scores)?.total_score ?? -1);
      if (sort === 'safety') return (first(b.gm_location_analysis)?.safety_margin ?? -1) - (first(a.gm_location_analysis)?.safety_margin ?? -1);
      return (b.sale_date ?? '').localeCompare(a.sale_date ?? '');
    });
    return v;
  }, [rows, onlyPassed, type, q, sort]);

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
        <label><input type="checkbox" checked={onlyPassed} onChange={(e) => setOnlyPassed(e.target.checked)} /> 통과 매물만</label>
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
        <span className="count">{view.length}건</span>
      </div>

      {!supabaseReady && <Notice>환경변수가 설정되지 않았습니다. <code>web/.env</code>에 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY를 넣으세요.</Notice>}
      {loading && <Notice>불러오는 중…</Notice>}
      {err && <Notice>오류: {err}</Notice>}
      {supabaseReady && !loading && !err && view.length === 0 && (
        <Notice>표시할 매물이 없습니다. 크롤러(<code>npm run crawl</code>)와 분석(<code>npm run analyze</code>)을 먼저 실행하세요.</Notice>
      )}

      {view.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>사건번호</th><th>종류</th><th>소재지</th><th>감정가</th><th>최저가</th>
              <th>안전마진</th><th>인수금액</th><th>권리</th><th>점수</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => {
              const rights = first(r.gm_rights_analysis);
              const loc = first(r.gm_location_analysis);
              const score = first(r.gm_scores);
              const risk = RISK[rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
              return (
                <tr key={r.id} onClick={() => setSelected(r)} className="row">
                  <td className="mono">{r.case_no}</td>
                  <td>{TYPE_LABEL[r.property_type] ?? r.property_type}</td>
                  <td className="addr">{r.address}</td>
                  <td className="num">{eok(r.appraisal_value)}</td>
                  <td className="num">{eok(r.min_bid_price)}</td>
                  <td className="num">{pct(loc?.safety_margin)}</td>
                  <td className="num">{rights ? (rights.assumed_amount ? eok(rights.assumed_amount) : '0') : '-'}</td>
                  <td><span className={`badge ${risk.cls}`}>{risk.label}</span></td>
                  <td className="num"><b>{score?.total_score ?? '-'}</b></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selected && <Detail row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="notice">{children}</div>;
}

function Detail({ row, onClose }: { row: ListingRow; onClose: () => void }) {
  const rights: RightsRow | undefined = row.gm_rights_analysis?.[0] ?? undefined;
  const loc: LocationRow | undefined = row.gm_location_analysis?.[0] ?? undefined;
  const score: ScoreRow | undefined = row.gm_scores?.[0] ?? undefined;
  const risk = RISK[rights?.risk_grade ?? ''] ?? { label: '-', cls: '' };
  return (
    <div className="drawer-bg" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>✕</button>
        <h2>{row.case_no} <span className={`badge ${risk.cls}`}>{risk.label}</span></h2>
        <p className="addr">{row.address} · {TYPE_LABEL[row.property_type]} · {row.court}</p>

        <div className="kv">
          <div><span>감정가</span><b>{eok(row.appraisal_value)}</b></div>
          <div><span>최저매각가</span><b>{eok(row.min_bid_price)}</b></div>
          <div><span>추정시세</span><b>{eok(loc?.market_price)}</b></div>
          <div><span>안전마진</span><b>{pct(loc?.safety_margin)}</b></div>
          <div><span>총 인수금액</span><b className={rights?.assumed_amount ? 'danger' : ''}>{won(rights?.assumed_amount ?? 0)}</b></div>
          <div><span>최대안전입찰가</span><b>{won(rights?.max_safe_bid)}</b></div>
          <div><span>점수</span><b>{score?.total_score ?? '-'}</b></div>
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

        <Section title="입지분석">
          <div className="kv">
            <div><span>최근접역</span><b>{loc?.transit?.nearestStation ?? '-'}{loc?.transit?.walkMinutes ? ` (도보 ${loc.transit.walkMinutes}분)` : ''}</b></div>
            <div><span>학교/학원</span><b>{loc?.schools?.schoolCount ?? '-'} / {loc?.schools?.academyCount ?? '-'}</b></div>
          </div>
          {loc?.amenities && (
            <div className="amen">
              {Object.entries(loc.amenities).map(([k, v]) => <span key={k}>{k}: {v}</span>)}
            </div>
          )}
        </Section>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="sect"><h3>{title}</h3>{children}</section>;
}
