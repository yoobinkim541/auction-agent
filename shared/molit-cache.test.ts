import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.ts', () => ({ query: vi.fn(async () => []) }));

import { fetchMolitRaw, molitQuotaHit, resetMolitCircuit } from './molit-cache.ts';

const EP = 'RTMSDataSvcAptTrade';
const status = (code: number): Response => new Response('', { status: code });
const deals = (n: number): Response =>
  new Response(JSON.stringify({ response: { body: { items: { item: Array.from({ length: n }, () => ({ dealAmount: '1,000' })) } } } }), { status: 200 });

async function settle<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return pending;
}

describe('fetchMolitRaw — 게이트웨이 호출 제한과 미승인 엔드포인트', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetMolitCircuit();
    fetchMock.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('MOLIT_SERVICE_KEY', 'key');
    vi.stubEnv('KSKILL_MOLIT_FALLBACK', 'off');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('429 뒤 다시 보내 성공하면 쿼터 차단으로 보지 않는다', async () => {
    fetchMock.mockResolvedValueOnce(status(429)).mockResolvedValueOnce(deals(2));

    expect(await settle(fetchMolitRaw(EP, '41192', '202501'))).toHaveLength(2);
    expect(molitQuotaHit()).toBe(false);
  });

  it('다시 보내도 계속 429면 쿼터 차단으로 보고 이후 호출을 멈춘다', async () => {
    fetchMock.mockImplementation(async () => status(429));

    expect(await settle(fetchMolitRaw(EP, '41192', '202502'))).toBeNull();
    expect(molitQuotaHit()).toBe(true);
    const calls = fetchMock.mock.calls.length;
    expect(await settle(fetchMolitRaw(EP, '41192', '202503'))).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('미승인(403) 엔드포인트는 한 번만 부르고, 다른 엔드포인트는 계속 부른다', async () => {
    fetchMock.mockImplementation(async (url: string) => (url.includes('OffiTrade') ? status(403) : deals(1)));

    expect(await settle(fetchMolitRaw('RTMSDataSvcOffiTrade', '41192', '202504'))).toBeNull();
    expect(await settle(fetchMolitRaw('RTMSDataSvcOffiTrade', '41192', '202505'))).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(await settle(fetchMolitRaw(EP, '41192', '202506'))).toHaveLength(1);
    expect(molitQuotaHit()).toBe(false);
  });
});
