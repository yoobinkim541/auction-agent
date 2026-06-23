import { useState, useEffect } from 'react';
import { Section } from './ui.tsx';
import { RECO } from './labels.ts';
import { won, eok, fetchFieldworkNotes, saveFieldworkNote, type EvictionObj, type IncomeObj, type ReportObj } from './api.ts';

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

/** 현장 임장 체크리스트 — 항목별 체크+메모(gm_fieldwork_notes에 저장, 재분석에도 보존). */
export function FieldVisitChecklist({ listingId, items, big }: {
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

/** 매물별 종합 보고서 + 법적 리스크 + 입찰 전 체크리스트 + 용어 풀이. */
export function ReportBlock({ report, listingId }: { report: ReportObj; listingId: number }) {
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
