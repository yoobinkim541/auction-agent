import { Section } from './ui.tsx';
import { won, eok, type EvictionObj, type IncomeObj } from './api.ts';

const DIFF: Record<string, { label: string; cls: string }> = {
  easy: { label: '쉬움', cls: 'reco-consider' }, medium: { label: '보통', cls: 'reco-caution' }, hard: { label: '어려움', cls: 'reco-avoid' },
};

/** 명도 난이도·인도명령·비용/기간 */
export function EvictionBlock({ ev }: { ev: EvictionObj }) {
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
export function IncomeBlock({ income: inc }: { income: IncomeObj }) {
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
