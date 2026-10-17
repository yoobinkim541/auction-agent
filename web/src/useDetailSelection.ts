import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDetail,
  detailIdentityKey,
  detailResponseMatches,
  listingDetailTarget,
  mergeDetailSelection,
  parseDetailHash,
  type ListingDetailTarget,
  type ListingItem,
  type DecisionEvent,
} from './api.ts';
import { applyIfCurrent, createRequestGate } from './precision.ts';

export function syncFavoriteToDetail(
  current: ListingItem | null,
  id: number,
  isFavorite: boolean,
): ListingItem | null {
  if (!current || current.id !== id) return current;
  return { ...current, is_favorite: isFavorite };
}

export function syncDecisionToDetail(
  current: ListingItem | null,
  event: DecisionEvent,
): ListingItem | null {
  if (!current || current.id !== event.listing_id) return current;
  return { ...current, current_decision: event };
}

export function useDetailSelection() {
  const [selected, setSelected] = useState<ListingItem | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const detailCacheRef = useRef(new Map<string, ListingItem>());
  const detailRequestGateRef = useRef(createRequestGate());

  // 딥링크: listing id 또는 사건/물건번호로 정확한 매물 상세를 연다.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const target = parseDetailHash(window.location.hash);
    if (!target) return;
    const requestGate = detailRequestGateRef.current;
    const requestGeneration = requestGate.begin();
    fetchDetail(target)
      .then((full) => {
        if (!detailResponseMatches(target, full)) return;
        detailCacheRef.current.set(detailIdentityKey(listingDetailTarget(full)), full);
        applyIfCurrent(requestGate, requestGeneration, () => setSelected(full));
      })
      .catch(() => {});
  }, []);

  const handleSelect = useCallback((item: ListingItem) => {
    const target = listingDetailTarget(item);
    const cacheKey = detailIdentityKey(target);
    const requestGate = detailRequestGateRef.current;
    const requestGeneration = requestGate.begin();
    const cached = detailCacheRef.current.get(cacheKey);
    if (cached) {
      setSelected(mergeDetailSelection(cached, item));
      return;
    }
    setSelected(item);
    setDetailLoading(cacheKey);
    fetchDetail(target)
      .then((full) => {
        if (!detailResponseMatches(target, full)) return;
        const merged = mergeDetailSelection(full, item);
        detailCacheRef.current.set(cacheKey, merged);
        applyIfCurrent(requestGate, requestGeneration, () => {
          setSelected((cur) => (cur?.id === item.id ? merged : cur));
        });
      })
      .catch(() => {})
      .finally(() => setDetailLoading((cur) => (cur === cacheKey ? null : cur)));
  }, []);

  const openCaseFromReview = useCallback((target: ListingDetailTarget) => {
    const cacheKey = detailIdentityKey(target);
    const requestGate = detailRequestGateRef.current;
    const requestGeneration = requestGate.begin();
    const cached = detailCacheRef.current.get(cacheKey);
    if (cached) {
      setSelected(cached);
      return;
    }
    setDetailLoading(cacheKey);
    fetchDetail(target)
      .then((full) => {
        if (!detailResponseMatches(target, full)) return;
        detailCacheRef.current.set(cacheKey, full);
        detailCacheRef.current.set(detailIdentityKey(listingDetailTarget(full)), full);
        applyIfCurrent(requestGate, requestGeneration, () => setSelected(full));
      })
      .catch(() => {})
      .finally(() => setDetailLoading((cur) => (cur === cacheKey ? null : cur)));
  }, []);

  const closeDetail = useCallback(() => {
    setSelected(null);
  }, []);

  const syncFavorite = useCallback((item: ListingItem, isFavorite: boolean) => {
    setSelected((cur) => syncFavoriteToDetail(cur, item.id, isFavorite));
    const cacheKey = detailIdentityKey(listingDetailTarget(item));
    const cached = detailCacheRef.current.get(cacheKey);
    if (cached) {
      detailCacheRef.current.set(cacheKey, { ...cached, is_favorite: isFavorite });
    }
  }, []);

  const syncDecision = useCallback((event: DecisionEvent) => {
    setSelected((cur) => syncDecisionToDetail(cur, event));
  }, []);
  const isDetailLoading = useCallback(
    (item: ListingItem | null) => {
      if (!item || !detailLoading) return false;
      return detailLoading === detailIdentityKey(listingDetailTarget(item));
    },
    [detailLoading],
  );

  return {
    selected,
    setSelected,
    detailLoading,
    isDetailLoading,
    handleSelect,
    openCaseFromReview,
    closeDetail,
    syncFavorite,
    syncDecision,
  };
}
