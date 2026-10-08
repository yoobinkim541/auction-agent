import { useCallback, useEffect, useState } from 'react';
import { fetchBackendHealth, type BackendHealth } from './api.ts';

export type BackendTone = 'checking' | 'ok' | 'error';

export interface BackendStatusState {
  loading: boolean;
  error: string | null;
  ok: boolean | null;
}

export function backendStatusView(state: BackendStatusState): { tone: BackendTone; label: string; detail: string } {
  if (state.loading) return { tone: 'checking', label: 'API 확인 중', detail: '백엔드 health 체크 중' };
  if (state.ok) return { tone: 'ok', label: 'API 연결됨', detail: '실시간 백엔드 데이터 사용 중' };
  return { tone: 'error', label: 'API 연결 오류', detail: state.error ?? '백엔드 응답 없음' };
}

export function useBackendStatus() {
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchBackendHealth()
      .then((res) => { setHealth(res); setError(null); })
      .catch((e: unknown) => { setHealth(null); setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const view = backendStatusView({ loading, error, ok: health?.ok ?? null });
  return { health, loading, error, view, reload };
}
