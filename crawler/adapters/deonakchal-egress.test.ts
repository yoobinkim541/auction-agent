import { afterEach, describe, expect, it, vi } from 'vitest';

const playwright = vi.hoisted(() => ({
  launch: vi.fn(async () => { throw new Error('browser launched'); }),
}));
const proxy = vi.hoisted(() => ({
  crawlFetch: vi.fn(),
}));

vi.mock('playwright', () => ({
  chromium: { launch: playwright.launch },
}));
vi.mock('../proxy.ts', () => ({
  crawlFetch: proxy.crawlFetch,
}));

const originalFetch = globalThis.fetch;

async function crawlWithEgress(
  profile: { ip?: string; org?: string } | Error,
  options: { allowDatacenter?: boolean } = {},
) {
  vi.resetModules();
  playwright.launch.mockClear();
  proxy.crawlFetch.mockReset();
  process.env.CRAWL_HOME_IPS = '1.2.3.4';
  if (options.allowDatacenter) process.env.CRAWL_ALLOW_DATACENTER = 'true';
  else delete process.env.CRAWL_ALLOW_DATACENTER;
  process.env.CRAWL_IGNORE_COOLDOWN = 'true';
  proxy.crawlFetch.mockImplementation(async () => {
    if (profile instanceof Error) throw profile;
    return new Response(JSON.stringify(profile), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  globalThis.fetch = vi.fn(async () => { throw new Error('direct fetch used'); }) as typeof fetch;
  const { DeonakchalAdapter } = await import('./deonakchal.ts');
  return new DeonakchalAdapter().crawl({ regions: [], propertyTypes: [], maxItems: 1 });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CRAWL_HOME_IPS;
  delete process.env.CRAWL_ALLOW_DATACENTER;
  delete process.env.CRAWL_IGNORE_COOLDOWN;
  vi.restoreAllMocks();
});

describe('DeonakchalAdapter login egress gate', () => {
  it('blocks a registered datacenter IP before launching a login browser', async () => {
    await expect(crawlWithEgress({ ip: '1.2.3.4', org: 'Oracle Cloud Infrastructure' }))
      .rejects.toThrow(/집 회선/);
    expect(playwright.launch).not.toHaveBeenCalled();
  });

  it('does not let a legacy datacenter override bypass the login gate', async () => {
    await expect(crawlWithEgress(
      { ip: '1.2.3.4', org: 'Oracle Cloud Infrastructure' },
      { allowDatacenter: true },
    )).rejects.toThrow(/집 회선/);
    expect(playwright.launch).not.toHaveBeenCalled();
  });

  it('fails closed when the egress profile cannot be verified', async () => {
    await expect(crawlWithEgress(new Error('ip service unavailable')))
      .rejects.toThrow(/회선 검증 실패/);
    expect(playwright.launch).not.toHaveBeenCalled();
  });

  it('continues to browser launch only for an allowlisted residential ISP address', async () => {
    await expect(crawlWithEgress({ ip: '1.2.3.4', org: 'Korea Telecom broadband' }))
      .rejects.toThrow('browser launched');
    expect(playwright.launch).toHaveBeenCalledOnce();
  });
});
