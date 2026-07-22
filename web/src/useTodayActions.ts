import { useCallback, useEffect, useState } from 'react';
import { fetchTodayActions, type TodayAction } from './api.ts';

export function useTodayActions(limit = 20) {
  const [actions, setActions] = useState<TodayAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTodayActions(limit)
      .then(setActions)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [limit]);

  useEffect(() => { reload(); }, [reload]);

  return { actions, loading, error, reload };
}
