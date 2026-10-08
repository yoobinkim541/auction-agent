import { describe, expect, it } from 'vitest';
import { backendStatusView } from './backend-status.ts';

describe('backendStatusView', () => {
  it('loading state uses checking copy', () => {
    expect(backendStatusView({ loading: true, error: null, ok: null })).toMatchObject({ tone: 'checking', label: 'API 확인 중' });
  });

  it('ok health is production-ready connected copy', () => {
    expect(backendStatusView({ loading: false, error: null, ok: true })).toMatchObject({ tone: 'ok', label: 'API 연결됨' });
  });

  it('error state surfaces backend disconnected copy', () => {
    expect(backendStatusView({ loading: false, error: 'API 503', ok: false })).toMatchObject({ tone: 'error', label: 'API 연결 오류', detail: 'API 503' });
  });
});
