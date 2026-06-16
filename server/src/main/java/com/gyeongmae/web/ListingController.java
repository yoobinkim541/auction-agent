package com.gyeongmae.web;

import com.gyeongmae.service.ListingService;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class ListingController {

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

  /** 매물 상세 (사건번호) */
  @GetMapping(value = "/listings/{caseNo}", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<String> detail(@PathVariable String caseNo) {
    String json = service.detailJson(caseNo);
    return json == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(json);
  }

  /** 관심 토글: POST /api/listings/{id}/favorite?value=true */
  @PostMapping("/listings/{id}/favorite")
  public ResponseEntity<Map<String, Object>> favorite(
      @PathVariable long id, @RequestParam(defaultValue = "true") boolean value) {
    int n = service.setFavorite(id, value);
    return n > 0 ? ResponseEntity.ok(Map.of("id", id, "favorite", value))
                 : ResponseEntity.notFound().build();
  }

  @GetMapping("/crawl-runs")
  public List<Map<String, Object>> crawlRuns() {
    return service.crawlRuns();
  }
}
