/**
 * 자체호스팅 PostgreSQL 접근 (node-postgres). Supabase 제거.
 * DATABASE_URL(.env)로 연결. camelCase 도메인 ↔ snake_case 컬럼 매핑을 모은다.
 */
import pg from 'pg';
import type {
  Listing, ListingDoc, RightsAnalysisResult, LocationAnalysis, Score,
} from './types.ts';
import type { CrawlRunRow } from './crawl-health.ts';

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
        area_m2,building_area_m2,is_collective_building,source,source_url,raw_json,crawled_at,
        inq_cnt,interest_cnt)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23)
     on conflict (case_no,item_no,source) do update set
       court=excluded.court, address=excluded.address, road_address=coalesce(excluded.road_address, gm_listings.road_address),
       lat=coalesce(excluded.lat, gm_listings.lat), lng=coalesce(excluded.lng, gm_listings.lng), property_type=excluded.property_type,
       appraisal_value=excluded.appraisal_value, min_bid_price=excluded.min_bid_price,
       min_bid_ratio=excluded.min_bid_ratio, fail_count=excluded.fail_count,
       sale_date=excluded.sale_date, demand_deadline=coalesce(excluded.demand_deadline, gm_listings.demand_deadline),
       area_m2=coalesce(excluded.area_m2, gm_listings.area_m2), building_area_m2=coalesce(excluded.building_area_m2, gm_listings.building_area_m2),
       is_collective_building=(gm_listings.is_collective_building or excluded.is_collective_building), source_url=excluded.source_url,
       raw_json=excluded.raw_json, crawled_at=excluded.crawled_at,
       inq_cnt=excluded.inq_cnt, interest_cnt=excluded.interest_cnt
     returning id`,
    [
      l.caseNo, l.itemNo ?? '1', l.court, l.address, l.roadAddress ?? null, l.lat ?? null, l.lng ?? null,
      l.propertyType, l.appraisalValue ?? null, l.minBidPrice ?? null, l.minBidRatio ?? null,
      l.failCount ?? 0, l.saleDate ?? null, l.demandDeadline ?? null, l.areaM2 ?? null,
      l.buildingAreaM2 ?? null, l.isCollectiveBuilding ?? false, l.source, l.sourceUrl ?? null,
      j(l.rawJson), l.crawledAt, l.inquiryCount ?? null, l.interestCount ?? null,
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

/** 경쟁 열기 일별 스냅샷 — gm_listings는 현재값만 덮어쓰므로 추세(급증 감지)용 시계열을 별도 적재. */
export async function recordCompetitionSnapshot(l: Listing): Promise<void> {
  if (l.inquiryCount == null && l.interestCount == null) return;
  await query(
    `insert into gm_competition_history (case_no, item_no, captured_date, inq_cnt, interest_cnt)
     values ($1, $2, current_date, $3, $4)
     on conflict (case_no, item_no, captured_date) do update set
       inq_cnt = excluded.inq_cnt, interest_cnt = excluded.interest_cnt`,
    [l.caseNo, l.itemNo || '1', l.inquiryCount ?? null, l.interestCount ?? null],
  );
}

export async function replaceListingDocs(listingId: number, docs: ListingDoc[], docTypes: string[]): Promise<void> {
  if (!docTypes.length) return;
  await query(`delete from gm_listing_docs where listing_id=$1 and doc_type = any($2::text[])`, [listingId, docTypes]);
  for (const doc of docs) await upsertListingDoc(listingId, doc);
}

/** 문서 내용 변경 이력 기록(발품절감 ⑤) — watch-favorites가 ★매물 것을 알림 후 notified 마킹. */
export async function recordDocChange(listingId: number, caseNo: string, docTypes: string[]): Promise<void> {
  await query(
    `insert into gm_doc_changes (listing_id, case_no, doc_types) values ($1,$2,$3)`,
    [listingId, caseNo, docTypes.join(',')],
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
       (listing_id,market_price,comps,safety_margin,transit,schools,amenities,dev_signals,market_confidence,comp_basis,
        expected_bid_price,expected_bid_basis,acquisition_cost,site_comps,sale_rounds,building,land_use_flags,admin_offices,report,photos,income,eviction,analyzed_at)
     values ($1,$2,$3::jsonb,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,
        $11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,now())
     on conflict (listing_id) do update set
       -- 시세는 마지막 정상값 보존: 이번 분석이 시세 산출 실패(null)면 기존값/근거 유지(MOLIT 쿼터·차단 중 재분석 회귀 방지)
       market_price=coalesce(excluded.market_price, gm_location_analysis.market_price),
       comps=case when excluded.market_price is null then gm_location_analysis.comps else excluded.comps end,
       market_confidence=case when excluded.market_price is null then gm_location_analysis.market_confidence else excluded.market_confidence end,
       comp_basis=case when excluded.market_price is null then gm_location_analysis.comp_basis else excluded.comp_basis end,
       safety_margin=coalesce(excluded.safety_margin, gm_location_analysis.safety_margin),
       -- 입지 보강(OSM 도보·생활인프라·학군)은 별도 enrich 패스가 채우므로 병합 보존(키 충돌 시 새 값 우선)
       transit=coalesce(gm_location_analysis.transit,'{}'::jsonb) || coalesce(excluded.transit,'{}'::jsonb),
       schools=coalesce(gm_location_analysis.schools,'{}'::jsonb) || coalesce(excluded.schools,'{}'::jsonb),
       amenities=coalesce(gm_location_analysis.amenities,'{}'::jsonb) || coalesce(excluded.amenities,'{}'::jsonb),
       dev_signals=excluded.dev_signals,
       expected_bid_price=excluded.expected_bid_price,
       expected_bid_basis=excluded.expected_bid_basis, acquisition_cost=excluded.acquisition_cost,
       site_comps=excluded.site_comps, sale_rounds=excluded.sale_rounds, building=excluded.building,
       -- 규제 flags는 분석이 결정형으로 재생성 → 새 값이 있으면 교체, 비면 기존(OSM 소음 flag 등) 유지
       land_use_flags=case when jsonb_array_length(coalesce(excluded.land_use_flags,'[]'::jsonb))>0 then excluded.land_use_flags else gm_location_analysis.land_use_flags end,
       admin_offices=excluded.admin_offices, report=excluded.report,
       photos=case when jsonb_array_length(coalesce(excluded.photos,'[]'::jsonb))>0 then excluded.photos else gm_location_analysis.photos end,
       income=coalesce(excluded.income, gm_location_analysis.income), eviction=excluded.eviction, analyzed_at=now()`,
    [listingId, loc.marketPrice, j(loc.comps), loc.safetyMargin, j(loc.transit), j(loc.schools),
     j(loc.amenities), j(loc.devSignals), loc.marketConfidence ?? null, loc.compBasis ?? null,
     loc.expectedBidPrice ?? null, loc.expectedBidBasis ?? null, j(loc.acquisitionCost), j(loc.siteComps),
     j(loc.saleRounds), j(loc.building), j(loc.landUseFlags), j(loc.adminOffices), j(loc.report), j(loc.photos), j(loc.income), j(loc.eviction)],
  );
}

/** sale_rounds 차수에서 fail_count 역산해 gm_listings 갱신 — 이전엔 saveLocationAnalysis의 숨은
 *  부수효과였던 것을 분리(호출부에서 명시 호출). N차 매각기일 = N-1회 유찰;
 *  sale_date 일치 차수 우선, 없으면 과거 최대 차수를 하한으로 사용. */
export async function backfillFailCountFromSaleRounds(listingId: number, saleRounds: LocationAnalysis['saleRounds']): Promise<void> {
  if (!saleRounds || saleRounds.length === 0) return;
  await query(
    `UPDATE gm_listings SET fail_count = COALESCE(
       (SELECT (r->>'round')::int - 1
        FROM jsonb_array_elements($2::jsonb) AS r
        WHERE r->>'date' = sale_date::text
        LIMIT 1),
       (SELECT MAX((r->>'round')::int)
        FROM jsonb_array_elements($2::jsonb) AS r
        WHERE (r->>'date')::date < sale_date)
     ) WHERE id = $1`,
    [listingId, j(saleRounds)],
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
  id: number, patch: { nFound?: number; nNew?: number; status: 'ok' | 'error' | 'blocked'; error?: string },
): Promise<void> {
  await query(
    `update gm_crawl_runs set n_found=$2, n_new=$3, status=$4, error=$5, finished_at=now() where id=$1`,
    [id, patch.nFound ?? 0, patch.nNew ?? 0, patch.status, patch.error ?? null],
  );
}

/** 최근 크롤런 N개(최신순) — 수집 헬스체크용(scripts/crawl-health.ts). */
export async function recentCrawlRuns(limit = 50): Promise<CrawlRunRow[]> {
  return query<CrawlRunRow>(
    `select id, source, status, n_found, n_new, started_at, finished_at
       from gm_crawl_runs order by started_at desc limit $1`,
    [limit],
  );
}

// ── 읽기 ─────────────────────────────────────────────────────────
export interface ListingRow {
  id: number; case_no: string; item_no: string; court: string; address: string; road_address: string | null;
  lat: number | null; lng: number | null; property_type: Listing['propertyType'];
  appraisal_value: string | null; min_bid_price: string | null; fail_count: number | null;
  sale_date: string | null; demand_deadline: string | null; area_m2: string | null;
  is_collective_building: boolean | null; source: Listing['source']; source_url: string | null;
}

export async function fetchListingsForAnalysis(limit = 200, onlyNew = false): Promise<ListingRow[]> {
  const where = onlyNew
    ? 'where not exists (select 1 from gm_scores s where s.listing_id = gm_listings.id)'
    : '';
  // 활성(미래 기일·기일미정) 우선 — 재고가 limit를 넘어도 지나간 물건이 활성 재분석을 밀어내지 않게.
  return query<ListingRow>(
    `select id, case_no, coalesce(item_no,'1') as item_no, court, address, road_address, lat, lng, property_type, appraisal_value,
            min_bid_price, fail_count, sale_date, demand_deadline, area_m2, is_collective_building, source, source_url
     from gm_listings ${where}
     order by (sale_date is null or sale_date >= current_date) desc, crawled_at desc limit $1`,
    [limit],
  );
}

export async function fetchListingDocs(listingId: number): Promise<{ doc_type: string; parsed_json: any }[]> {
  return query<{ doc_type: string; parsed_json: any }>(
    `select doc_type, parsed_json from gm_listing_docs where listing_id=$1`,
    [listingId],
  );
}

/** 특정 id들만 분석 대상으로 로드(교차보강 후 타겟 재분석용, analyze --ids=). */
export async function fetchListingsByIds(ids: number[]): Promise<ListingRow[]> {
  if (!ids.length) return [];
  return query<ListingRow>(
    `select id, case_no, coalesce(item_no,'1') as item_no, court, address, road_address, lat, lng, property_type, appraisal_value,
            min_bid_price, fail_count, sale_date, demand_deadline, area_m2, is_collective_building, source, source_url
     from gm_listings where id = any($1::bigint[])`,
    [ids],
  );
}

// ── 교차 보강(courtauction ↔ deonakchal): 임차인 상세를 별도 테이블에 유지(courtauction 재크롤로 안 지워지게 + 시도 마커 겸용) ──
export interface EnrichCandidate { id: number; case_no: string; court: string; item_no: string }
const TARGET_DEONAK_DETAIL_ADDRESS_SQL = `
  l.address like '%남양주%' and (
    l.address like '%화도%' or l.address like '%묵현%' or l.address like '%마석%' or
    l.address like '%창현%' or l.address like '%월산%'
  )`;

export async function fetchTargetDeonakDetailCandidates(limit: number, retryDays = 1): Promise<EnrichCandidate[]> {
  return query<EnrichCandidate>(
    `select l.id, l.case_no, l.court, coalesce(l.item_no,'1') as item_no
       from gm_listings l
       left join gm_deonak_tenants dt
         on dt.listing_id = l.id
        and dt.case_no = l.case_no
        and coalesce(dt.item_no,'1') = coalesce(l.item_no,'1')
      where l.source = 'courtauction'
        and (l.sale_date is null or l.sale_date >= current_date - 2)
        and (${TARGET_DEONAK_DETAIL_ADDRESS_SQL})
        and (
          dt.listing_id is null
          or dt.fetched_at < now() - (($2)::text || ' days')::interval
          or not exists (
            select 1 from gm_listing_docs d
             where d.listing_id = l.id and d.parsed_json->>'source' = 'deonakchal'
          )
        )
      order by l.sale_date nulls last, l.crawled_at desc
      limit $1`,
    [limit, retryDays],
  );
}
/** 보강 후보: 통과 + courtauction + 점유관계 미상 + (미시도 or retryDays 경과). ★관심·고점수 우선. */
export async function fetchEnrichmentCandidates(limit: number, retryDays = 14): Promise<EnrichCandidate[]> {
  return query<EnrichCandidate>(
    `select l.id, l.case_no, l.court, coalesce(l.item_no,'1') as item_no
       from gm_listings l
       join gm_scores s on s.listing_id = l.id
       join gm_location_analysis loc on loc.listing_id = l.id
       left join gm_deonak_tenants dt
         on dt.listing_id = l.id
        and dt.case_no = l.case_no
        and coalesce(dt.item_no,'1') = coalesce(l.item_no,'1')
      where s.passed_filter = true and l.source = 'courtauction'
        and loc.eviction->>'occupantLabel' = '점유관계 미상'
        and (dt.listing_id is null or dt.fetched_at < now() - (($2)::text || ' days')::interval)
      order by l.is_favorite desc, s.total_score desc nulls last
      limit $1`,
    [limit, retryDays],
  );
}
/** deonakchal 조회 결과 저장(found=true면 tenants, false면 '없음' 마커). 반복 히트 방지 + analyze 소스. */
export async function upsertDeonakTenants(listingId: number, caseNo: string, itemNo: string, tenants: unknown, found: boolean): Promise<void> {
  await query(
    `insert into gm_deonak_tenants (listing_id, case_no, item_no, tenants, found, fetched_at)
     values ($1,$2,$3,$4::jsonb,$5,now())
     on conflict (listing_id) do update set
       case_no=excluded.case_no, item_no=excluded.item_no, tenants=excluded.tenants, found=excluded.found, fetched_at=now()`,
    [listingId, caseNo, itemNo || '1', j(tenants ?? []), found],
  );
}
/** analyze용: 이 물건의 deonakchal 임차인(있으면). courtauction 임차인 미파싱을 보강. */
export async function fetchDeonakTenants(listingId: number, itemNo: string): Promise<any[] | null> {
  const rows = await query<{ tenants: any; found: boolean }>(
    `select tenants, found
       from gm_deonak_tenants
      where listing_id=$1
        and coalesce(item_no,'1')=$2
        and found=true`,
    [listingId, itemNo || '1'],
  );
  const t = rows[0]?.tenants;
  return Array.isArray(t) && t.length ? t : null;
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
