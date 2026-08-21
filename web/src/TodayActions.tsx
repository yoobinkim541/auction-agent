import type { TodayAction, TodayActionType } from './api.ts';

const LABELS: Record<TodayActionType, string> = {
  recrawl_needed: '재수집',
  rights_enrichment: '권리보강',
  bid_soon: '입찰임박',
  fieldwork: '현장확인',
  review_result: '결과복기',
};

function itemLabel(action: TodayAction): string {
  return action.item_no && action.item_no !== '1'
    ? `${action.case_no} · 물건 ${action.item_no}`
    : action.case_no;
}

export function TodayActions({ actions, loading, error, onOpenCase }: {
  actions: TodayAction[];
  loading: boolean;
  error: string | null;
  onOpenCase: (caseNo: string) => void;
}) {
  const visible = actions.slice(0, 8);
  const hidden = Math.max(0, actions.length - visible.length);

  return (
    <details className="today-actions" aria-label="운영·보강 상태">
      <summary className="today-actions-head">
        <div>
          <span className="today-actions-kicker">운영·보강 상태</span>
          <b>{loading ? '불러오는 중…' : `${actions.length}건`}</b>
        </div>
        {hidden > 0 && <span className="today-actions-more">외 {hidden}건</span>}
      </summary>
      {error ? (
        <p className="today-actions-error">할 일 큐를 불러오지 못했습니다: {error}</p>
      ) : !loading && visible.length === 0 ? (
        <p className="today-actions-error">현재 보강이 필요한 운영 항목이 없습니다.</p>
      ) : (
        <div className="today-actions-list">
          {visible.map((action) => (
            <button
              key={`${action.action_type}:${action.listing_id}:${action.due_date ?? ''}`}
              className={`today-action-card today-action-${action.severity}`}
              onClick={() => onOpenCase(action.case_no)}
              title={action.reason}
            >
              <span className="today-action-type">{LABELS[action.action_type]}</span>
              <strong>{action.title}</strong>
              <span className="today-action-case">{itemLabel(action)}</span>
              <span className="today-action-reason">{action.reason}</span>
              {action.due_date && <span className="today-action-date">{action.due_date}</span>}
            </button>
          ))}
        </div>
      )}
    </details>
  );
}
