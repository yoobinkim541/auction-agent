package com.gyeongmae.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

class ListingServiceIntegrationTest {

  private static final long ITEM_ONE_ID = 9_100_001L;
  private static final long ITEM_TWO_ID = 9_100_002L;
  private static final String CASE_NO = "2099타경9100";
  private static final ObjectMapper JSON = new ObjectMapper();
  private static Connection connection;
  private static ListingService service;

  @BeforeAll
  static void setUpDatabase() throws Exception {
    assumeTrue("1".equals(System.getenv("RUN_PRECISION_DB_TESTS")));
    String jdbcUrl = System.getenv().getOrDefault(
        "DB_JDBC_URL", "jdbc:postgresql://127.0.0.1:5432/gyeongmae");
    String user = System.getenv().getOrDefault("DB_USER", "gm_app");
    String password = System.getenv("DB_PASSWORD");
    assumeTrue(password != null && !password.isBlank());

    connection = DriverManager.getConnection(jdbcUrl, user, password);
    try (Statement statement = connection.createStatement()) {
      for (String table : new String[] {
          "gm_listings", "gm_rights_analysis", "gm_location_analysis", "gm_scores",
          "gm_precision_evaluations", "gm_ml_price_calibration", "gm_listing_docs",
          "gm_decision_events", "gm_listing_photos"
      }) {
        statement.execute("create temporary table " + table
            + " as select * from public." + table + " with no data");
      }
      statement.execute("""
          insert into gm_listings (
            id, case_no, item_no, court, address, property_type, appraisal_value,
            min_bid_price, fail_count, sale_date, area_m2, source, source_url,
            is_favorite, inq_cnt, interest_cnt, crawled_at
          ) values
            (9100001, '2099타경9100', '1', '테스트법원', '물건 1', 'apartment', 300000000,
             180000000, 1, '2099-09-01', 59.0, 'courtauction', null, false, 0, 0, now()),
            (9100002, '2099타경9100', '2', '테스트법원', '물건 2', 'apartment', 500000000,
             250000000, 2, '2099-09-02', 84.0, 'courtauction', null, false, 0, 0, now())
          """);
      statement.execute("""
          insert into gm_precision_evaluations (
            listing_id, status, confidence, conservative_value, recommended_bid, hard_cap_bid,
            reason_codes, strengths, risks, required_checks, evaluator_version, input_hash, evaluated_at
          ) values (
            9100002, 'hold', 'low', 450000000, null, 300000000,
            '["STALE_RIGHTS_ANALYSIS"]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
            'precision-v1', 'fixture', now()
          )
          """);
      statement.execute("""
          insert into gm_decision_events (
            id, listing_id, decision, reason_code, note, target_bid, precision_snapshot, created_at
          ) values
            (1, 9100001, 'reviewing', null, 'item one', null, '{}'::jsonb, now()),
            (2, 9100002, 'hold', 'data_missing', 'item two', null, '{}'::jsonb, now())
          """);
    }
    service = new ListingService(new SingleConnectionDataSource(connection, true));
  }

  @AfterAll
  static void closeDatabase() throws Exception {
    if (connection != null) connection.close();
  }

  @Test
  void multiItemDetailRequiresItemIdentityAndReturnsThatItemsPrecision() throws Exception {
    assertNull(service.detailJson(CASE_NO));

    JsonNode byItem = JSON.readTree(service.detailJson(CASE_NO, "2"));
    assertEquals(ITEM_TWO_ID, byItem.path("id").asLong());
    assertEquals("2", byItem.path("item_no").asText());
    assertEquals("hold", byItem.path("precision").path("status").asText());

    JsonNode byId = JSON.readTree(service.detailByIdJson(ITEM_TWO_ID));
    assertEquals(ITEM_TWO_ID, byId.path("id").asLong());
    assertEquals("2", byId.path("item_no").asText());
  }

  @Test
  void decisionsAndPhotosRemainScopedToTheSelectedListingId(@TempDir Path tempDir) throws Exception {
    JsonNode decisions = JSON.readTree(service.decisionHistoryJson(ITEM_TWO_ID));
    assertEquals(1, decisions.size());
    assertEquals(ITEM_TWO_ID, decisions.get(0).path("listing_id").asLong());
    assertEquals("item two", decisions.get(0).path("note").asText());

    String itemOneName = "1".repeat(64) + ".jpg";
    String itemTwoName = "2".repeat(64) + ".jpg";
    Path itemOnePhoto = Files.writeString(tempDir.resolve(itemOneName), "one");
    Path itemTwoPhoto = Files.writeString(tempDir.resolve(itemTwoName), "two");
    try (Statement statement = connection.createStatement()) {
      statement.execute("""
          insert into gm_listing_photos (
            id, listing_id, case_no, item_no, source, source_url, cache_path,
            public_url, content_hash, status, captured_at
          ) values
            (1, 9100001, '2099타경9100', '1', 'courtauction', 'fixture-one', '%s',
             '/api/listings/9100001/photos/%s', '%s', 'active', now()),
            (2, 9100002, '2099타경9100', '2', 'courtauction', 'fixture-two', '%s',
             '/api/listings/9100002/photos/%s', '%s', 'active', now())
          """.formatted(
              itemOnePhoto.toString().replace("'", "''"), itemOneName, "1".repeat(64),
              itemTwoPhoto.toString().replace("'", "''"), itemTwoName, "2".repeat(64)));
    }

    assertNull(service.photoPath(ITEM_TWO_ID, itemOneName));
    assertEquals(itemTwoPhoto, service.photoPath(ITEM_TWO_ID, itemTwoName));
    assertTrue(Files.isRegularFile(service.photoPath(ITEM_TWO_ID, itemTwoName)));
  }
}
