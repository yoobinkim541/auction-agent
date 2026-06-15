/**
 * 자체호스팅 PostgreSQL 접근 (node-postgres). Supabase 제거.
 * DATABASE_URL(.env)로 연결. camelCase 도메인 ↔ snake_case 컬럼 매핑을 모은다.
 */
import pg from 'pg';
import type {
  Listing, ListingDoc, RightsAnalysisResult, LocationAnalysis, Score,
} from './types.ts';

let _pool: pg.Pool | null = null;

export function pool(): pg.Pool {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL 환경변수가 필요합니다 (.env 참고)');
  _pool = new pg.Pool({ connectionString, max: 5 });
  return _pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query<T>(sql, params as any[]);
  return res.rows;
}

const j = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

// ── 쓰기 ─────────────────────────────────────────────────────────
export async function upsertListing(l: Listing): Promise<number> {
  const rows = await query<{ id: number }>(
    `insert into gm_listings
       (case_no,item_no,court,address,road_address,lat,lng,property_type,
        appraisal_value,min_bid_price,min_bid_ratio,fail_count,sale_date,demand_deadline,
        area_m2,building_area_m2,is_collective_building,source,source_url,raw_json,crawled_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21)
     on conflict (case_no,item_no,source) do update set
       court=excluded.court, address=excluded.address, road_address=excluded.road_address,
       lat=excluded.lat, lng=excluded.lng, property_type=excluded.property_type,
       appraisal_value=excluded.appraisal_value, min_bid_price=excluded.min_bid_price,
       min_bid_ratio=excluded.min_bid_ratio, fail_count=excluded.fail_count,
       sale_date=excluded.sale_date, demand_deadline=excluded.demand_deadline,
       area_m2=excluded.area_m2, building_area_m2=excluded.building_area_m2,
       is_collective_building=excluded.is_collective_building, source_url=excluded.source_url,
       raw_json=excluded.raw_json, crawled_at=excluded.crawled_at
     returning id`,
    [
      l.caseNo, l.itemNo ?? '', l.court, l.address, l.roadAddress ?? null, l.lat ?? null, l.lng ?? null,
      l.propertyType, l.appraisalValue ?? null, l.minBidPrice ?? null, l.minBidRatio ?? null,
      l.failCount ?? 0, l.saleDate ?? null, l.demandDeadline ?? null, l.areaM2 ?? null,
      l.buildingAreaM2 ?? null, l.isCollectiveBuilding ?? false, l.source, l.sourceUrl ?? null,
      j(l.rawJson), l.crawledAt,
    ],
  );
  return rows[0]!.id;
}

export async function deleteListingDocs(listingId: number): Promise<void> {
  await query(`delete from gm_listing_docs where listing_id=$1`, [listingId]);
}

export async function upsertListingDoc(listingId: number, doc: ListingDoc): Promise<void> {
  await query(
    `insert into gm_listing_docs (listing_id, doc_type, parsed_json, pdf_path)
     values ($1,$2,$3::jsonb,$4)`,
    [listingId, doc.docType, j(doc.parsedJson), doc.pdfPath ?? null],
  );
}

export async function saveRightsAnalysis(
  listingId: number, r: RightsAnalysisResult, modelVersion?: string, citations?: unknown,
): Promise<void> {
  await query(
    `insert into gm_rights_analysis
       (listing_id,malso_basis,classified,tenants,distribution,assumed_amount,assumed_breakdown,
        max_safe_bid,red_flags,risk_grade,is_clean,citations,warnings,engine_version,model_version,analyzed_at)
     values ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12::jsonb,$13::jsonb,$14,$15,now())
     on conflict (listing_id) do update set
       malso_basis=excluded.malso_basis, classified=excluded.classified, tenants=excluded.tenants,
       distribution=excluded.distribution, assumed_amount=excluded.assumed_amount,
       assumed_breakdown=excluded.assumed_breakdown, max_safe_bid=excluded.max_safe_bid,
       red_flags=excluded.red_flags, risk_grade=excluded.risk_grade, is_clean=excluded.is_clean,
       citations=excluded.citations, warnings=excluded.warnings, engine_version=excluded.engine_version,
       model_version=excluded.model_version, analyzed_at=now()`,
    [
      listingId, j(r.malsoBasis), j(r.classified), j(r.tenants), j(r.distribution), r.assumedAmount,
      j(r.assumedBreakdown), r.maxSafeBid, j(r.redFlags), r.riskGrade, r.isClean, j(citations ?? null),
      j(r.warnings), r.engineVersion, modelVersion ?? null,
    ],
  );
}

export async function saveLocationAnalysis(listingId: number, loc: LocationAnalysis): Promise<void> {
  await query(
    `insert into gm_location_analysis
       (listing_id,market_price,comps,safety_margin,transit,schools,amenities,dev_signals,market_confidence,comp_basis,analyzed_at)
     values ($1,$2,$3::jsonb,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,now())
     on conflict (listing_id) do update set
       market_price=excluded.market_price, comps=excluded.comps, safety_margin=excluded.safety_margin,
       transit=excluded.transit, schools=excluded.schools, amenities=excluded.amenities,
       dev_signals=excluded.dev_signals, market_confidence=excluded.market_confidence,
       comp_basis=excluded.comp_basis, analyzed_at=now()`,
    [listingId, loc.marketPrice, j(loc.comps), loc.safetyMargin, j(loc.transit), j(loc.schools),
     j(loc.amenities), j(loc.devSignals), loc.marketConfidence ?? null, loc.compBasis ?? null],
  );
}

export async function saveScore(listingId: number, s: Score): Promise<void> {
  await query(
    `insert into gm_scores (listing_id,safety_margin_score,clean_rights_score,total_score,passed_filter,reason,scored_at)
     values ($1,$2,$3,$4,$5,$6,now())
     on conflict (listing_id) do update set
       safety_margin_score=excluded.safety_margin_score, clean_rights_score=excluded.clean_rights_score,
       total_score=excluded.total_score, passed_filter=excluded.passed_filter, reason=excluded.reason, scored_at=now()`,
    [listingId, s.safetyMarginScore, s.cleanRightsScore, s.totalScore, s.passedFilter, s.reason],
  );
}

export async function startCrawlRun(source: string, region: string): Promise<number> {
  const rows = await query<{ id: number }>(
    `insert into gm_crawl_runs (source, region, status) values ($1,$2,'running') returning id`,
    [source, region],
  );
  return rows[0]!.id;
}

export async function finishCrawlRun(
  id: number, patch: { nFound?: number; nNew?: number; status: 'ok' | 'error'; error?: string },
): Promise<void> {
  await query(
    `update gm_crawl_runs set n_found=$2, n_new=$3, status=$4, error=$5, finished_at=now() where id=$1`,
    [id, patch.nFound ?? 0, patch.nNew ?? 0, patch.status, patch.error ?? null],
  );
}

// ── 읽기 ─────────────────────────────────────────────────────────
export interface ListingRow {
  id: number; case_no: string; court: string; address: string; road_address: string | null;
  lat: number | null; lng: number | null; property_type: Listing['propertyType'];
  appraisal_value: string | null; min_bid_price: string | null; fail_count: number | null;
  sale_date: string | null; demand_deadline: string | null; area_m2: string | null;
  is_collective_building: boolean | null; source: Listing['source'];
}

export async function fetchListingsForAnalysis(limit = 200, onlyNew = false): Promise<ListingRow[]> {
  const where = onlyNew
    ? 'where not exists (select 1 from gm_scores s where s.listing_id = gm_listings.id)'
    : '';
  return query<ListingRow>(
    `select id, case_no, court, address, road_address, lat, lng, property_type, appraisal_value,
            min_bid_price, fail_count, sale_date, demand_deadline, area_m2, is_collective_building, source
     from gm_listings ${where} order by crawled_at desc limit $1`,
    [limit],
  );
}

export async function fetchListingDocs(listingId: number): Promise<{ doc_type: string; parsed_json: any }[]> {
  return query<{ doc_type: string; parsed_json: any }>(
    `select doc_type, parsed_json from gm_listing_docs where listing_id=$1`,
    [listingId],
  );
}

export async function matchLegalChunks(
  embedding: number[], queryText: string, matchCount = 6,
): Promise<{ law_name: string; article: string; content: string }[]> {
  const vec = `[${embedding.join(',')}]`;
  return query<{ law_name: string; article: string; content: string }>(
    `select law_name, article, content from match_legal_chunks($1::vector,$2,$3)`,
    [vec, queryText, matchCount],
  );
}

export async function insertLegalChunks(
  rows: { source: string; lawName: string; article: string; content: string; embedding: number[] | null }[],
): Promise<void> {
  for (const r of rows) {
    await query(
      `insert into gm_legal_chunks (source, law_name, article, content, embedding)
       values ($1,$2,$3,$4,$5::vector)`,
      [r.source, r.lawName, r.article, r.content, r.embedding ? `[${r.embedding.join(',')}]` : null],
    );
  }
}

/** 임베딩 없이 키워드(full-text)만으로 법령 검색 — OpenAI 키 없을 때 사용.
 *  여러 단어를 OR로 묶어(to_tsquery '|') 관련 조문을 폭넓게 매칭. */
export async function matchLegalChunksKeyword(
  queryText: string, matchCount = 6,
): Promise<{ law_name: string; article: string; content: string }[]> {
  // 단어 추출 → "a | b | c" tsquery (특수문자 제거)
  const terms = queryText.replace(/[^\w가-힣\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const tsq = terms.join(' | ');
  return query<{ law_name: string; article: string; content: string }>(
    `select law_name, article, content
     from gm_legal_chunks
     where content_tsv @@ to_tsquery('simple', $1)
     order by ts_rank(content_tsv, to_tsquery('simple', $1)) desc
     limit $2`,
    [tsq, matchCount],
  );
}

export async function fetchSolvedCases(limit = 1000): Promise<
  { case_no: string | null; source: string; input_json: any; expected_json: any; note: string | null }[]
> {
  return query(
    `select case_no, source, input_json, expected_json, note from gm_solved_cases limit $1`,
    [limit],
  );
}
