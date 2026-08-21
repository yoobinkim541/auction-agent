package com.gyeongmae.web;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.gyeongmae.service.ListingService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class ListingControllerTest {

  private ListingService service;
  private MockMvc mvc;

  @BeforeEach
  void setUp() {
    service = mock(ListingService.class);
    mvc = MockMvcBuilders.standaloneSetup(new ListingController(service)).build();
  }

  @Test
  void precisionRecommendationsClampLimitToConfiguredRange() throws Exception {
    when(service.precisionRecommendationsJson(3))
        .thenReturn("[{\"id\":11,\"precision\":{\"status\":\"recommended\"},\"current_decision\":null}]");
    when(service.precisionRecommendationsJson(7)).thenReturn("[]");

    mvc.perform(get("/api/recommendations/precision").param("limit", "1"))
        .andExpect(status().isOk())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
        .andExpect(jsonPath("$[0].precision.status").value("recommended"));
    mvc.perform(get("/api/recommendations/precision").param("limit", "99"))
        .andExpect(status().isOk())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON));

    verify(service).precisionRecommendationsJson(3);
    verify(service).precisionRecommendationsJson(7);
  }

  @Test
  void postDecisionCreatesAppendOnlyEvent() throws Exception {
    when(service.recordDecision(42L, "rejected", "price", "상한 초과", 230000000L))
        .thenReturn("{\"id\":9,\"listing_id\":42,\"decision\":\"rejected\",\"reason_code\":\"price\"}");

    mvc.perform(post("/api/listings/42/decisions")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"decision\":\"rejected\",\"reasonCode\":\"price\",\"note\":\"상한 초과\",\"targetBid\":230000000}"))
        .andExpect(status().isCreated())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
        .andExpect(jsonPath("$.listing_id").value(42))
        .andExpect(jsonPath("$.reason_code").value("price"));

    verify(service).recordDecision(42L, "rejected", "price", "상한 초과", 230000000L);
  }

  @Test
  void postDecisionRejectsMissingDecision() throws Exception {
    mvc.perform(post("/api/listings/42/decisions")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"reasonCode\":\"price\"}"))
        .andExpect(status().isBadRequest())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON));

    verifyNoInteractions(service);
  }

  @Test
  void postDecisionRejectsUnknownDecision() throws Exception {
    mvc.perform(post("/api/listings/42/decisions")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"decision\":\"archive\"}"))
        .andExpect(status().isBadRequest())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON));

    verifyNoInteractions(service);
  }

  @Test
  void postDecisionRejectsUnknownReasonCode() throws Exception {
    mvc.perform(post("/api/listings/42/decisions")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"decision\":\"rejected\",\"reasonCode\":\"unknown\"}"))
        .andExpect(status().isBadRequest())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON));
  }

  @Test
  void postDecisionRequiresReasonForHoldAndRejected() throws Exception {
    mvc.perform(post("/api/listings/42/decisions")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"decision\":\"hold\"}"))
        .andExpect(status().isBadRequest())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON));
  }

  @Test
  void postDecisionReturnsNotFoundWhenListingDoesNotExist() throws Exception {
    when(service.recordDecision(404L, "reviewing", null, "", null)).thenReturn(null);

    mvc.perform(post("/api/listings/404/decisions")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"decision\":\"reviewing\"}"))
        .andExpect(status().isNotFound());
  }

  @Test
  void decisionHistoryReturnsNotFoundForMissingListing() throws Exception {
    when(service.decisionHistoryJson(404L)).thenReturn(null);

    mvc.perform(get("/api/listings/404/decisions"))
        .andExpect(status().isNotFound());
  }

  @Test
  void decisionReviewReturnsReportOnlySummary() throws Exception {
    when(service.decisionReviewJson()).thenReturn("{\"decision_counts\":{\"favorite\":2},\"reason_distribution\":{\"price\":1},\"funnel_conversion\":{\"reviewing_to_favorite\":0.5},\"sample_size\":2,\"eligible_for_personalization\":false}");

    mvc.perform(get("/api/review/decisions"))
        .andExpect(status().isOk())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
        .andExpect(jsonPath("$.sample_size").value(2))
        .andExpect(jsonPath("$.eligible_for_personalization").value(false));
  }
}
