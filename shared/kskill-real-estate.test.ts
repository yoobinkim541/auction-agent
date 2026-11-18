import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mapProxyPayload,
  molitFallbackEnabled,
  proxyDealToMolitItem,
  proxyPathForEndpoint,
  requestKskillProxy,
  skipOwnMolit,
} from './kskill-real-estate.ts';

describe('requestKskillProxy', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('429면 retry_after_ms 만큼 쉬었다 다시 보내고, 그동안 다른 요청도 세운다', async () => {
    vi.useFakeTimers();
    const sentAt: number[] = [];
    const replies = [
      new Response(JSON.stringify({ error: 'rate_limited', retry_after_ms: 30_000 }), { status: 429 }),
      new Response('{"items":[]}', { status: 200 }),
      new Response('{"items":[]}', { status: 200 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => {
      sentAt.push(Date.now());
      return replies.shift()!;
    }));
    const started = Date.now();
    const first = requestKskillProxy('https://proxy.test/a', 1_000);
    await vi.advanceTimersByTimeAsync(10);
    const second = requestKskillProxy('https://proxy.test/b', 1_000);
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(sentAt.map((at) => at - started >= 30_000)).toEqual([false, true, true]);
  });
});

describe('proxyDealToMolitItem', () => {
  it('매매는 만원 문자열 dealAmount와 분해된 거래일로 맞춘다', () => {
    const item = proxyDealToMolitItem({
      name: '은마', district: '대치동', area_m2: 76.79, floor: 7,
      price_10k: 185000, deal_date: '2026-03-16', build_year: 1979,
    }, 'trade');
    expect(item).toMatchObject({
      aptNm: '은마', umdNm: '대치동', excluUseAr: 76.79, floor: 7,
      dealAmount: '185000', dealYear: '2026', dealMonth: '3', dealDay: '16', buildYear: 1979,
    });
  });

  it('전월세는 deposit/monthlyRent(만원)로 맞춘다', () => {
    const item = proxyDealToMolitItem({
      name: '은마', district: '대치동', area_m2: 59.99,
      deposit_10k: 130000, monthly_rent_10k: 0, deal_date: '2026-03-21',
    }, 'rent');
    expect(item).toMatchObject({ deposit: '130000', monthlyRent: '0', dealYear: '2026', dealMonth: '3' });
  });

  it('날짜·금액·면적이 없으면 버린다', () => {
    expect(proxyDealToMolitItem({ name: 'x', area_m2: 84, price_10k: 10000 }, 'trade')).toBeNull();
    expect(proxyDealToMolitItem({ area_m2: 84, deal_date: '2026-03-01' }, 'trade')).toBeNull();
    expect(proxyDealToMolitItem({ area_m2: 0, price_10k: 10000, deal_date: '2026-03-01' }, 'trade')).toBeNull();
    expect(proxyDealToMolitItem({ area_m2: 84, deal_date: '2026-03-01', deposit_10k: 0 }, 'rent')).toBeNull();
  });
});

describe('mapProxyPayload', () => {
  it('items가 없으면 실패(null), 있으면 유효 건만 남긴다', () => {
    expect(mapProxyPayload({ total_count: 1 }, 'trade')).toBeNull();
    expect(mapProxyPayload({
      items: [
        { name: 'a', district: '역삼동', area_m2: 59, price_10k: 85000, deal_date: '2026-03-23' },
        { name: 'bad', area_m2: 59, deal_date: '2026-03-23' },
      ],
    }, 'trade')).toHaveLength(1);
  });

  it('빈 items는 거래 없음(빈 배열)', () => {
    expect(mapProxyPayload({ items: [] }, 'trade')).toEqual([]);
  });
});

describe('폴백 정책', () => {
  it('아파트는 키·쿼터가 있을 때만 자체 API', () => {
    expect(skipOwnMolit('RTMSDataSvcAptTrade', true, false)).toBe(false);
    expect(skipOwnMolit('RTMSDataSvcAptTrade', false, false)).toBe(true);
    expect(skipOwnMolit('RTMSDataSvcAptTrade', true, true)).toBe(true);
  });

  it('단독·상업은 자체 키를 치지 않는다', () => {
    expect(skipOwnMolit('RTMSDataSvcNrgTrade', true, false)).toBe(true);
    expect(skipOwnMolit('RTMSDataSvcSHTrade', true, false)).toBe(true);
    expect(proxyPathForEndpoint('RTMSDataSvcSHRent')).toBe('single-house/rent');
    expect(proxyPathForEndpoint('RTMSDataSvcUnknown')).toBeNull();
  });

  it('기본 폴백은 켜져 있다', () => {
    expect(molitFallbackEnabled()).toBe(true);
  });
});
