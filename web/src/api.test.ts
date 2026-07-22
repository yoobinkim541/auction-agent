import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBackendHealth, fetchListings } from './api.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe('api client', () => {
  it('fetchBackendHealth reads /api/health and returns status payload', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, service: 'gyeongmae-api' }), { status: 200 })) as typeof fetch;

    await expect(fetchBackendHealth()).resolves.toEqual({ ok: true, service: 'gyeongmae-api' });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/health', expect.objectContaining({ headers: expect.any(Object), signal: expect.any(AbortSignal) }));
  });

  it('fetchListings includes backend error body in thrown message', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'database unavailable' }), { status: 503 })) as typeof fetch;

    await expect(fetchListings()).rejects.toThrow('API 503: database unavailable');
  });
});
