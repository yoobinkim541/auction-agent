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
}
export interface ListingItem {
  id: number;
  case_no: string;
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
  is_favorite: boolean | null;
  crawled_at: string | null;
  lat: number | null;
  lng: number | null;
  field_done: number | null;   // 현장 체크리스트 확인 완료 개수
  field_total: number | null;  // 현장 체크리스트 전체 개수
  field_notes: number | null;  // 현장 메모 작성 개수
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
  const res = await fetch(`${BASE}/api/jobs/${job}`, { method: 'POST' });
  if (!res.ok) throw new Error(`잡 실행 실패 (${res.status})`);
}

export interface JobStatus { state: 'idle' | 'running' | 'ok' | 'error'; startedAt?: string; finishedAt?: string; exitCode?: number; error?: string; }
export async function fetchJobStatus(): Promise<Record<string, JobStatus>> {
  const res = await fetch(`${BASE}/api/jobs/status`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as Record<string, JobStatus>;
}

export async function setFavorite(id: number, value: boolean): Promise<void> {
  await fetch(`${BASE}/api/listings/${id}/favorite?value=${value}`, { method: 'POST' });
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
    const runs = (await res.json()) as { started_at: string; status: string; source: string }[];
    const lastOk = runs.find((r) => r.status === 'ok' && r.source === 'deonakchal');
    if (!lastOk) {
      // 최근 실행이 전부 차단/오류인지 확인
      const anyBlocked = runs.some((r) => r.source === 'deonakchal' && r.status === 'blocked');
      return anyBlocked
        ? { date: '없음', daysAgo: 999, stale: true, source: 'deonakchal', blocked: true }
        : null;
    }
    const date = lastOk.started_at.slice(0, 10);
    const daysAgo = Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);
    // 가장 최근 실행이 차단이었는지 (성공 이후에 차단이 왔는지)
    const latestRun = runs.find((r) => r.source === 'deonakchal');
    const blocked = latestRun?.status === 'blocked';
    return { date, daysAgo, stale: daysAgo > 3, source: 'deonakchal', blocked };
  } catch { return null; }
}

export const won = (n: number | null | undefined): string =>
  n == null ? '-' : n.toLocaleString('ko-KR') + '원';
export const eok = (n: number | null | undefined): string =>
  n == null ? '-' : (n / 1e8).toFixed(2) + '억';
