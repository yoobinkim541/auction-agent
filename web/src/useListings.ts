import { useCallback, useEffect, useState } from 'react';
import { fetchListings, fetchLastCrawl, type ListingItem, type CrawlStatus } from './api.ts';

/**
 * 매물 목록 + 마지막 크롤 상태 로드 — App.tsx에서 추출(데이터 패칭 state/effect 캡슐화).
 * load()는 마운트 시 1회 + 즐겨찾기 실패/잡 완료 후 재호출. 동작은 App 원본과 동일(verbatim).
 */
export function useListings() {
  const [rows, setRows] = useState<ListingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lastCrawl, setLastCrawl] = useState<CrawlStatus | null>(null);
  // useCallback로 안정화 — toggleFav 등이 의존하는 콜백이 매 렌더 새로 만들어져 React.memo 행을 깨지 않도록.
  const load = useCallback(() => {
    setLoading(true); setErr(null);
    fetchListings().then(setRows).catch((e) => setErr(String(e))).finally(() => setLoading(false));
    fetchLastCrawl().then((r) => { if (r) setLastCrawl(r); });
  }, []);
  useEffect(() => { load(); }, [load]);
  return { rows, setRows, loading, err, lastCrawl, load };
}
