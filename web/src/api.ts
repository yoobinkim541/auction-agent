/** Spring 백엔드(REST API) 클라이언트. Supabase 제거. */

// VITE_API_BASE 미설정 시 상대경로('') → Vercel은 vercel.json의 /api 프록시 사용.
// 로컬 개발/프리뷰는 web/.env 의 VITE_API_BASE 로 지정.
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '';
export const apiBase = BASE || '(상대경로 /api → Vercel 프록시)';

// Spring /api/listings 가 반환하는 행 형태 (Postgres가 조립한 중첩 JSON)
export interface RightsObj {
  malso_basis?: { note?: string; date?: string | null } | null;
  classified?: { entry: { kind: string; receiptDate: string; amount?: number }; disposition: string; reason: string }[];
  tenants?: { tenant: { name?: string; deposit: number }; hasOpposition: boolean; isSmallTenant: boolean }[];
  assumed_amount?: number;
  assumed_breakdown?: { label: string; amount: number; reason: string }[];
  max_safe_bid?: number | null;
  red_flags?: { kind: string; severity: string; message: string }[];
  risk_grade?: 'clean' | 'caution' | 'risky' | 'review_required';
  is_clean?: boolean;
  warnings?: string[];
}
export interface LocationObj {
  market_price?: number | null;
  market_confidence?: 'high' | 'medium' | 'low' | null;
  comp_basis?: string | null;
  safety_margin?: number | null;
  transit?: { nearestStation?: string; walkMinutes?: number; lines?: number; stations?: { line: string; station: string; distanceM: number }[] } | null;
  schools?: { academyCount?: number; schoolCount?: number } | null;
  amenities?: Record<string, number> | null;
  dev_signals?: string[] | null;
  expected_bid_price?: number | null;
  expected_bid_basis?: string | null;
  acquisition_cost?: AcquisitionCostObj | null;
  site_comps?: SiteCompObj[] | null;
  sale_rounds?: SaleRoundObj[] | null;
  building?: BuildingObj | null;
  land_use_flags?: LandUseFlagObj[] | null;
  admin_offices?: Record<string, string> | null;
  photos?: string[] | null;
  income?: IncomeObj | null;
  eviction?: EvictionObj | null;
  report?: ReportObj | null;
}
export interface AcquisitionCostObj {
  bidPrice: number; bidBasis: string;
  acqTax: number; acqTaxRatePct: number;
  moveOutCost: number; bondCost: number; assumedAmount: number; etcCost: number;
  totalCost: number; trueSafetyMargin: number | null; notes: string[];
}
export interface LandUseFlagObj {
  keyword: string; label: string;
  kind: 'risk' | 'opportunity' | 'info'; severity: 'high' | 'medium' | 'low'; impact?: string;
}
export interface SiteCompObj { name: string; areaM2: number; pyeong?: number; dealYm: string; dealManwon: number; floor?: number }
export interface SaleRoundObj { round: number; date: string; minPrice: number; ratioPct?: number }
export interface BuildingObj { mainUse?: string; households?: number; approvalDate?: string; floorsAbove?: number; floorsBelow?: number; far?: number; bcr?: number }
export interface PreBidItemObj {
  id: string; label: string;
  category: '등기인수' | '임차인배당' | '물건하자' | '공법규제' | '절차비용';
  severity: 'danger' | 'warn' | 'info';
  detail: string; source: string; verify?: string;
}
export interface GlossaryObj { term: string; easy: string; why: string; category: string }
export interface LegalRiskFactorObj { label: string; itemRisk: 'manageable' | 'caution' | 'severe'; laws: { name: string; article?: string; gist: string }[]; action?: string }
export interface LegalRiskObj {
  grade: 'manageable' | 'caution' | 'severe' | 'avoid';
  manageable: boolean; headline: string; reasoning: string;
  factors: LegalRiskFactorObj[];
}
export interface SaleScenarioObj { holdYears: number; yangdoTax: number; ltdRate: number; netCashProfit: number; effRatePct: number }
export interface IncomeObj {
  rentBasis: string;
  jeonseDeposit: number | null; monthlyDeposit: number | null; monthlyRent: number | null;
  jeonseRatioPct: number | null; gapInvestment: number | null; grossYieldPct: number | null;
  monthlyCashflow: number | null; cashflowNote: string;
  hiddenTenantDeposit: number | null;
  saleScenarios: SaleScenarioObj[];
  notes: string[];
  estimated?: boolean;
  zeroPiCandidate?: boolean;
}
export interface EvictionObj {
  occupantLabel: string; remedy: string; remedyLabel: string; writEligible: boolean;
  difficulty: 'easy' | 'medium' | 'hard';
  costLow: number; costBase: number; costHigh: number; monthsLow: number; monthsHigh: number;
  reason: string; negotiationBrief: string; laws: { name: string; article?: string }[]; notes: string[];
}
export interface FieldworkObj {
  remoteDone: { label: string; ok: boolean }[];
  fieldChecklist: { label: string; why: string }[];
  legworkSavedPct: number;
}
export interface ReportObj {
  headline: string;
  recommendation: 'consider' | 'caution' | 'avoid';
  summary: string[];
  rightsSummary: string; locationSummary: string; costSummary: string;
  checklist: PreBidItemObj[];
  dangerCount: number; warnCount: number;
  sourceUrl?: string;
  glossary?: GlossaryObj[];
  legalRisk?: LegalRiskObj;
  fieldwork?: FieldworkObj;
  memo?: string; // LLM 투자 의견서(통과 상위 후보)
  memoModel?: string;
}
export interface ListingItem {
  id: number;
  case_no: string;
  item_no?: string | null;
  court: string;
  address: string;
  property_type: string;
  appraisal_value: number | null;
  min_bid_price: number | null;
  fail_count: number | null;
  sale_date: string | null;
  area_m2: number | null;
  source: string;
  source_url: string | null;
  court_check_url?: string | null;
  deonakchal_check_url?: string | null;
  is_favorite: boolean | null;
  crawled_at: string | null;
  lat: number | null;
  lng: number | null;
  field_done: number | null;   // 현장 체크리스트 확인 완료 개수
  field_total: number | null;  // 현장 체크리스트 전체 개수
  field_notes: number | null;  // 현장 메모 작성 개수
  inq_cnt: number | null;      // 조회수(경쟁 신호 — 낮을수록 저경쟁)
  interest_cnt: number | null; // 관심물건 등록수(경쟁 신호)
  rights: RightsObj | null;
  location: LocationObj | null;
  total_score: number | null;
  passed_filter: boolean | null;
  safety_margin_score: number | null;
  clean_rights_score: number | null;
  reason: string | null;
}

export async function fetchListings(params: { passedOnly?: boolean; type?: string; q?: string } = {}): Promise<ListingItem[]> {
  const qs = new URLSearchParams();
  if (params.passedOnly) qs.set('passedOnly', 'true');
  if (params.type && params.type !== 'all') qs.set('type', params.type);
  if (params.q) qs.set('q', params.q);
  const res = await fetch(`${BASE}/api/listings?${qs.toString()}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as ListingItem[];
}

export async function fetchDetail(caseNo: string): Promise<ListingItem> {
  const res = await fetch(`${BASE}/api/listings/${encodeURIComponent(caseNo)}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as ListingItem;
}

export async function triggerJob(job: 'crawl' | 'analyze' | 'eval' | 'ingest-legal'): Promise<void> {
  const initialToken = adminToken() || promptAdminToken();
  let res = await postJob(job, initialToken);
  if (res.status === 401 && typeof window !== 'undefined') {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    const token = window.prompt('관리자 토큰이 틀렸습니다. 다시 입력하세요');
    if (token?.trim()) {
      localStorage.setItem(ADMIN_TOKEN_KEY, token.trim());
      res = await postJob(job, token.trim());
    }
  }
  if (res.status === 409) return; // 이미 실행 중이면 실패로 보지 않고 상태 polling에 맡긴다.
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ? `: ${body.error}` : '';
    } catch { /* ignore */ }
    throw new Error(`잡 실행 실패 (${res.status})${detail}`);
  }
}

const ADMIN_TOKEN_KEY = 'gyeongmae.adminToken';
function adminToken(): string {
  const envToken = import.meta.env.VITE_ADMIN_TOKEN as string | undefined;
  if (envToken?.trim()) return envToken.trim();
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(ADMIN_TOKEN_KEY)?.trim() ?? '';
}

function promptAdminToken(): string {
  if (typeof window === 'undefined') return '';
  const token = window.prompt('관리자 토큰을 입력하세요');
  const trimmed = token?.trim() ?? '';
  if (trimmed) localStorage.setItem(ADMIN_TOKEN_KEY, trimmed);
  return trimmed;
}

function postJob(job: 'crawl' | 'analyze' | 'eval' | 'ingest-legal', token: string): Promise<Response> {
  const headers = token ? { 'X-Admin-Token': token } : undefined;
  return fetch(`${BASE}/api/jobs/${job}`, { method: 'POST', headers });
}

export interface JobStatus { state: 'idle' | 'running' | 'ok' | 'error'; startedAt?: string; finishedAt?: string; exitCode?: number; error?: string; }
export async function fetchJobStatus(): Promise<Record<string, JobStatus>> {
  const res = await fetch(`${BASE}/api/jobs/status`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as Record<string, JobStatus>;
}

export async function setFavorite(id: number, value: boolean): Promise<void> {
  const res = await fetch(`${BASE}/api/listings/${id}/favorite?value=${value}`, { method: 'POST' });
  if (!res.ok) throw new Error(`즐겨찾기 저장 실패 (${res.status})`);
}

// 현장 임장 체크리스트 메모 (매물별, 재분석에도 보존되는 사용자 입력)
export interface FieldworkNote { item_key: string; checked: boolean; note: string; updated_at?: string }

export async function fetchFieldworkNotes(id: number): Promise<FieldworkNote[]> {
  const res = await fetch(`${BASE}/api/listings/${id}/fieldwork`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as FieldworkNote[];
}

export async function saveFieldworkNote(id: number, itemKey: string, checked: boolean, note: string): Promise<void> {
  const res = await fetch(`${BASE}/api/listings/${id}/fieldwork`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemKey, checked, note }),
  });
  if (!res.ok) throw new Error(`저장 실패 (${res.status})`);
}

export interface CrawlStatus {
  date: string;        // YYYY-MM-DD
  daysAgo: number;     // 오늘 기준 경과일
  stale: boolean;      // 3일 초과 = 오래됨
  source: string;      // 'deonakchal' | 'courtauction'
  blocked: boolean;    // 최근 실행이 차단으로 끝났는지
}
export async function fetchLastCrawl(): Promise<CrawlStatus | null> {
  try {
    const res = await fetch(`${BASE}/api/crawl-runs`);
    if (!res.ok) return null;
    const runs = (await res.json()) as { started_at: string; status: string; source: string; n_found?: number; error?: string | null }[];
    // 법원경매(courtauction)가 현재 메인 소스 → 신선도·차단은 이 소스 기준으로 판단한다.
    // (더낙찰옥션은 계정 단위 차단으로 사실상 중단된 보조 소스라, 그 실패로 배너를 띄우면 오탐이 된다.)
    const court = runs.filter((r) => r.source === 'courtauction');
    const lastOk = court.find((r) => r.status === 'ok' && (r.n_found ?? 0) > 0) ?? court.find((r) => r.status === 'ok');
    if (!lastOk) {
      // 메인 소스가 최근 기록에서 한 번도 정상 수집한 적이 없음 → 차단/장애로 표시
      return { date: '없음', daysAgo: 999, stale: true, source: 'courtauction', blocked: true };
    }
    const date = lastOk.started_at.slice(0, 10);
    const daysAgo = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000));
    // 차단 = 가장 최근에 "종료된" 실행이 실패(error/blocked)거나, status는 ok지만 0건.
    // 실행 중(running)은 시작 직후 n_found=0으로 기록되므로 차단으로 보면 오탐이다.
    const latestFinished = court.find((r) => r.status !== 'running');
    const blocked = latestFinished != null && (latestFinished.status !== 'ok' || (latestFinished.n_found ?? 0) === 0);
    return { date, daysAgo, stale: daysAgo > 3, source: 'courtauction', blocked };
  } catch { return null; }
}

export const won = (n: number | null | undefined): string =>
  n == null ? '-' : n.toLocaleString('ko-KR') + '원';
export const eok = (n: number | null | undefined): string =>
  n == null ? '-' : (n / 1e8).toFixed(2) + '억';
export const pct = (n: number | null | undefined): string =>
  n == null ? '-' : (n * 100).toFixed(1) + '%';
