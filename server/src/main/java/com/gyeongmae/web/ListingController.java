package com.gyeongmae.web;

import com.gyeongmae.service.ListingService;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class ListingController {

  private static final Set<String> DECISIONS = Set.of(
      "reviewing", "favorite", "hold", "fieldwork", "bid_review", "rejected");
  private static final Set<String> REASON_CODES = Set.of(
      "price", "rights", "location", "field", "capital", "schedule", "preference", "data_missing");

  private final ListingService service;

  public ListingController(ListingService service) {
    this.service = service;
  }

  @GetMapping("/health")
  public Map<String, Object> health() {
    return Map.of("ok", true, "service", "gyeongmae-server");
  }

  /** 매물 목록. ?passedOnly=true&type=apartment&q=서울 */
  @GetMapping(value = "/listings", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<String> listings(
      @RequestParam(defaultValue = "false") boolean passedOnly,
      @RequestParam(defaultValue = "all") String type,
      @RequestParam(defaultValue = "") String q) {
    return ResponseEntity.ok(service.listSlimJson(passedOnly, type, q));
  }

  @GetMapping(value = "/recommendations/precision", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<String> precisionRecommendations(@RequestParam(defaultValue = "5") int limit) {
    return ResponseEntity.ok(service.precisionRecommendationsJson(clampPrecisionLimit(limit)));
  }

  /** 매물 상세 (사건번호) */
  @GetMapping(value = "/listings/{caseNo}", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<String> detail(@PathVariable String caseNo) {
    String json = service.detailJson(caseNo);
    return json == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(json);
  }

  @GetMapping(value = "/listings/{id}/decisions", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<String> decisionHistory(@PathVariable long id) {
    String json = service.decisionHistoryJson(id);
    return json == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(json);
  }

  @PostMapping(value = "/listings/{id}/decisions", consumes = MediaType.APPLICATION_JSON_VALUE,
      produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<?> recordDecision(@PathVariable long id, @RequestBody Map<String, Object> body) {
    String decision = stringValue(body.get("decision"));
    String reasonCode = stringValue(body.get("reasonCode"));
    if (decision == null || !DECISIONS.contains(decision)) {
      return ResponseEntity.badRequest().body(Map.of("error", "valid decision required"));
    }
    if (reasonCode != null && !REASON_CODES.contains(reasonCode)) {
      return ResponseEntity.badRequest().body(Map.of("error", "valid reasonCode required"));
    }
    if ((decision.equals("hold") || decision.equals("rejected")) && reasonCode == null) {
      return ResponseEntity.badRequest().body(Map.of("error", "reasonCode required for hold or rejected"));
    }

    Long targetBid;
    try {
      targetBid = longValue(body.get("targetBid"));
    } catch (NumberFormatException e) {
      return ResponseEntity.badRequest().body(Map.of("error", "targetBid must be an integer"));
    }
    String note = stringValue(body.get("note"));
    String json = service.recordDecision(id, decision, reasonCode, note == null ? "" : note, targetBid);
    return json == null ? ResponseEntity.notFound().build() : ResponseEntity.status(201).body(json);
  }

  @GetMapping(value = "/review/decisions", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<String> decisionReview() {
    return ResponseEntity.ok(service.decisionReviewJson());
  }


  /** 캐시된 매물 사진. active 메타 + 실제 파일이 모두 있어야 노출한다. */
  @GetMapping("/listings/{id}/photos/{filename:.+}")
  public ResponseEntity<Resource> photo(@PathVariable long id, @PathVariable String filename) throws IOException {
    Path path = service.photoPath(id, filename);
    if (path == null) return ResponseEntity.notFound().build();
    String contentType = Files.probeContentType(path);
    MediaType mediaType = contentType == null ? MediaType.APPLICATION_OCTET_STREAM : MediaType.parseMediaType(contentType);
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .contentType(mediaType)
        .body(new FileSystemResource(path));
  }

  /** 관심 토글: POST /api/listings/{id}/favorite?value=true */
  @PostMapping("/listings/{id}/favorite")
  public ResponseEntity<Map<String, Object>> favorite(
      @PathVariable long id, @RequestParam(defaultValue = "true") boolean value) {
    int n = service.setFavorite(id, value);
    return n > 0 ? ResponseEntity.ok(Map.of("id", id, "favorite", value))
                 : ResponseEntity.notFound().build();
  }

  /** 현장 임장 체크리스트 메모 조회: GET /api/listings/{id}/fieldwork */
  @GetMapping(value = "/listings/{id}/fieldwork", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<String> fieldwork(@PathVariable long id) {
    return ResponseEntity.ok(service.fieldworkNotesJson(id));
  }

  /** 체크리스트 항목 저장(upsert): PUT /api/listings/{id}/fieldwork  body {itemKey, checked, note} */
  @PutMapping("/listings/{id}/fieldwork")
  public ResponseEntity<Map<String, Object>> saveFieldwork(
      @PathVariable long id, @RequestBody Map<String, Object> body) {
    Object key = body.get("itemKey");
    if (key == null || key.toString().isBlank()) {
      return ResponseEntity.badRequest().body(Map.of("error", "itemKey required"));
    }
    boolean checked = Boolean.TRUE.equals(body.get("checked"));
    Object noteObj = body.get("note");
    String note = noteObj == null ? "" : noteObj.toString();
    service.saveFieldworkNote(id, key.toString(), checked, note);
    return ResponseEntity.ok(Map.of("ok", true));
  }

  @GetMapping("/crawl-runs")
  public List<Map<String, Object>> crawlRuns() {
    return service.crawlRuns();
  }

  /** 오늘 할 일 큐: 재수집·권리보강·입찰임박·현장확인·복기 액션 */
  @GetMapping(value = "/actions/today", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<String> todayActions(@RequestParam(defaultValue = "20") int limit) {
    return ResponseEntity.ok(service.todayActionsJson(limit));
  }

  /** Phase2 복기/ML 대시보드 데이터 */
  @GetMapping("/review/ml")
  public Map<String, Object> mlReview() {
    return service.mlReview();
  }

  private static int clampPrecisionLimit(int limit) {
    return Math.max(3, Math.min(7, limit));
  }

  private static String stringValue(Object value) {
    if (value == null) return null;
    String result = value.toString().trim();
    return result.isEmpty() ? null : result;
  }

  private static Long longValue(Object value) {
    if (value == null) return null;
    if (value instanceof Number number) return number.longValue();
    return Long.valueOf(value.toString());
  }
}
