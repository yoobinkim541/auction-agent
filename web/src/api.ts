/** Spring 백엔드(REST API) 클라이언트. Supabase 제거. */

// VITE_API_BASE 미설정 시 상대경로('') → Vercel은 vercel.json의 /api 프록시 사용.
// 로컬 개발/프리뷰는 web/.env 의 VITE_API_BASE 로 지정.
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '';
export const apiBase = BASE || '(상대경로 /api → Vercel 프록시)';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);
  const headers = { Accept: 'application/json', ...(init.headers ?? {}) };
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, headers, signal: init.signal ?? controller.signal });
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        detail = body.error || body.message || '';
      } catch {
        detail = await res.text().catch(() => '');
      }
      throw new ApiError(res.status, `API ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('API timeout');
    throw e;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

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
export interface MlCalibrationObj {
  method: 'group_median_v1';
  status: 'reference_only';
  region: string;
  sample_size: number;
  median_sale_ratio: number | null;
  median_realized_margin: number | null;
  reference_bid_price: number | null;
  delta_vs_expected_bid: number | null;
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
  cover_photo_url?: string | null;
  court_check_url?: string | null;
  deonakchal_check_url?: string | null;
  ml_calibration?: MlCalibrationObj | null;
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
  precision?: PrecisionObj | null;
  current_decision?: DecisionEvent | null;
}

export type PrecisionStatus = 'recommended' | 'conditional' | 'hold' | 'rejected';
export type PrecisionConfidence = 'high' | 'medium' | 'low';
export type DecisionKind = 'reviewing' | 'favorite' | 'hold' | 'fieldwork' | 'bid_review' | 'rejected';
export type DecisionReason = 'price' | 'rights' | 'location' | 'field' | 'capital' | 'schedule' | 'preference' | 'data_missing';

export interface PrecisionObj {
  status: PrecisionStatus;
  confidence: PrecisionConfidence;
  conservative_value: number | null;
  recommended_bid: number | null;
  hard_cap_bid: number | null;
  reason_codes: string[];
  strengths: string[];
  risks: string[];
  required_checks: string[];
  evaluator_version: string;
  evaluated_at: string;
}

export interface DecisionEvent {
  id: number;
  listing_id: number;
  decision: DecisionKind;
  reason_code: DecisionReason | null;
  note: string;
  target_bid: number | null;
  precision_snapshot?: PrecisionObj | Record<string, unknown>;
  created_at: string;
}

export interface DecisionInput {
  decision: DecisionKind;
  reasonCode?: DecisionReason;
  note?: string;
  targetBid?: number;
}

export interface ListingDetailTarget {
  id?: number;
  caseNo?: string;
  itemNo?: string | null;
}


export type TodayActionType = 'recrawl_needed' | 'rights_enrichment' | 'bid_soon' | 'fieldwork' | 'review_result';
export type TodayActionSeverity = 'danger' | 'warn' | 'info';

export interface TodayAction {
  listing_id: number;
  case_no: string;
  item_no: string;
  action_type: TodayActionType;
  priority: number;
  severity: TodayActionSeverity;
  title: string;
  reason: string;
  due_date: string | null;
  sort_date: string | null;
  source_url: string | null;
}


export interface MlReviewSummary {
  past_snapshots: number;
  matched: number;
  sold: number;
  unsold: number;
  miss_rate: number | null;
  sale_ratio_labels: number;
  expected_bid_mape: number | null;
  current_expected_mae: number | null;
  positive_margin_rate: number | null;
  safe_bid_rows: number;
  safe_bid_hit_rate: number | null;
}
export interface MlGroupMedianRow {
  property_type: string;
  region: string;
  rows: number;
  median_sale_ratio: number | null;
  median_realized_margin: number | null;
}
export interface MlFeatureCoverageRow {
  feature: string;
  non_null_rows: number;
  coverage: number | null;
}
export interface MlSurpriseRow {
  surprise_kind: 'overpriced' | 'avoid_but_sold' | 'passed_but_unsold';
  surprise_score: number | null;
  case_no: string;
  item_no: string;
  sale_date: string | null;
  property_type: string;
  court: string | null;
  address: string;
  expected_bid: number | null;
  sold_amount: number | null;
  sale_ratio: number | null;
  residual_pct: number | null;
  total_score: number | null;
  passed_filter: boolean | null;
  recommendation: string | null;
  true_margin: number | null;
  inq_cnt: number | null;
  interest_cnt: number | null;
  realized_bid_margin: number | null;
}

export interface MlRetryQueueRow {
  case_no: string; item_no: string; sale_date: string | null; court: string | null; property_type: string; address: string;
  days_overdue: number; retry_priority: number; total_score: number | null; passed_filter: boolean | null; recommendation: string | null;
  expected_bid: number | null; min_bid_price: number | null; inq_cnt: number | null; interest_cnt: number | null;
}
export interface MlCalibrationPerformance {
  rows: number; reference_mae: number | null; current_mae: number | null; reference_win_rate: number | null;
}
export interface MlRightsRiskRow {
  risk_grade: string; rows: number; matched: number; sold: number; sold_rate: number | null; median_proxy_margin: number | null;
  avg_assumed_amount: number | null; opposition_rows: number; safe_bid_hit_rate: number | null;
}
export interface MlReview {
  summary: MlReviewSummary;
  groupMedian: MlGroupMedianRow[];
  featureCoverage: MlFeatureCoverageRow[];
  surprises: MlSurpriseRow[];
  retryQueue: MlRetryQueueRow[];
  calibrationPerformance: MlCalibrationPerformance;
  rightsRisk: MlRightsRiskRow[];
  reportMarkdown: string;
}

export interface BackendHealth {
  ok: boolean;
  service?: string;
  version?: string;
  time?: string;
  [key: string]: unknown;
}

export async function fetchBackendHealth(): Promise<BackendHealth> {
  return apiJson<BackendHealth>('/api/health');
}

export async function fetchTodayActions(limit = 20): Promise<TodayAction[]> {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  return apiJson<TodayAction[]>(`/api/actions/today?${qs.toString()}`);
}

export async function fetchMlReview(): Promise<MlReview> {
  return apiJson<MlReview>('/api/review/ml');
}

export async function fetchListings(params: { passedOnly?: boolean; type?: string; q?: string } = {}): Promise<ListingItem[]> {
  const qs = new URLSearchParams();
  if (params.passedOnly) qs.set('passedOnly', 'true');
  if (params.type && params.type !== 'all') qs.set('type', params.type);
  if (params.q) qs.set('q', params.q);
  return apiJson<ListingItem[]>(`/api/listings?${qs.toString()}`);
}

export async function fetchPrecisionRecommendations(limit = 5): Promise<ListingItem[]> {
  const clampedLimit = Math.max(3, Math.min(7, Math.trunc(limit) || 5));
  return apiJson<ListingItem[]>(`/api/recommendations/precision?limit=${clampedLimit}`);
}

export async function fetchDecisions(id: number): Promise<DecisionEvent[]> {
  return apiJson<DecisionEvent[]>(`/api/listings/${id}/decisions`);
}

export async function saveDecision(id: number, input: DecisionInput): Promise<DecisionEvent> {
  return apiJson<DecisionEvent>(`/api/listings/${id}/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function detailIdentityKey(target: ListingDetailTarget): string {
  if (target.id != null && Number.isInteger(target.id) && target.id > 0) return `listing:${target.id}`;
  const itemNo = target.itemNo?.trim() || '1';
  return `case:${target.caseNo ?? ''}/item:${itemNo}`;
}

export function listingDetailTarget(item: Pick<ListingItem, 'id' | 'case_no' | 'item_no'>): ListingDetailTarget {
  return { id: item.id, caseNo: item.case_no, itemNo: item.item_no };
}

export function parseDetailHash(hash: string): ListingDetailTarget | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const rawId = params.get('listing');
  const id = rawId != null && /^[1-9][0-9]*$/.test(rawId) ? Number(rawId) : undefined;
  const caseNo = params.get('case')?.trim() || undefined;
  const itemNo = params.get('item')?.trim() || undefined;
  if (id !== undefined) return { id, ...(caseNo ? { caseNo } : {}), ...(itemNo ? { itemNo } : {}) };
  if (caseNo) return { caseNo, ...(itemNo ? { itemNo } : {}) };
  return null;
}

export function detailResponseMatches(target: ListingDetailTarget, response: ListingItem): boolean {
  if (target.id != null) return response.id === target.id;
  if (response.case_no !== target.caseNo) return false;
  return !target.itemNo || (response.item_no?.trim() || '1') === (target.itemNo.trim() || '1');
}

export function mergeDetailSelection(full: ListingItem, summary?: ListingItem): ListingItem {
  if (!summary || summary.id !== full.id) return full;
  return {
    ...full,
    ...(summary.precision !== undefined ? { precision: summary.precision } : {}),
    ...(summary.current_decision !== undefined ? { current_decision: summary.current_decision } : {}),
  };
}

export async function fetchDetail(target: string | ListingDetailTarget): Promise<ListingItem> {
  if (typeof target === 'string') {
    return apiJson<ListingItem>(`/api/listings/${encodeURIComponent(target)}`);
  }
  if (target.id != null) return apiJson<ListingItem>(`/api/listings/by-id/${target.id}`);
  if (!target.caseNo) throw new Error('상세 조회 식별자가 없습니다');
  const itemQuery = target.itemNo ? `?itemNo=${encodeURIComponent(target.itemNo)}` : '';
  return apiJson<ListingItem>(`/api/listings/${encodeURIComponent(target.caseNo)}${itemQuery}`);
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
  return apiJson<Record<string, JobStatus>>('/api/jobs/status');
}

export async function setFavorite(id: number, value: boolean): Promise<void> {
  const res = await fetch(`${BASE}/api/listings/${id}/favorite?value=${value}`, { method: 'POST' });
  if (!res.ok) throw new Error(`즐겨찾기 저장 실패 (${res.status})`);
}

// 현장 임장 체크리스트 메모 (매물별, 재분석에도 보존되는 사용자 입력)
export interface FieldworkNote { item_key: string; checked: boolean; note: string; updated_at?: string }

export async function fetchFieldworkNotes(id: number): Promise<FieldworkNote[]> {
  return apiJson<FieldworkNote[]>(`/api/listings/${id}/fieldwork`);
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
