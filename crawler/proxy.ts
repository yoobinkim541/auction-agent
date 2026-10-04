/**
 * 크롤러 egress 프록시 — CRAWL_PROXY/소스별 프록시가 설정되면 해당 프록시로 나가는 fetch를 제공한다.
 *
 * 용도: 이 Oracle VM의 데이터센터 IP는 법원경매(courtauction.go.kr)에 차단되고, 더낙찰옥션은
 *   클라우드 IP 로그인이 계정 플래그 트리거다. SSH SOCKS 터널을 띄우고 CRAWL_PROXY=socks5://127.0.0.1:1080
 *   으로 두면, 크롤 트래픽이 주거용(집) IP로 나간다. 설정 가이드: docs/crawl-proxy.md
 *
 * 지원: socks5://host:port (또는 socks4://), http(s)://host:port. 미설정이면 전역 fetch 그대로(동작 불변).
 * 주의 1: Node 내장 global fetch 에 외부 undici dispatcher 를 물리면 버전 불일치가 날 수 있어,
 *   프록시가 켜진 경우엔 같은 undici 패키지의 fetch 를 쓴다(undiciFetch).
 * 주의 2: index.ts 가 멀티프록시 로테이션 중 process.env.CRAWL_PROXY 를 바꾸므로,
 *   import 시점에 고정하지 않고 매 호출 시 현재 값을 보고 dispatcher 를 (값이 바뀔 때만) 재생성한다.
 */
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { socksDispatcher } from 'fetch-socks';

function buildDispatcher(p: string, label = 'CRAWL_PROXY'): Dispatcher | undefined {
  if (!p) return undefined;
  let u: URL;
  try { u = new URL(p); } catch { console.warn(`[proxy] ${label} 형식 오류 — 무시: ${p}`); return undefined; }
  const proto = u.protocol.replace(/:$/, '').toLowerCase();
  if (proto.startsWith('socks')) {
    return socksDispatcher({ type: proto.startsWith('socks4') ? 4 : 5, host: u.hostname, port: Number(u.port) || 1080 });
  }
  if (proto === 'http' || proto === 'https') return new ProxyAgent(p);
  console.warn(`[proxy] 지원하지 않는 ${label} 프로토콜 — 무시: ${proto}`);
  return undefined;
}

// 프록시 값이 바뀔 때만 dispatcher 재생성(매 호출 new SocksDispatcher 방지).
const _dispatchers = new Map<string, { proxy: string; dispatcher: Dispatcher | undefined }>();
function dispatcherFor(label: string, proxy: string): Dispatcher | undefined {
  const prev = _dispatchers.get(label);
  if (!prev || prev.proxy !== proxy) {
    const dispatcher = buildDispatcher(proxy, label);
    _dispatchers.set(label, { proxy, dispatcher });
    if (dispatcher) console.log(`[proxy] ${label} 활성 — fetch egress: ${proxy}`);
  }
  return _dispatchers.get(label)?.dispatcher;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function fetchWithProxy(url: string, init: RequestInit | undefined, label: string, proxy: string): Promise<Response> {
  const d = dispatcherFor(label, proxy);
  return d
    ? (undiciFetch(url, { ...(init as object), dispatcher: d } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>)
    : fetch(url, init);
}

/** 생 fetch 대체 — CRAWL_PROXY 설정 시 그 프록시로, 아니면 전역 fetch. 현재 CRAWL_PROXY를 매번 반영(로테이션 대응). */
export const crawlFetch: FetchFn = (url, init) => fetchWithProxy(url, init, 'CRAWL_PROXY', process.env.CRAWL_PROXY ?? '');

function courtAuctionProxy(): string {
  const explicit = process.env.COURTAUCTION_PROXY;
  if (explicit != null) return /^(direct|none|off)$/i.test(explicit.trim()) ? '' : explicit.trim();
  return process.env.COURTAUCTION_USE_CRAWL_PROXY === 'true' ? (process.env.CRAWL_PROXY ?? '') : '';
}

/** 법원경매 전용 fetch. 기본은 직접망이며, COURTAUCTION_PROXY가 있을 때만 별도 프록시를 탄다. */
export const courtAuctionFetch: FetchFn = (url, init) => fetchWithProxy(url, init, 'COURTAUCTION_PROXY', courtAuctionProxy());

/** 프록시가 현재 켜져 있는지(로그/진단용). */
export const crawlProxyActive = (): boolean => dispatcherFor('CRAWL_PROXY', process.env.CRAWL_PROXY ?? '') !== undefined;
export const courtAuctionProxyActive = (): boolean => dispatcherFor('COURTAUCTION_PROXY', courtAuctionProxy()) !== undefined;
