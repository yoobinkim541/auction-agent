package com.gyeongmae.service;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * 매물 + 권리/입지/점수 조인 결과를 Postgres가 직접 JSON으로 조립해 반환.
 * (JPA jsonb 매핑을 피하고 응답을 그대로 전달)
 */
@Service
public class ListingService {

  private final NamedParameterJdbcTemplate jdbc;

  public ListingService(DataSource ds) {
    this.jdbc = new NamedParameterJdbcTemplate(ds);
  }

  private static final String SELECT_BODY = """
      select l.id, l.case_no, l.item_no, l.court, l.address, l.property_type,
             l.appraisal_value, l.min_bid_price, l.fail_count, l.sale_date, l.area_m2, l.source,
             l.source_url, l.is_favorite, l.inq_cnt, l.interest_cnt,
             coalesce(case when l.source = 'courtauction' then l.source_url end, 'https://www.courtauction.go.kr/pgj/index.on') as court_check_url,
             coalesce(
               case when l.source = 'deonakchal' then l.source_url end,
               deonak_doc.source_url,
               case when l.case_no ~ '^[0-9]{4}타경[0-9]+'
                    then 'https://www.xn--b20bu5cuwtpue8ui.com/auction/list.html?'
                         || case when deonak_court.court1 is not null then 'court1=' || deonak_court.court1 || '&' else '' end
                         || 'syear=' || substring(l.case_no from '([0-9]{4})타경')
                         || '&sno=' || substring(l.case_no from '타경([0-9]+)')
                    else 'https://www.xn--b20bu5cuwtpue8ui.com/auction/list.html' end
             ) as deonakchal_check_url,
             case when p.listing_id is null then null
                  else jsonb_build_object(
                    'status', p.status,
                    'confidence', p.confidence,
                    'conservative_value', p.conservative_value,
                    'recommended_bid', p.recommended_bid,
                    'hard_cap_bid', p.hard_cap_bid,
                    'reason_codes', p.reason_codes,
                    'strengths', p.strengths,
                    'risks', p.risks,
                    'required_checks', p.required_checks,
                    'evaluator_version', p.evaluator_version,
                    'evaluated_at', p.evaluated_at
                  ) end as precision,
             case when cal.sample_size is null then null
                  else jsonb_build_object(
                    'method', 'group_median_v1',
                    'status', 'reference_only',
                    'region', listing_region.region,
                    'sample_size', cal.sample_size,
                    'median_sale_ratio', cal.median_sale_ratio,
                    'median_realized_margin', cal.median_realized_margin,
                    'reference_bid_price', case when l.appraisal_value is null then null else round(l.appraisal_value * cal.median_sale_ratio)::bigint end,
                    'delta_vs_expected_bid', case when loc.expected_bid_price is null or l.appraisal_value is null then null else round(l.appraisal_value * cal.median_sale_ratio)::bigint - loc.expected_bid_price end
                  ) end as ml_calibration,
             (to_jsonb(r)   - 'id' - 'listing_id') as rights,
             (to_jsonb(loc) - 'id' - 'listing_id') as location,
             s.total_score, s.passed_filter, s.safety_margin_score, s.clean_rights_score, s.reason
      from gm_listings l
      left join gm_rights_analysis   r   on r.listing_id   = l.id
      left join gm_location_analysis loc on loc.listing_id = l.id
      left join gm_scores            s   on s.listing_id   = l.id
      left join gm_precision_evaluations p on p.listing_id = l.id

      left join lateral (
        select case
          when split_part(l.address, ' ', 1) in ('서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시')
            then split_part(l.address, ' ', 1) || ' ' || split_part(l.address, ' ', 2)
          when split_part(l.address, ' ', 1) like '%도'
            then split_part(l.address, ' ', 1) || ' ' || split_part(l.address, ' ', 2)
          else split_part(l.address, ' ', 1)
        end as region
      ) listing_region on true
      left join gm_ml_price_calibration cal on cal.property_type = l.property_type and cal.region = listing_region.region
      left join lateral (
        select case l.court
          when '서울중앙지방법원' then 'A1' when '서울동부지방법원' then 'A2' when '서울서부지방법원' then 'A3'
          when '서울남부지방법원' then 'A4' when '서울북부지방법원' then 'A5'
          when '의정부지방법원' then 'D1' when '고양지원' then 'D2' when '남양주지원' then 'D3'
          when '인천지방법원' then 'C1' when '부천지원' then 'C2'
          when '수원지방법원' then 'E1' when '성남지원' then 'E2' when '여주지원' then 'E3'
          when '평택지원' then 'E4' when '안산지원' then 'E5' when '안양지원' then 'E6'
          else null end as court1
      ) deonak_court on true
      left join lateral (
        select d.parsed_json->>'sourceUrl' as source_url
        from gm_listing_docs d
        where d.listing_id = l.id
          and d.parsed_json->>'source' = 'deonakchal'
          and d.parsed_json->>'sourceUrl' is not null
        order by d.created_at desc
        limit 1
      ) deonak_doc on true
      """;


  public Path photoPath(long listingId, String filename) {
    if (filename == null || !filename.matches("(?i)^[a-f0-9]{64}\\.(jpg|jpeg|png|webp|gif)$")) return null;
    List<Map<String, Object>> rows = jdbc.queryForList("""
        select cache_path
          from gm_listing_photos
         where listing_id = :id
           and status = 'active'
           and public_url = '/api/listings/' || cast(:id as text) || '/photos/' || :filename
         order by id desc
         limit 1
        """, new MapSqlParameterSource().addValue("id", listingId).addValue("filename", filename));
    if (rows.isEmpty()) return null;
    Object rawPath = rows.get(0).get("cache_path");
    if (rawPath == null) return null;
    Path path = Path.of(rawPath.toString()).normalize();
    return Files.isRegularFile(path) ? path : null;
  }

  /** 목록용 경량 쿼리 — comps/photos/report 본문/tenants/classified 등 무거운 필드 제외 (~10× 경량) */
  private static final String SELECT_SLIM = """
      select l.id, l.case_no, l.item_no, l.court, l.address, l.property_type,
             l.appraisal_value, l.min_bid_price, l.fail_count, l.sale_date, l.area_m2, l.source,
             l.source_url, l.is_favorite, l.crawled_at, l.lat, l.lng, l.inq_cnt, l.interest_cnt,
             coalesce(case when l.source = 'courtauction' then l.source_url end, 'https://www.courtauction.go.kr/pgj/index.on') as court_check_url,
             coalesce(
               case when l.source = 'deonakchal' then l.source_url end,
               deonak_doc.source_url,
               case when l.case_no ~ '^[0-9]{4}타경[0-9]+'
                    then 'https://www.xn--b20bu5cuwtpue8ui.com/auction/list.html?'
                         || case when deonak_court.court1 is not null then 'court1=' || deonak_court.court1 || '&' else '' end
                         || 'syear=' || substring(l.case_no from '([0-9]{4})타경')
                         || '&sno=' || substring(l.case_no from '타경([0-9]+)')
                    else 'https://www.xn--b20bu5cuwtpue8ui.com/auction/list.html' end
             ) as deonakchal_check_url,
             case when cal.sample_size is null then null
                  else jsonb_build_object(
                    'method', 'group_median_v1',
                    'status', 'reference_only',
                    'region', listing_region.region,
                    'sample_size', cal.sample_size,
                    'median_sale_ratio', cal.median_sale_ratio,
                    'median_realized_margin', cal.median_realized_margin,
                    'reference_bid_price', case when l.appraisal_value is null then null else round(l.appraisal_value * cal.median_sale_ratio)::bigint end,
                    'delta_vs_expected_bid', case when loc.expected_bid_price is null or l.appraisal_value is null then null else round(l.appraisal_value * cal.median_sale_ratio)::bigint - loc.expected_bid_price end
                  ) end as ml_calibration,
             (select count(*) from gm_fieldwork_notes fn where fn.listing_id = l.id and fn.checked) as field_done,
             coalesce(jsonb_array_length(loc.report->'fieldwork'->'fieldChecklist'), 0) as field_total,
             (select count(*) from gm_fieldwork_notes fn where fn.listing_id = l.id and fn.note <> '') as field_notes,
             case when r.id is null then null
                  else jsonb_build_object(
                    'risk_grade', r.risk_grade,
                    'assumed_amount', r.assumed_amount,
                    'max_safe_bid', r.max_safe_bid,
                    'red_flags', r.red_flags,
                    'is_clean', r.is_clean
                  ) end as rights,
             case when loc.id is null then null
                  else jsonb_build_object(
                    'market_price', loc.market_price,
                    'market_confidence', loc.market_confidence,
                    'safety_margin', loc.safety_margin,
                    'expected_bid_price', loc.expected_bid_price,
                    'acquisition_cost', case when loc.acquisition_cost is not null
                                             then jsonb_build_object('trueSafetyMargin', loc.acquisition_cost->'trueSafetyMargin')
                                             else null end,
                    'sale_rounds', loc.sale_rounds,
                    'report', case when loc.report is not null
                                   then jsonb_build_object(
                                     'headline', loc.report->>'headline',
                                     'recommendation', loc.report->>'recommendation',
                                     'dangerCount', (loc.report->>'dangerCount')::int,
                                     'warnCount',   (loc.report->>'warnCount')::int
                                   )
                                   else null end,
                    'income', case when loc.income is null then null
                                   else jsonb_build_object(
                                     'jeonseDeposit', loc.income->'jeonseDeposit',
                                     'gapInvestment', loc.income->'gapInvestment',
                                     'grossYieldPct', loc.income->'grossYieldPct',
                                     'zeroPiCandidate', loc.income->'zeroPiCandidate',
                                     'estimated', loc.income->'estimated'
                                   ) end
                  ) end as location,
             s.total_score, s.passed_filter, s.safety_margin_score, s.clean_rights_score, s.reason
      from gm_listings l
      left join gm_rights_analysis   r   on r.listing_id   = l.id
      left join gm_location_analysis loc on loc.listing_id = l.id
      left join gm_scores            s   on s.listing_id   = l.id

      left join lateral (
        select case
          when split_part(l.address, ' ', 1) in ('서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시')
            then split_part(l.address, ' ', 1) || ' ' || split_part(l.address, ' ', 2)
          when split_part(l.address, ' ', 1) like '%도'
            then split_part(l.address, ' ', 1) || ' ' || split_part(l.address, ' ', 2)
          else split_part(l.address, ' ', 1)
        end as region
      ) listing_region on true
      left join gm_ml_price_calibration cal on cal.property_type = l.property_type and cal.region = listing_region.region
      left join lateral (
        select case l.court
          when '서울중앙지방법원' then 'A1' when '서울동부지방법원' then 'A2' when '서울서부지방법원' then 'A3'
          when '서울남부지방법원' then 'A4' when '서울북부지방법원' then 'A5'
          when '의정부지방법원' then 'D1' when '고양지원' then 'D2' when '남양주지원' then 'D3'
          when '인천지방법원' then 'C1' when '부천지원' then 'C2'
          when '수원지방법원' then 'E1' when '성남지원' then 'E2' when '여주지원' then 'E3'
          when '평택지원' then 'E4' when '안산지원' then 'E5' when '안양지원' then 'E6'
          else null end as court1
      ) deonak_court on true
      left join lateral (
        select d.parsed_json->>'sourceUrl' as source_url
        from gm_listing_docs d
        where d.listing_id = l.id
          and d.parsed_json->>'source' = 'deonakchal'
          and d.parsed_json->>'sourceUrl' is not null
        order by d.created_at desc
        limit 1
      ) deonak_doc on true
      """;

  /** 매물 목록(JSON 배열 문자열) — 경량(목록 뷰용) */
  public String listSlimJson(boolean passedOnly, String type, String q) {
    String sql = "select coalesce(json_agg(t order by t.total_score desc nulls last), '[]'::json)::text from (\n"
        + SELECT_SLIM
        + " where (:passedOnly = false or s.passed_filter = true)\n"
        + "   and (:type = 'all' or l.property_type = :type)\n"
        + "   and (:q = '' or l.address ilike '%'||:q||'%' or l.case_no ilike '%'||:q||'%')\n"
        // 정지/경과 매물 제외: 최근 7일 내 수집된 것만(차단으로 굳은 deonakchal 등 제외) + 매각기일 경과(D+) 제외(2일 유예).
        // 목록·페이로드 정리용. 차단 해제·재수집 시 crawled_at 갱신으로 자동 복귀. 상세/다이제스트/학습 쿼리는 무관.
        + "   and l.crawled_at >= current_date - 7\n"
        + "   and (l.sale_date is null or l.sale_date >= current_date - 2)\n"
        + ") t";
    var params = new MapSqlParameterSource()
        .addValue("passedOnly", passedOnly)
        .addValue("type", type == null ? "all" : type)
        .addValue("q", q == null ? "" : q);
    return jdbc.queryForObject(sql, params, String.class);
  }

  /** 정밀 추천 후보(JSON 배열) — 후보 뷰의 추천 행만 기존 경량 매물 JSON에 결합한다. */
  public String precisionRecommendationsJson(int requestedLimit) {
    int limit = Math.max(3, Math.min(7, requestedLimit));
    String sql = """
        select coalesce(json_agg(t order by t.conservative_margin desc nulls last, t.sale_date asc nulls last, t.id asc), '[]'::json)::text
          from (
            select slim.*,
                   jsonb_build_object(
                     'status', shortlist.status,
                     'confidence', shortlist.confidence,
                     'conservative_value', shortlist.conservative_value,
                     'recommended_bid', shortlist.recommended_bid,
                     'hard_cap_bid', shortlist.hard_cap_bid,
                     'reason_codes', shortlist.reason_codes,
                     'strengths', shortlist.strengths,
                     'risks', shortlist.risks,
                     'required_checks', shortlist.required_checks,
                     'evaluator_version', shortlist.evaluator_version,
                     'evaluated_at', shortlist.evaluated_at
                   ) as precision,
                   case when decision.listing_id is null then null else jsonb_build_object(
                     'id', decision.id,
                     'listing_id', decision.listing_id,
                     'decision', decision.decision,
                     'reason_code', decision.reason_code,
                     'note', decision.note,
                     'target_bid', decision.target_bid,
                     'created_at', decision.created_at
                   ) end as current_decision,
                   shortlist.conservative_margin
              from (
        """ + SELECT_SLIM + """
              ) slim
              join gm_precision_shortlist shortlist on shortlist.listing_id = slim.id
             and shortlist.status = 'recommended'
              left join gm_current_decisions decision on decision.listing_id = slim.id
             order by shortlist.conservative_margin desc nulls last, slim.sale_date asc nulls last, slim.id asc
             limit :limit
          ) t
        """;
    return jdbc.queryForObject(sql, new MapSqlParameterSource("limit", limit), String.class);
  }

  /** 결정 이력(JSON 배열). 존재하지 않는 매물은 null로 구분한다. */
  public String decisionHistoryJson(long listingId) {
    Integer exists = jdbc.queryForObject(
        "select count(*)::int from gm_listings where id = :id",
        new MapSqlParameterSource("id", listingId), Integer.class);
    if (exists == null || exists == 0) return null;
    String sql = """
        select coalesce(json_agg(jsonb_build_object(
                 'id', id,
                 'listing_id', listing_id,
                 'decision', decision,
                 'reason_code', reason_code,
                 'note', note,
                 'target_bid', target_bid,
                 'precision_snapshot', precision_snapshot,
                 'created_at', created_at
               ) order by created_at desc, id desc), '[]'::json)::text
          from gm_decision_events
         where listing_id = :id
        """;
    return jdbc.queryForObject(sql, new MapSqlParameterSource("id", listingId), String.class);
  }

  /** 매물 존재와 최신 정밀 평가 스냅샷을 한 insert-select로 원자적으로 보존한다. */
  public String recordDecision(
      long listingId, String decision, String reasonCode, String note, Long targetBid) {
    String sql = """
        insert into gm_decision_events (
          listing_id, decision, reason_code, note, target_bid, precision_snapshot
        )
        select l.id,
               :decision,
               :reasonCode,
               :note,
               :targetBid,
               coalesce(to_jsonb(precision) - 'listing_id', '{}'::jsonb)
          from gm_listings l
          left join gm_precision_evaluations precision on precision.listing_id = l.id
         where l.id = :listingId
        returning jsonb_build_object(
          'id', id,
          'listing_id', listing_id,
          'decision', decision,
          'reason_code', reason_code,
          'note', note,
          'target_bid', target_bid,
          'precision_snapshot', precision_snapshot,
          'created_at', created_at
        )::text
        """;
    var params = new MapSqlParameterSource()
        .addValue("listingId", listingId)
        .addValue("decision", decision)
        .addValue("reasonCode", reasonCode)
        .addValue("note", note == null ? "" : note)
        .addValue("targetBid", targetBid);
    List<String> rows = jdbc.queryForList(sql, params, String.class);
    return rows.isEmpty() ? null : rows.get(0);
  }

  /** 결정 저널 집계(JSON 객체) — 개인화 순위에는 사용하지 않는 읽기 전용 리포트다. */
  public String decisionReviewJson() {
    String sql = """
        with summary as (
          select coalesce(max(sample_size), 0)::int as sample_size,
                 coalesce(bool_or(eligible_for_personalization), false) as eligible_for_personalization
            from gm_decision_preference_summary
        ), decision_counts as (
          select decision, sum(event_count)::int as event_count
            from gm_decision_preference_summary
           group by decision
        ), reason_distribution as (
          select reason_code, sum(event_count)::int as event_count
            from gm_decision_preference_summary
           where reason_code is not null
           group by reason_code
        ), current_counts as (
          select decision, count(*)::int as listing_count
            from gm_current_decisions
           group by decision
        ), funnel as (
          select coalesce(max(listing_count) filter (where decision = 'reviewing'), 0)::float8 as reviewing,
                 coalesce(max(listing_count) filter (where decision = 'favorite'), 0)::float8 as favorite,
                 coalesce(max(listing_count) filter (where decision = 'fieldwork'), 0)::float8 as fieldwork,
                 coalesce(max(listing_count) filter (where decision = 'bid_review'), 0)::float8 as bid_review
            from current_counts
        )
        select jsonb_build_object(
          'decision_counts', coalesce((select jsonb_object_agg(decision, event_count) from decision_counts), '{}'::jsonb),
          'reason_distribution', coalesce((select jsonb_object_agg(reason_code, event_count) from reason_distribution), '{}'::jsonb),
          'funnel_conversion', jsonb_build_object(
            'reviewing_to_favorite', case when funnel.reviewing + funnel.favorite > 0 then funnel.favorite / (funnel.reviewing + funnel.favorite) else null end,
            'favorite_to_fieldwork', case when funnel.favorite + funnel.fieldwork > 0 then funnel.fieldwork / (funnel.favorite + funnel.fieldwork) else null end,
            'fieldwork_to_bid_review', case when funnel.fieldwork + funnel.bid_review > 0 then funnel.bid_review / (funnel.fieldwork + funnel.bid_review) else null end
          ),
          'sample_size', summary.sample_size,
          'eligible_for_personalization', summary.eligible_for_personalization
        )::text
          from summary cross join funnel
        """;
    return jdbc.queryForObject(sql, new MapSqlParameterSource(), String.class);
  }

  /** listing id로 식별한 단일 매물 상세(JSON 객체 문자열 또는 null) */
  public String detailByIdJson(long listingId) {
    String sql = "select row_to_json(t)::text from (\n" + SELECT_BODY
        + " where l.id = :listingId) t";
    List<String> rows = jdbc.queryForList(sql, new MapSqlParameterSource("listingId", listingId), String.class);
    return rows.isEmpty() ? null : rows.get(0);
  }

  /** 사건/물건번호 상세. 물건번호 없는 레거시 요청은 단일물건 사건에만 허용한다. */
  public String detailJson(String caseNo, String itemNo) {
    String sql = "select row_to_json(t)::text from (\n" + SELECT_BODY
        + " where l.case_no = :caseNo\n"
        + "   and ((:itemNo is not null and coalesce(nullif(l.item_no, ''), '1') = :itemNo)\n"
        + "     or (:itemNo is null and 1 = (\n"
        + "       select count(distinct coalesce(nullif(sibling.item_no, ''), '1'))\n"
        + "         from gm_listings sibling where sibling.case_no = :caseNo)))\n"
        + " order by l.crawled_at desc nulls last, l.id desc limit 1) t";
    var params = new MapSqlParameterSource()
        .addValue("caseNo", caseNo)
        .addValue("itemNo", itemNo == null || itemNo.isBlank() ? null : itemNo.trim());
    List<String> rows = jdbc.queryForList(sql, params, String.class);
    return rows.isEmpty() ? null : rows.get(0);
  }

  public String detailJson(String caseNo) {
    return detailJson(caseNo, null);
  }

  /** 관심(즐겨찾기) 토글 */
  public int setFavorite(long id, boolean favorite) {
    return jdbc.getJdbcTemplate().update("update gm_listings set is_favorite=? where id=?", favorite, id);
  }

  /** 현장 임장 체크리스트 메모(매물별) — JSON 배열 문자열 */
  public String fieldworkNotesJson(long id) {
    String sql = "select coalesce(json_agg(jsonb_build_object("
        + "'item_key', item_key, 'checked', checked, 'note', note, 'updated_at', updated_at)"
        + " order by item_key), '[]'::json)::text"
        + " from gm_fieldwork_notes where listing_id = :id";
    return jdbc.queryForObject(sql, new MapSqlParameterSource("id", id), String.class);
  }

  /** 체크리스트 항목 1건 upsert (체크 여부 + 메모) */
  public void saveFieldworkNote(long id, String itemKey, boolean checked, String note) {
    String sql = "insert into gm_fieldwork_notes(listing_id, item_key, checked, note, updated_at)"
        + " values(:id, :k, :c, :n, now())"
        + " on conflict (listing_id, item_key)"
        + " do update set checked = excluded.checked, note = excluded.note, updated_at = now()";
    var params = new MapSqlParameterSource()
        .addValue("id", id)
        .addValue("k", itemKey)
        .addValue("c", checked)
        .addValue("n", note == null ? "" : note);
    jdbc.update(sql, params);
  }



  /** 오늘 할 일 큐(JSON 배열 문자열) — DB view가 우선순위와 사유를 산출한다. */
  public String todayActionsJson(int requestedLimit) {
    int limit = Math.max(1, Math.min(50, requestedLimit));
    String sql = """
        select coalesce(json_agg(t order by t.priority desc, t.sort_date asc nulls last, t.case_no, t.item_no), '[]'::json)::text
          from (
            select listing_id, case_no, item_no, action_type, priority, severity,
                   title, reason, due_date::text, sort_date::text, source_url
              from gm_today_actions
             order by priority desc, sort_date asc nulls last, case_no, item_no
             limit :limit
          ) t
        """;
    return jdbc.queryForObject(sql, new MapSqlParameterSource("limit", limit), String.class);
  }

  /** Phase2 복기/ML 대시보드 데이터 — 운영 추천에는 반영하지 않는 read-only 지표. */
  public Map<String, Object> mlReview() {
    String summarySql = """
        with raw as (
          select * from gm_outcome_eval where sale_date < current_date
        ), trusted as (
          select * from gm_trusted_outcome_eval where sale_date < current_date
        ), trust_counts as (
          select t.status, count(*)::int as rows
            from gm_outcome_trust t
            join raw r on r.case_no = t.case_no
             and coalesce(nullif(r.item_no, ''), '1') = t.item_no
             and r.sale_date = t.sale_date
           group by t.status
        )
        select (select count(*)::int from raw) as raw_rows,
               (select count(*)::int from raw) as past_snapshots,
               (select count(*) filter (where matched)::int from raw) as matched,
               (select count(*) filter (where matched and sold)::int from raw) as sold,
               (select count(*) filter (where matched and not sold)::int from raw) as unsold,
               (select case when count(*) > 0 then 1 - count(*) filter (where matched)::float8 / count(*) else 0 end from raw) as miss_rate,
               (select count(*)::int from trusted) as trusted,
               coalesce((select rows from trust_counts where status = 'hold'), 0) as held,
               coalesce((select rows from trust_counts where status = 'quarantined'), 0) as quarantined,
               count(*) filter (where sold and sale_ratio is not null)::int as sale_ratio_labels,
               avg(abs(residual_pct)) filter (where sold and residual_pct is not null) as expected_bid_mape,
               avg(abs(sale_ratio - expected_bid::float8 / nullif(appraisal_value, 0)))
                 filter (where sold and sale_ratio is not null and expected_bid is not null and appraisal_value > 0) as current_expected_mae,
               avg(case when realized_bid_margin > 0 then 1.0 else 0.0 end)
                 filter (where sold and realized_bid_margin is not null) as positive_margin_rate,
               count(*) filter (where sold and would_have_won_under_max_safe_bid is not null)::int as safe_bid_rows,
               avg(case when would_have_won_under_max_safe_bid then 1.0 else 0.0 end)
                 filter (where sold and would_have_won_under_max_safe_bid is not null) as safe_bid_hit_rate
          from trusted
        """;
    Map<String, Object> summary = jdbc.getJdbcTemplate().queryForMap(summarySql);

    String groupsSql = """
        with sold as (
          select property_type,
                 case
                   when split_part(address, ' ', 1) in ('서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시')
                     then split_part(address, ' ', 1) || ' ' || split_part(address, ' ', 2)
                   when split_part(address, ' ', 1) like '%도'
                     then split_part(address, ' ', 1) || ' ' || split_part(address, ' ', 2)
                   else split_part(address, ' ', 1)
                 end as region,
                 sale_ratio, realized_bid_margin
            from gm_trusted_outcome_eval
           where sale_date < current_date and sold and sale_ratio is not null
        )
        select property_type, region, count(*)::int as rows,
               percentile_cont(0.5) within group (order by sale_ratio) as median_sale_ratio,
               percentile_cont(0.5) within group (order by realized_bid_margin) as median_realized_margin
          from sold
         group by property_type, region
        having count(*) >= 5
         order by rows desc, median_sale_ratio desc
         limit 20
        """;
    List<Map<String, Object>> groups = jdbc.getJdbcTemplate().queryForList(groupsSql);

    String coverageSql = """
        with base as (select * from gm_outcome_eval where sale_date < current_date),
        metrics(feature, non_null_rows) as (values
          ('max_safe_bid', (select count(*) from base where max_safe_bid is not null)),
          ('expected_bid', (select count(*) from base where expected_bid is not null)),
          ('inq_cnt', (select count(*) from base where inq_cnt is not null)),
          ('interest_cnt', (select count(*) from base where interest_cnt is not null)),
          ('appraisal_value', (select count(*) from base where appraisal_value is not null)),
          ('market_price', (select count(*) from base where market_price is not null)),
          ('min_bid_price', (select count(*) from base where min_bid_price is not null)),
          ('total_score', (select count(*) from base where total_score is not null)),
          ('true_margin', (select count(*) from base where true_margin is not null))
        ), total as (select greatest(count(*), 1)::float8 as n from base)
        select feature, non_null_rows::int, non_null_rows::float8 / total.n as coverage
          from metrics cross join total
         order by coverage asc, non_null_rows desc
        """;
    List<Map<String, Object>> featureCoverage = jdbc.getJdbcTemplate().queryForList(coverageSql);

    String surpriseSql = """
        with base as (
          select case_no, coalesce(nullif(item_no,''),'1') as item_no, sale_date, property_type, court, address,
                 expected_bid, sold_amount, sale_ratio, residual_pct, total_score, passed_filter,
                 recommendation, true_margin, inq_cnt, interest_cnt, realized_bid_margin, matched, sold
            from gm_trusted_outcome_eval
           where sale_date < current_date
        ), ranked as (
          (select 'overpriced' as surprise_kind, residual_pct as surprise_score, *
             from base
            where sold and residual_pct > 0
            order by residual_pct desc nulls last
            limit 10)
          union all
          (select 'avoid_but_sold' as surprise_kind, coalesce(sale_ratio, 0) as surprise_score, *
             from base
            where sold and (passed_filter = false or recommendation = 'avoid')
            order by coalesce(sale_ratio, 0) desc
            limit 10)
          union all
          (select 'passed_but_unsold' as surprise_kind, coalesce(total_score, 0) as surprise_score, *
             from base
            where matched and not sold and passed_filter = true
            order by coalesce(total_score, 0) desc
            limit 10)
        )
        select surprise_kind, surprise_score, case_no, item_no, sale_date::text, property_type, court, address,
               expected_bid, sold_amount, sale_ratio, residual_pct, total_score, passed_filter,
               recommendation, true_margin, inq_cnt, interest_cnt, realized_bid_margin
          from ranked
         order by case surprise_kind
                    when 'overpriced' then 1
                    when 'avoid_but_sold' then 2
                    else 3
                  end,
                  surprise_score desc nulls last
        """;
    List<Map<String, Object>> surprises = jdbc.getJdbcTemplate().queryForList(surpriseSql);

    String retrySql = """
        select case_no, item_no, sale_date::text, court, property_type, address,
               days_overdue, retry_priority, total_score, passed_filter, recommendation,
               expected_bid, min_bid_price, inq_cnt, interest_cnt
          from gm_result_retry_queue
         order by retry_priority desc, sale_date desc, case_no, item_no
         limit 30
        """;
    List<Map<String, Object>> retryQueue = jdbc.getJdbcTemplate().queryForList(retrySql);

    String calibrationPerformanceSql = """
        with trusted_sold as (
          select property_type,
                 case
                   when split_part(address, ' ', 1) in ('서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시')
                     then split_part(address, ' ', 1) || ' ' || split_part(address, ' ', 2)
                   when split_part(address, ' ', 1) like '%도'
                     then split_part(address, ' ', 1) || ' ' || split_part(address, ' ', 2)
                   else split_part(address, ' ', 1)
                 end as region,
                 sale_ratio, realized_bid_margin
            from gm_trusted_outcome_eval
           where sale_date < current_date and sold and sale_ratio is not null
        ), calibration as (
          select property_type, region,
                 percentile_cont(0.5) within group (order by sale_ratio) as median_sale_ratio
            from trusted_sold
           group by property_type, region
          having count(*) >= 5
        ), scored as (
          select e.case_no, e.item_no, e.property_type, e.address, e.appraisal_value,
                 e.expected_bid, e.sale_ratio, c.median_sale_ratio,
                 abs(e.sale_ratio - c.median_sale_ratio) as reference_abs_error,
                 abs(e.sale_ratio - e.expected_bid::float8 / nullif(e.appraisal_value, 0)) as current_abs_error
            from gm_trusted_outcome_eval e
            join calibration c on c.property_type = e.property_type
             and c.region = case
               when split_part(e.address, ' ', 1) in ('서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시')
                 then split_part(e.address, ' ', 1) || ' ' || split_part(e.address, ' ', 2)
               when split_part(e.address, ' ', 1) like '%도'
                 then split_part(e.address, ' ', 1) || ' ' || split_part(e.address, ' ', 2)
               else split_part(e.address, ' ', 1)
             end
           where e.sale_date < current_date
             and e.sold
             and e.sale_ratio is not null
             and e.appraisal_value > 0
        )
        select count(*)::int as rows,
               avg(reference_abs_error) as reference_mae,
               avg(current_abs_error) filter (where current_abs_error is not null) as current_mae,
               avg(case when reference_abs_error < current_abs_error then 1.0 else 0.0 end)
                 filter (where current_abs_error is not null) as reference_win_rate
          from scored
        """;
    Map<String, Object> calibrationPerformance = jdbc.getJdbcTemplate().queryForMap(calibrationPerformanceSql);

    String rightsRiskSql = """
        select coalesce(r.risk_grade, 'unknown') as risk_grade,
               count(*)::int as rows,
               count(*) filter (where e.matched)::int as matched,
               count(*) filter (where e.sold)::int as sold,
               avg(case when e.sold then 1.0 else 0.0 end) filter (where e.matched) as sold_rate,
               avg(e.realized_bid_margin) filter (where e.sold and e.realized_bid_margin is not null) as median_proxy_margin,
               avg(r.assumed_amount) filter (where r.assumed_amount is not null) as avg_assumed_amount,
               count(*) filter (where r.has_opposition_tenant)::int as opposition_rows,
               avg(case when e.would_have_won_under_max_safe_bid then 1.0 else 0.0 end)
                 filter (where e.would_have_won_under_max_safe_bid is not null) as safe_bid_hit_rate
          from gm_rights_risk_eval r
          join gm_trusted_outcome_eval e
            on e.case_no = r.case_no
           and coalesce(nullif(e.item_no, ''), '1') = r.item_no
           and e.sale_date = r.sale_date
         group by coalesce(r.risk_grade, 'unknown')
         order by rows desc
        """;
    List<Map<String, Object>> rightsRisk = jdbc.getJdbcTemplate().queryForList(rightsRiskSql);

    String reportPath = System.getenv().getOrDefault("ML_REPORT_PATH", "docs/phase2/ml-offline-report.md");
    String markdown = null;
    try {
      Path path = Path.of(reportPath);
      if (Files.exists(path)) markdown = Files.readString(path);
    } catch (Exception ignored) { }

    return Map.of(
        "summary", summary,
        "groupMedian", groups,
        "featureCoverage", featureCoverage,
        "surprises", surprises,
        "retryQueue", retryQueue,
        "calibrationPerformance", calibrationPerformance,
        "rightsRisk", rightsRisk,
        "reportMarkdown", markdown == null ? "" : markdown
    );
  }


  /** 최근 크롤 실행 로그 */
  public List<Map<String, Object>> crawlRuns() {
    return jdbc.getJdbcTemplate().queryForList(
        "select id, source, region, n_found, n_new, status, error, started_at, finished_at"
            + " from gm_crawl_runs order by started_at desc limit 20");
  }
}
