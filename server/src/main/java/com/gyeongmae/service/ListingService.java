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
      select l.id, l.case_no, l.court, l.address, l.property_type,
             l.appraisal_value, l.min_bid_price, l.fail_count, l.sale_date, l.area_m2, l.source,
             l.is_favorite,
             (to_jsonb(r)   - 'id' - 'listing_id') as rights,
             (to_jsonb(loc) - 'id' - 'listing_id') as location,
             s.total_score, s.passed_filter, s.safety_margin_score, s.clean_rights_score, s.reason
      from gm_listings l
      left join gm_rights_analysis   r   on r.listing_id   = l.id
      left join gm_location_analysis loc on loc.listing_id = l.id
      left join gm_scores            s   on s.listing_id   = l.id
      """;

  /** 매물 목록(JSON 배열 문자열) */
  public String listJson(boolean passedOnly, String type, String q) {
    String sql = "select coalesce(json_agg(t order by t.total_score desc nulls last), '[]'::json)::text from (\n"
        + SELECT_BODY
        + " where (:passedOnly = false or s.passed_filter = true)\n"
        + "   and (:type = 'all' or l.property_type = :type)\n"
        + "   and (:q = '' or l.address ilike '%'||:q||'%' or l.case_no ilike '%'||:q||'%')\n"
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

  /** 최근 크롤 실행 로그 */
  public List<Map<String, Object>> crawlRuns() {
    return jdbc.getJdbcTemplate().queryForList(
        "select id, source, region, n_found, n_new, status, error, started_at, finished_at"
            + " from gm_crawl_runs order by started_at desc limit 20");
  }
}
