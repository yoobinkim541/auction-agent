package com.gyeongmae.service;

import javax.sql.DataSource;
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
             (to_jsonb(r)   - 'id' - 'listing_id') as rights,
             (to_jsonb(loc) - 'id' - 'listing_id') as location,
             s.total_score, s.passed_filter, s.safety_margin_score, s.clean_rights_score, s.reason
      from gm_listings l
      left join gm_rights_analysis   r   on r.listing_id   = l.id
      left join gm_location_analysis loc on loc.listing_id = l.id
      left join gm_scores            s   on s.listing_id   = l.id
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

  /** 단일 매물 상세(JSON 객체 문자열 또는 null) */
  public String detailJson(String caseNo) {
    String sql = "select row_to_json(t)::text from (\n" + SELECT_BODY
        + " where l.case_no = :caseNo limit 1) t";
    List<String> rows = jdbc.queryForList(sql, new MapSqlParameterSource("caseNo", caseNo), String.class);
    return rows.isEmpty() ? null : rows.get(0);
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

  /** 최근 크롤 실행 로그 */
  public List<Map<String, Object>> crawlRuns() {
    return jdbc.getJdbcTemplate().queryForList(
        "select id, source, region, n_found, n_new, status, error, started_at, finished_at"
            + " from gm_crawl_runs order by started_at desc limit 20");
  }
}
