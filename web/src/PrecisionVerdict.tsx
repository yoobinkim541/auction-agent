import { won, type PrecisionObj } from './api.ts';
import { canShowBid, confidenceLabel, precisionView } from './precision.ts';

function VerdictList({ title, entries, className }: { title: string; entries: string[]; className: string }) {
  return (
    <div className={className}>
      <h4>{title}</h4>
      {entries.length > 0 ? <ul>{entries.map((entry) => <li key={entry}>{entry}</li>)}</ul> : <p>등록된 항목 없음</p>}
    </div>
  );
}

export function PrecisionVerdict({ precision }: { precision?: PrecisionObj | null }) {
  if (!precision) {
    return (
      <section className="precision-verdict precision-verdict-unknown" aria-labelledby="precision-verdict-title">
        <span className="precision-kicker">PRECISION VERDICT</span>
        <h3 id="precision-verdict-title">정밀 추천 데이터 없음 — 전체 목록은 정밀 추천이 아닙니다</h3>
      </section>
    );
  }

  const view = precisionView(precision);
  const showBid = canShowBid(precision);
  return (
    <section className={`precision-verdict precision-verdict-${view.tone}`} aria-labelledby="precision-verdict-title">
      <div className="precision-verdict-head">
        <div>
          <span className="precision-kicker">PRECISION VERDICT</span>
          <h3 id="precision-verdict-title">{view.label}</h3>
        </div>
        <span className="precision-confidence">신뢰도 {confidenceLabel(precision.confidence)}</span>
      </div>
      <p className="precision-verdict-summary">{view.summary}</p>
      <div className="precision-verdict-lists">
        <VerdictList title="강점" entries={precision.strengths} className="precision-strengths" />
        <VerdictList title="리스크" entries={precision.risks} className="precision-risks" />
        <VerdictList title="필수 확인" entries={precision.required_checks} className="precision-checks" />
      </div>
      <dl className="precision-metrics">
        <div><dt>보수적 가치</dt><dd>{won(precision.conservative_value)}</dd></div>
        {showBid ? <>
          <div><dt>권장 입찰가</dt><dd>{won(precision.recommended_bid)}</dd></div>
          <div className="precision-hard-cap"><dt>절대 상한</dt><dd>{won(precision.hard_cap_bid)}</dd></div>
        </> : <div><dt>입찰가</dt><dd>추천 상태가 아니면 표시하지 않습니다</dd></div>}
        <div><dt>평가 시각</dt><dd>{new Date(precision.evaluated_at).toLocaleString('ko-KR')}</dd></div>
      </dl>
      <p className="precision-evaluator">평가 버전 {precision.evaluator_version}</p>
    </section>
  );
}
