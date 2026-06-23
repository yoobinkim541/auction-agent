/**
 * 대법원 법원경매정보(courtauction.go.kr) 어댑터.
 *
 * ─ API 구조 (역공학으로 확인) ──────────────────────────────────────────────
 *  메인: GET  /pgj/index.on                          → 세션 쿠키 취득
 *  목록: POST /pgj/pgjsearch/searchControllerMain.on → [{pageInfo},{srchInfo}]
 *  상세: POST /pgj/pgj15B/selectAuctnCsSrchRslt.on  → {csNo,cortOfcCd,...}
 *
 * ─ IP 차단 탐지 ──────────────────────────────────────────────────────────
 *  응답 JSON.data.ipcheck === false  →  CourtAuctionBlockedError
 *
 * ─ 폴라이트 정책 ──────────────────────────────────────────────────────────
 *  최소 2500ms 전역 간격 (rateGate) · 매물마다 4-10s 읽기 지연 · 중간 휴식.
 *  Playwright 없이 node fetch로 동작(세션 쿠키 수동 관리).
 *
 * ⚠️  Oracle VM IP는 차단됨 → 로컬 PC / Raspberry Pi / SSH 프록시에서 실행 필요.
 *     npm run crawl 실행 전 `ssh -D 1080 pi@home` 등으로 SOCKS5 터널 세팅 권장.
 *
 * ─ 제공 데이터 ────────────────────────────────────────────────────────────
 *  사건번호, 법원, 소재지, 용도, 감정가, 최저가, 유찰횟수, 매각기일 (기본 메타)
 *  면적, 건물 표제부 (상세 호출 시)
 *  등기·임차인·매각효력·실거래 없음 (deonakchal만 제공)
 */
import type { Adapter, CrawlFilter, ScrapedListing } from './types.ts';
import type { Listing } from '../../shared/types.ts';
import { parseKoreanDate } from '../normalize.ts';

const BASE = 'https://www.courtauction.go.kr';
const UA = 'gyeongmae-agent/0.1 (personal research; contact: owner)';

// ── 수도권 법원 코드 (selectCortOfcLst.on 응답 확인 완료) ──────────────
const METRO_COURTS: { code: string; name: string }[] = [
  { code: 'B000210', name: '서울중앙지방법원' },
  { code: 'B000211', name: '서울동부지방법원' },
  { code: 'B000212', name: '서울남부지방법원' },
  { code: 'B000213', name: '서울북부지방법원' },
  { code: 'B000215', name: '서울서부지방법원' },
  { code: 'B000214', name: '의정부지방법원' }, // 경기북부
  { code: 'B000240', name: '인천지방법원' },
  { code: 'B000250', name: '수원지방법원' },   // 경기남부
  { code: 'B000251', name: '성남지원' },
];

/** 필터 regions 키워드로 대상 법원 추린다 ('서울' → 서울 5개 법원 포함) */
function filterCourts(regions: string[]): { code: string; name: string }[] {
  if (!regions.length) return [...METRO_COURTS];
  return METRO_COURTS.filter((c) => regions.some((r) => c.name.includes(r) || c.code === r));
}

// ── 휴먼 페이싱 ─────────────────────────────────────────────────────────
const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.round(ms)));
const humanDwellMs = () => (Math.random() < 0.12 ? rnd(15_000, 28_000) : rnd(4_000, 10_000));

const MIN_REQ_INTERVAL_MS = 2_500;
let _nextReqAt = 0;
async function rateGate(): Promise<void> {
  const now = Date.now();
  const w = Math.max(0, _nextReqAt - now);
  _nextReqAt = Math.max(now, _nextReqAt) + MIN_REQ_INTERVAL_MS;
  if (w > 0) await wait(w);
}

// ── 쿠키 관리 ─────────────────────────────────────────────────────────
class CookieJar {
  private store = new Map<string, string>();

  ingest(setCookie: string | null): void {
    if (!setCookie) return;
    for (const part of setCookie.split(/,(?=\s*\w+=)/)) {
      const kv = part.trim().split(';')[0]?.trim();
      if (!kv) continue;
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      this.store.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export class CourtAuctionBlockedError extends Error {
  constructor() {
    super('COURT_BLOCKED: 법원경매 IP 차단 — 다른 IP(로컬 PC/RPi)에서 실행 필요');
    this.name = 'CourtAuctionBlockedError';
  }
}

// ── HTTP 헬퍼 ─────────────────────────────────────────────────────────
interface FetchOpts {
  body?: unknown;
  cookies: CookieJar;
  referer?: string;
}

async function post(path: string, { body, cookies, referer }: FetchOpts): Promise<unknown> {
  await rateGate();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      Referer: referer ?? BASE + '/pgj/index.on',
      Origin: BASE,
      Cookie: cookies.header(),
    },
    body: JSON.stringify(body),
  });
  cookies.ingest(res.headers.get('set-cookie'));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

/** 세션 초기화 (JSESSIONID + WMONID 취득) */
async function initSession(cookies: CookieJar): Promise<void> {
  await rateGate();
  const res = await fetch(BASE + '/pgj/index.on', {
    headers: {
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'User-Agent': UA,
    },
  });
  cookies.ingest(res.headers.get('set-cookie'));
  await wait(rnd(2_000, 4_000)); // 사람처럼 페이지를 잠시 봄
}

// ── 데이터 정규화 ─────────────────────────────────────────────────────
/** 용도코드 → PropertyType (법원경매 고유 코드 체계) */
function mapUsgCd(cd: string | undefined, bigo: string | undefined): Listing['propertyType'] {
  const s = `${cd ?? ''} ${bigo ?? ''}`;
  if (/아파트|APT/.test(s)) return 'apartment';
  if (/오피스텔/.test(s)) return 'officetel';
  if (/다세대|연립|다가구|빌라/.test(s)) return 'villa';
  if (/단독/.test(s)) return 'house';
  if (/상가|근린|점포|오피스|업무|공장|창고/.test(s)) return 'commercial';
  if (/토지|임야|농지|전|답/.test(s)) return 'land';
  return 'other';
}

/** 법원경매 날짜 문자열 (YYYYMMDD or YYYY.MM.DD) → ISO YYYY-MM-DD */
function parseCourtDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const clean = s.replace(/\./g, '');
  if (/^\d{8}$/.test(clean)) return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
  return parseKoreanDate(s);
}

/** 금액 문자열("1,234,567,000") → 숫자 */
function parseMoney(s: string | undefined): number {
  if (!s) return 0;
  const n = parseInt(s.replace(/,/g, '').trim(), 10);
  return isNaN(n) ? 0 : n;
}

/** 법원코드 → 법원명 */
function courtName(code: string): string {
  return METRO_COURTS.find((c) => c.code === code)?.name ?? code;
}

// ── 검색 결과 행 → ScrapedListing ───────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToScraped(row: any, courtCode: string): ScrapedListing | null {
  // saNo = "2025타경1001" 형식 (법원경매 내부 포맷)
  const rawCsNo: string = row.saNo ?? row.srnSaNo ?? '';
  if (!rawCsNo) return null;

  // 진행 중인 물건만 (mulJinYn="Y", 종결/취하 제외)
  if (row.mulJinYn === 'N') return null;

  const appraisal = parseMoney(row.gamevalAmt);
  const minBid = parseMoney(row.minmaePrice || row.notifyMinmaePrice1);
  if (!appraisal && !minBid) return null;

  const address = (row.realSt ?? row.printSt ?? '').replace(/\s+/g, ' ').trim();
  if (!address) return null;

  const failCount = parseInt(row.yuchalCnt ?? '0', 10) || 0;
  const saleDate = parseCourtDate(row.maeGiil ?? row.maeHh1);
  const propertyType = mapUsgCd(row.maemulUtilCd, row.mulBigo);
  const itemNo = row.maemulSer ?? row.mokmulSer ?? '1';

  const listing: Listing = {
    caseNo: rawCsNo.trim(),
    itemNo: String(itemNo),
    court: courtName(row.boCd ?? courtCode),
    address,
    propertyType,
    appraisalValue: appraisal,
    minBidPrice: minBid || Math.round(appraisal * 0.8),
    minBidRatio: appraisal ? Math.round((minBid / appraisal) * 100) : undefined,
    failCount,
    saleDate,
    source: 'courtauction',
    sourceUrl: `${BASE}/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ15BM01.xml`,
    rawJson: row,
    crawledAt: new Date().toISOString(),
  };

  return { listing };
}

// ── 상세 API: 면적·기일표 보강 ────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDetail(csNo: string, cortOfcCd: string, dspslGdsSeq: string, cookies: CookieJar): Promise<any | null> {
  const body = {
    csNo,
    cortOfcCd,
    dspslGdsSeq,
    pgmId: 'PGJ15BM01',
    srchInfo: { menuNm: '물건상세검색', sideDvsCd: '2' },
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await post('/pgj/pgj15B/selectAuctnCsSrchRslt.on', { body, cookies })) as any;
    if (res?.data?.ipcheck === false) throw new CourtAuctionBlockedError();
    return res.data?.dma_result ?? null;
  } catch (e) {
    if (e instanceof CourtAuctionBlockedError) throw e;
    return null;
  }
}

/** 상세 결과로 listing 보강 (면적·건물정보 등) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyDetail(scraped: ScrapedListing, detail: any): void {
  if (!detail) return;
  const objct = detail.gdsDspslObjctLst?.[0];
  if (!objct) return;
  // 전용면적 (㎡)
  const areaTxt: string = objct.gdsArDts ?? objct.gdsAr ?? '';
  const areaNum = parseFloat(areaTxt.replace(/[^\d.]/g, ''));
  if (!isNaN(areaNum) && areaNum > 0) scraped.listing.areaM2 = areaNum;
  // 집합건물 여부 (아파트·오피스텔은 일반적으로 집합건물)
  if (/집합/.test(objct.gdsKndNm ?? '')) scraped.listing.isCollectiveBuilding = true;
  // 배당요구 종기일
  const demandDl = detail.dstrtDemnInfo?.dstrtDemnDxdyYmd;
  if (demandDl) scraped.listing.demandDeadline = parseCourtDate(demandDl);
}

// ── 메인 크롤 로직 ────────────────────────────────────────────────────
export class CourtAuctionAdapter implements Adapter {
  name = 'courtauction' as const;

  async crawl(filter: CrawlFilter): Promise<ScrapedListing[]> {
    const maxItems = filter.maxItems ?? 200;
    const fetchDetail_ = process.env.COURT_FETCH_DETAIL === 'true';
    const courts = filterCourts(filter.regions);

    if (!courts.length) {
      console.warn('[courtauction] 해당 지역 법원이 없음 — 수도권 전체로 확대');
      courts.push(...METRO_COURTS);
    }

    const cookies = new CookieJar();
    await initSession(cookies);

    const results: ScrapedListing[] = [];
    const seen = new Set<string>();
    let blocked = false;

    let nextBreakAt = Math.round(rnd(40, 60));

    for (const court of courts) {
      if (blocked || results.length >= maxItems) break;
      console.log(`[courtauction] 검색: ${court.name} (${court.code})`);

      for (let page = 1; ; page++) {
        if (blocked || results.length >= maxItems) break;

        const srchInfo = {
          cortStDvs: '1',        // 법원/담당계 기준 검색
          cortOfcCd: court.code,
          jdbnCd: '',            // 전체 담당계
          lclDspslGdsLstUsgCd: '', // 용도 전체 (클라이언트 필터)
          mclDspslGdsLstUsgCd: '',
          sclDspslGdsLstUsgCd: '',
          aeeEvlAmtMin: '',
          aeeEvlAmtMax: '',
          rletLwsDspslPrcMin: '',
          rletLwsDspslPrcMax: '',
          objctArDtsMin: '',
          objctArDtsMax: '',
          flbdNcntMin: '',
          flbdNcntMax: '',
          lwsDspslPrcRateMin: '',
          lwsDspslPrcRateMax: '',
          bidBgngYmd: '',
          bidEndYmd: '',
          notifyLoc: 'off',
          cortAuctnSrchCondCd: '0004601', // 부동산
          mvprpRletDvsCd: '00031R',
          pgmId: 'PGJ151F01',
          menuNm: '물건상세검색',
          sideDvsCd: '2',
          srchRowIndex: '',
        };
        const pageInfo = { totalYn: page === 1 ? 'Y' : 'N', pageNo: page, pageSize: 20 };

        let resp: unknown;
        try {
          resp = await post('/pgj/pgjsearch/searchControllerMain.on', {
            body: [pageInfo, srchInfo],
            cookies,
          });
        } catch (e) {
          console.error(`[courtauction] 검색 실패 ${court.name} p${page}:`, e);
          break;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (resp as any)?.data;
        if (data?.ipcheck === false) {
          blocked = true;
          console.error('[courtauction] ⛔ IP 차단 — 로컬 PC/RPi에서 재시도 필요');
          break;
        }
        if (!data || !Array.isArray(data.dlt_srchResult)) {
          console.warn(`[courtauction] ${court.name} p${page} 응답 구조 이상 — 다음 법원`);
          break;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows: any[] = data.dlt_srchResult;
        if (!rows.length) {
          console.log(`[courtauction] ${court.name} p${page} 결과 없음 — 다음 법원`);
          break;
        }

        let newOnPage = 0;
        for (const row of rows) {
          const scraped = rowToScraped(row, court.code);
          if (!scraped) continue;
          const key = `${scraped.listing.caseNo}|${scraped.listing.itemNo}`;
          if (seen.has(key)) continue;
          seen.add(key);
          newOnPage++;

          // 물건 종류 필터 (클라이언트 사이드)
          if (filter.propertyTypes.length && !filter.propertyTypes.includes(scraped.listing.propertyType)) continue;
          // 지역 키워드 필터
          if (filter.regions.length && !filter.regions.some((rg) => scraped.listing.address.includes(rg) || court.name.includes(rg))) continue;

          // 상세 보강 (선택적)
          if (fetchDetail_) {
            try {
              const detail = await fetchDetail(scraped.listing.caseNo, court.code, scraped.listing.itemNo ?? '1', cookies);
              applyDetail(scraped, detail);
            } catch (e) {
              if (e instanceof CourtAuctionBlockedError) { blocked = true; break; }
            }
            await wait(humanDwellMs());
          }

          results.push(scraped);
          if (results.length >= maxItems) break;
        }

        if (newOnPage === 0) break; // 중복만 있으면 종료

        // 중간 휴식 (사람처럼)
        if (results.length >= nextBreakAt && results.length < maxItems) {
          const br = rnd(60_000, 150_000);
          console.log(`[courtauction] ☕ 휴식 ${Math.round(br / 1000)}s...`);
          await wait(br);
          nextBreakAt = results.length + Math.round(rnd(40, 60));
        } else {
          await wait(rnd(3_000, 7_000)); // 다음 페이지 전 텀
        }
      }
    }

    if (blocked) {
      console.error('[courtauction] IP 차단 — 수집 중단. 로컬 PC/RPi에서 재시도 필요.');
    }
    console.log(`[courtauction] 완료: ${results.length}건`);
    return results;
  }
}
