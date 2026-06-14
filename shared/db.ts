/**
 * Supabase 접근 (백엔드: service_role 키 사용 → RLS 우회).
 * camelCase 도메인 타입 ↔ snake_case DB 컬럼 매핑을 이 파일에 모은다.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  Listing,
  ListingDoc,
  RightsAnalysisResult,
  LocationAnalysis,
  Score,
} from './types.ts';

let _client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다 (.env 참고)');
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/** 매물 upsert → listing id 반환 */
export async function upsertListing(l: Listing): Promise<number> {
  const row = {
    case_no: l.caseNo,
    item_no: l.itemNo ?? null,
    court: l.court,
    address: l.address,
    road_address: l.roadAddress ?? null,
    lat: l.lat ?? null,
    lng: l.lng ?? null,
    property_type: l.propertyType,
    appraisal_value: l.appraisalValue ?? null,
    min_bid_price: l.minBidPrice ?? null,
    min_bid_ratio: l.minBidRatio ?? null,
    fail_count: l.failCount ?? 0,
    sale_date: l.saleDate ?? null,
    demand_deadline: l.demandDeadline ?? null,
    area_m2: l.areaM2 ?? null,
    building_area_m2: l.buildingAreaM2 ?? null,
    is_collective_building: l.isCollectiveBuilding ?? false,
    source: l.source,
    source_url: l.sourceUrl ?? null,
    raw_json: l.rawJson ?? null,
    crawled_at: l.crawledAt,
  };
  const { data, error } = await db()
    .from('gm_listings')
    .upsert(row, { onConflict: 'case_no,item_no,source' })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: number }).id;
}

export async function upsertListingDoc(listingId: number, doc: ListingDoc): Promise<void> {
  const { error } = await db().from('gm_listing_docs').insert({
    listing_id: listingId,
    doc_type: doc.docType,
    parsed_json: doc.parsedJson ?? null,
    pdf_path: doc.pdfPath ?? null,
  });
  if (error) throw error;
}

export async function saveRightsAnalysis(
  listingId: number,
  r: RightsAnalysisResult,
  modelVersion?: string,
  citations?: unknown,
): Promise<void> {
  const { error } = await db().from('gm_rights_analysis').upsert(
    {
      listing_id: listingId,
      malso_basis: r.malsoBasis,
      classified: r.classified,
      tenants: r.tenants,
      distribution: r.distribution,
      assumed_amount: r.assumedAmount,
      assumed_breakdown: r.assumedBreakdown,
      max_safe_bid: r.maxSafeBid,
      red_flags: r.redFlags,
      risk_grade: r.riskGrade,
      is_clean: r.isClean,
      citations: citations ?? null,
      warnings: r.warnings,
      engine_version: r.engineVersion,
      model_version: modelVersion ?? null,
      analyzed_at: new Date().toISOString(),
    },
    { onConflict: 'listing_id' },
  );
  if (error) throw error;
}

export async function saveLocationAnalysis(listingId: number, loc: LocationAnalysis): Promise<void> {
  const { error } = await db().from('gm_location_analysis').upsert(
    {
      listing_id: listingId,
      market_price: loc.marketPrice,
      comps: loc.comps,
      safety_margin: loc.safetyMargin,
      transit: loc.transit ?? null,
      schools: loc.schools ?? null,
      amenities: loc.amenities ?? null,
      dev_signals: loc.devSignals ?? null,
      analyzed_at: new Date().toISOString(),
    },
    { onConflict: 'listing_id' },
  );
  if (error) throw error;
}

export async function saveScore(listingId: number, s: Score): Promise<void> {
  const { error } = await db().from('gm_scores').upsert(
    {
      listing_id: listingId,
      safety_margin_score: s.safetyMarginScore,
      clean_rights_score: s.cleanRightsScore,
      total_score: s.totalScore,
      passed_filter: s.passedFilter,
      reason: s.reason,
      scored_at: new Date().toISOString(),
    },
    { onConflict: 'listing_id' },
  );
  if (error) throw error;
}

export async function startCrawlRun(source: string, region: string): Promise<number> {
  const { data, error } = await db()
    .from('gm_crawl_runs')
    .insert({ source, region, status: 'running' })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: number }).id;
}

export async function finishCrawlRun(
  id: number,
  patch: { nFound?: number; nNew?: number; status: 'ok' | 'error'; error?: string },
): Promise<void> {
  const { error } = await db()
    .from('gm_crawl_runs')
    .update({
      n_found: patch.nFound ?? 0,
      n_new: patch.nNew ?? 0,
      status: patch.status,
      error: patch.error ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}
