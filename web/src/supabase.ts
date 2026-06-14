import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseReady = Boolean(url && anon);
export const supabase = createClient(url ?? 'http://localhost', anon ?? 'anon');

// 대시보드가 읽는 조인 행 형태
export interface RightsRow {
  malso_basis: { note?: string; date?: string | null } | null;
  classified: { entry: { kind: string; receiptDate: string; amount?: number }; disposition: string; reason: string }[] | null;
  tenants: { tenant: { name?: string; deposit: number }; hasOpposition: boolean; isSmallTenant: boolean }[] | null;
  assumed_amount: number | null;
  assumed_breakdown: { label: string; amount: number; reason: string }[] | null;
  max_safe_bid: number | null;
  red_flags: { kind: string; severity: string; message: string }[] | null;
  risk_grade: 'clean' | 'caution' | 'risky' | 'review_required' | null;
  is_clean: boolean | null;
  warnings: string[] | null;
}
export interface LocationRow {
  market_price: number | null;
  safety_margin: number | null;
  transit: { nearestStation?: string; walkMinutes?: number } | null;
  schools: { academyCount?: number; schoolCount?: number } | null;
  amenities: Record<string, number> | null;
}
export interface ScoreRow {
  total_score: number | null;
  safety_margin_score: number | null;
  clean_rights_score: number | null;
  passed_filter: boolean | null;
  reason: string | null;
}
export interface ListingRow {
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
  gm_rights_analysis: RightsRow[] | null;
  gm_location_analysis: LocationRow[] | null;
  gm_scores: ScoreRow[] | null;
}

export async function fetchListings(): Promise<ListingRow[]> {
  const { data, error } = await supabase
    .from('gm_listings')
    .select(
      '*, gm_rights_analysis(*), gm_location_analysis(*), gm_scores(*)',
    )
    .limit(500);
  if (error) throw error;
  return (data ?? []) as ListingRow[];
}

export const won = (n: number | null | undefined): string =>
  n == null ? '-' : n.toLocaleString('ko-KR') + '원';
export const eok = (n: number | null | undefined): string =>
  n == null ? '-' : (n / 1e8).toFixed(2) + '억';
