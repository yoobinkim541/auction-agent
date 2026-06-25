/**
 * 크롤러 egress 프록시 — CRAWL_PROXY 가 설정되면 그 프록시로 나가는 fetch(crawlFetch)를 제공한다.
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

function buildDispatcher(p: string): Dispatcher | undefined {
  if (!p) return undefined;
  let u: URL;
  try { u = new URL(p); } catch { console.warn(`[proxy] CRAWL_PROXY 형식 오류 — 무시: ${p}`); return undefined; }
  const proto = u.protocol.replace(/:$/, '').toLowerCase();
  if (proto.startsWith('socks')) {
    return socksDispatcher({ type: proto.startsWith('socks4') ? 4 : 5, host: u.hostname, port: Number(u.port) || 1080 });
  }
  if (proto === 'http' || proto === 'https') return new ProxyAgent(p);
  console.warn(`[proxy] 지원하지 않는 CRAWL_PROXY 프로토콜 — 무시: ${proto}`);
  return undefined;
}

// CRAWL_PROXY 값이 바뀔 때만 dispatcher 재생성(매 호출 new SocksDispatcher 방지).
let _cachedKey: string | null = null;
let _dispatcher: Dispatcher | undefined;
function currentDispatcher(): Dispatcher | undefined {
  const p = process.env.CRAWL_PROXY ?? '';
  if (p !== _cachedKey) {
    _cachedKey = p;
    _dispatcher = buildDispatcher(p);
    if (_dispatcher) console.log(`[proxy] CRAWL_PROXY 활성 — 크롤 fetch egress: ${p}`);
  }
  return _dispatcher;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** 생 fetch 대체 — CRAWL_PROXY 설정 시 그 프록시로, 아니면 전역 fetch. 현재 CRAWL_PROXY를 매번 반영(로테이션 대응). */
export const crawlFetch: FetchFn = (url, init) => {
  const d = currentDispatcher();
  return d
    ? (undiciFetch(url, { ...(init as object), dispatcher: d } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>)
    : fetch(url, init);
};

/** 프록시가 현재 켜져 있는지(로그/진단용). */
export const crawlProxyActive = (): boolean => currentDispatcher() !== undefined;
