import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from './api.ts';
import { fetchBackendHealth, fetchDetail, fetchListings } from './api.ts';

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

  it('fetches a selected multi-item listing by its immutable listing id', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 42, case_no: '2026타경1', item_no: '2' }), { status: 200 })) as typeof fetch;

    await (fetchDetail as unknown as (target: { id: number; caseNo: string; itemNo: string }) => Promise<unknown>)({
      id: 42,
      caseNo: '2026타경1',
      itemNo: '2',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/listings/by-id/42', expect.any(Object));
  });

  it('uses case and item together when no listing id is available', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 42, case_no: '2026타경1', item_no: '2' }), { status: 200 })) as typeof fetch;

    await (fetchDetail as unknown as (target: { caseNo: string; itemNo: string }) => Promise<unknown>)({
      caseNo: '2026타경1',
      itemNo: '2',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/listings/2026%ED%83%80%EA%B2%BD1?itemNo=2', expect.any(Object));
  });

  it('keeps legacy single-item case deep links compatible', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 1, case_no: '2026타경1', item_no: '1' }), { status: 200 })) as typeof fetch;

    await fetchDetail('2026타경1');

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/listings/2026%ED%83%80%EA%B2%BD1', expect.any(Object));
  });

  it('keys cache and stale-response checks by listing id instead of case number', () => {
    const detailIdentityKey = (api as unknown as {
      detailIdentityKey: (target: { id: number; caseNo: string; itemNo: string }) => string;
    }).detailIdentityKey;

    expect(detailIdentityKey({ id: 41, caseNo: '2026타경1', itemNo: '1' })).toBe('listing:41');
    expect(detailIdentityKey({ id: 42, caseNo: '2026타경1', itemNo: '2' })).toBe('listing:42');
  });

  it('parses listing-id and case-item deep links without folding item into case', () => {
    const parseDetailHash = (api as unknown as {
      parseDetailHash: (hash: string) => unknown;
    }).parseDetailHash;

    expect(parseDetailHash('#listing=42&case=2026%ED%83%80%EA%B2%BD1&item=2')).toEqual({
      id: 42,
      caseNo: '2026타경1',
      itemNo: '2',
    });
    expect(parseDetailHash('#case=2026%ED%83%80%EA%B2%BD1')).toEqual({ caseNo: '2026타경1' });
  });

  it('rejects a same-case response for a different listing id', () => {
    expect(api.detailResponseMatches(
      { id: 42, caseNo: '2026타경1', itemNo: '2' },
      { id: 41, case_no: '2026타경1', item_no: '1' } as api.ListingItem,
    )).toBe(false);
  });

  it('preserves detail precision when a general-list summary has no precision field', () => {
    const hold = { status: 'hold', reason_codes: ['STALE_RIGHTS_ANALYSIS'] } as api.PrecisionObj;
    const full = { id: 42, case_no: '2026타경1', item_no: '2', precision: hold } as api.ListingItem;
    const summary = { id: 42, case_no: '2026타경1', item_no: '2' } as api.ListingItem;

    expect(api.mergeDetailSelection(full, summary).precision).toBe(hold);
  });
});
