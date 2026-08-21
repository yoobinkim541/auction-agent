import type { ListingItem } from './api.ts';
import { canShowBid, confidenceLabel, decisionLabel, precisionView } from './precision.ts';
import { won } from './api.ts';

export function PrecisionInbox({ items, loading, error, onOpen, onLegacy, onReload }: {
  items: ListingItem[];
  loading: boolean;
  error: string | null;
  onOpen: (item: ListingItem) => void;
  onLegacy: () => void;
  onReload: () => void;
}) {
  const recommended = items.filter((item) => item.precision?.status === 'recommended').slice(0, 7);

  return (
    <section className="precision-inbox" aria-labelledby="precision-inbox-title">
      <header className="precision-inbox-head">
        <div>
          <span className="precision-kicker">PRECISION INBOX</span>
          <h2 id="precision-inbox-title">이번 주 정밀 추천</h2>
          <p>권리·점유·현금흐름 검증을 통과한 건만 표시합니다. 전체 후보 목록이 아닙니다.</p>
        </div>
        <button type="button" className="precision-reload" onClick={onReload} disabled={loading}>정밀 추천 새로고침</button>
      </header>

      <div className="precision-filter-note" role="note">
        <strong>엄격 필터 적용</strong>
        <span>말소기준권리, 임차인, 점유 가능성, 보수적 가치와 안전 마진을 함께 확인합니다.</span>
      </div>

      {loading && <p className="precision-loading" role="status">정밀 추천을 불러오는 중…</p>}
      {error && (
        <div className="precision-error" role="alert">
          <p>정밀 추천을 불러오지 못했습니다</p>
          <button type="button" className="precision-legacy-link" onClick={onLegacy}>전체 사건 목록 보기</button>
        </div>
      )}
      {!loading && !error && recommended.length === 0 && (
        <div className="precision-empty">
          <strong>오늘 신규 정밀 추천 없음</strong>
          <p>조건을 통과한 사건이 없습니다. 일반 목록의 사건은 정밀 추천이 아닙니다.</p>
          <button type="button" className="precision-legacy-link" onClick={onLegacy}>전체 사건 목록 보기</button>
        </div>
      )}
      {!error && recommended.length > 0 && (
        <>
          <p className="precision-count">추천 {recommended.length}건 · 최대 7건까지만 표시</p>
          <div className="precision-list" aria-label="정밀 추천 사건 목록">
            {recommended.map((item) => {
              const precision = item.precision!;
              const view = precisionView(precision);
              return (
                <button type="button" key={item.id} className="precision-card" onClick={() => onOpen(item)}>
                  <span className="precision-card-top">
                    <span className={`precision-status precision-status-${view.tone}`}>{view.label}</span>
                    <span className="precision-confidence">신뢰도 {confidenceLabel(precision.confidence)}</span>
                  </span>
                  <strong>{item.address}</strong>
                  <span className="precision-case">{item.case_no}{item.item_no && item.item_no !== '1' ? ` · 물건 ${item.item_no}` : ''}</span>
                  <span className="precision-card-summary">{precision.strengths[0] ?? view.summary}</span>
                  <span className="precision-card-foot">
                    {canShowBid(precision) && <span>절대 상한 {won(precision.hard_cap_bid)}</span>}
                    {item.current_decision && <span>현재: {decisionLabel(item.current_decision.decision)}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
