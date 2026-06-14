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
  safety_margin?: number | null;
  transit?: { nearestStation?: string; walkMinutes?: number } | null;
  schools?: { academyCount?: number; schoolCount?: number } | null;
  amenities?: Record<string, number> | null;
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
  is_favorite: boolean | null;
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

export async function triggerJob(job: 'crawl' | 'analyze' | 'eval' | 'ingest-legal'): Promise<void> {
  await fetch(`${BASE}/api/jobs/${job}`, { method: 'POST' });
}

export async function setFavorite(id: number, value: boolean): Promise<void> {
  await fetch(`${BASE}/api/listings/${id}/favorite?value=${value}`, { method: 'POST' });
}

export const won = (n: number | null | undefined): string =>
  n == null ? '-' : n.toLocaleString('ko-KR') + '원';
export const eok = (n: number | null | undefined): string =>
  n == null ? '-' : (n / 1e8).toFixed(2) + '억';
