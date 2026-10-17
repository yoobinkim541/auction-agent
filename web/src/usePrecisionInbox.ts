import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPrecisionRecommendations, type DecisionEvent, type ListingItem } from './api.ts';
import { applyIfCurrent, createRequestGate } from './precision.ts';

export function applyDecisionToItems(items: ListingItem[], event: DecisionEvent): ListingItem[] {
  return items.map((item) => (item.id === event.listing_id ? { ...item, current_decision: event } : item));
}

export interface UsePrecisionInboxOptions {
  limit?: number;
}

export function usePrecisionInbox(options: UsePrecisionInboxOptions = {}) {
  const { limit = 5 } = options;
  const [items, setItems] = useState<ListingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGateRef = useRef(createRequestGate());

  const reload = useCallback(() => {
    const gate = requestGateRef.current;
    const gen = gate.begin();
    setLoading(true);
    setError(null);
    return fetchPrecisionRecommendations(limit)
      .then((data) => {
        applyIfCurrent(gate, gen, () => setItems(data));
      })
      .catch(() => {
        applyIfCurrent(gate, gen, () => setError('정밀 추천 API 오류'));
      })
      .finally(() => {
        applyIfCurrent(gate, gen, () => setLoading(false));
      });
  }, [limit]);

  useEffect(() => {
    void reload();
    return () => {
      requestGateRef.current.invalidate();
    };
  }, [reload]);

  const updateDecision = useCallback((event: DecisionEvent) => {
    setItems((cur) => applyDecisionToItems(cur, event));
  }, []);

  return {
    items,
    loading,
    error,
    reload,
    updateDecision,
  };
}
