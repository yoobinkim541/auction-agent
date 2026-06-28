# 결과 피드백 학습 루프 — Phase 2+ 상세 계획

> 전제: Phase 0+1(예측 스냅샷 `gm_prediction_snapshots` + 낙찰결과 `gm_auction_results`)은 **라이브**
> (매일 06:00 KST `deploy/daily-parse.sh`). 이 문서는 데이터가 쌓인 뒤의 분석·학습 단계.
> 성격: 진짜 RL 아님 → **결과 피드백 보정 루프**(예측→실제→오차분석→기준보정). RL 정신은 Phase 5 밴딧.

## 0. 핵심 원칙 (착오 방지)
- **학습은 "스냅샷 이후 매각"만 사용.** 예측 스냅샷이 지금부터 쌓이므로 과거 완료분은 비교 대상 없음 → 루프 무관.
- **누수 차단**: 스냅샷은 매각 전 동결(point-in-time). 모델 평가는 항상 시간 분할(train < T < eval).
- **안전 불변**: 학습은 *소프트 선호도(안전마진·경쟁·입지 가중)* 만 건드림. 권리 하드룰(인수금액>0·대항력·danger 플래그)은 결정형 유지, 모델이 절대 못 덮음.
- **시세 노이즈 회피**: 우리 시세는 추정(오차 큼). 가격 학습 타깃은 **감정가 기반 낙찰가율(sold/appraisal)** — 감정가는 관측값.

## 1. 라벨링된 데이터셋 (조인)
키: `(case_no, item_no, sale_date)`.
- 예측 = `gm_prediction_snapshots` 행.
- 실제 = `gm_auction_results`에서 `dxdy_date == sale_date && kind_cd='01'(매각기일)`.
  - **변경/연기 처리**: 그 기일이 변경되면 다음 기일로 추적. 매칭 모호건은 Phase 2a가 수치화.
- 파생: `residual = sold_amount − expected_bid`, `residual_pct`, `낙찰가율 = sold_amount/appraisal_value`, `통과여부↔낙찰여부`.
- 산출물: `gm_outcome_eval` (뷰 또는 야간 갱신 matview) — snapshot ⋈ result ⋈ listing(appraisal).

## 2. Phase 2 — 보정·서프라이즈 복기 (ML 없음, 즉시 가치)
게이트: 매칭된 결과 **≥ 40~50건** (그 전엔 노이즈).

### 2a. 매칭·커버리지 감사 ⇐ 연기항목의 트리거
- 지난 매각기일 스냅샷 중 **결과 매칭률** = matched / (snapshots with past sale_date).
- **이 수치가 낮으면(매각결과를 자주 놓침) → 그때 비로소 '매각결과 전용검색'+응찰자수 캡처를 구현**(데이터 기반 결정. 무작정 미리 안 만든 이유).
- 변경/취하/정지 비율도 집계(선택편향 파악).

### 2b. 보정 리포트 (`npm run eval:calibrate` → stdout + 대시보드 탭)
- **가격**: expected_bid vs sold_amount — 편향(평균잔차)·MAE/MAPE, 종류/지역/회차별. 낙찰가율 분포.
- **품질**: total_score/passed/recommendation이 (i)낙찰여부 (ii)낙찰가율 (iii)실현마진을 예측하나 — AUC(passed→sold), corr(score, 낙찰가율).

### 2c. 서프라이즈 = 사용자의 두 질문 (복기 탭 + 다이제스트 섹션)
- **"예상보다 비싸게 팔림"**: residual_pct 상위 → "예상 X억→실제 Y억(+Z%)" + 매물 특성.
- **"안좋다고 본 게 팔림"**: (passed=false ∨ reco=avoid ∨ 저점수) ∧ sold ∧ 높은 낙찰가율.
- (역) 추천했는데 유찰: passed/고점수 ∧ ¬sold → 과대평가.
- 산출물: `gm_outcome_eval` 뷰, `eval:calibrate` 스크립트, web "복기" 탭, 다이제스트 복기 섹션(기존 인프라 재사용).

## 3. Phase 3 — LLM 복기 (정성적 기준 발굴)
- 각 서프라이즈에 Claude **구독 CLI**(memo 인프라·throttle/캐시 재사용)로 "왜 이 결과?" 추론.
- 구조화 출력: 태그(재건축·학군·역세권·신축·대단지·전세가율·실거주수요·특수권리감수·급매…) + 1~2문장 근거.
- 서프라이즈 전반의 **태그 집계 → 추가할 기준 후보 랭킹**. 사람(사용자)이 검수 → 엔진에 인코딩(예: 전세가율 피처, 재건축 키워드, 학군 POI 가중).
- 신규: `pipeline/report/postmortem.ts`, `gm_postmortems`, `scripts/eval-postmortem.ts`. 게이트: 확정 서프라이즈만(건수 제한).

## 4. Phase 4 — 모델 보정 (정량)
게이트: 모델당 매칭결과 **≥ 150~300건**. 시간분할 백테스트 통과 시만 반영.

### 4a. 낙찰가율 모델 (가격) — 최우선
- 타깃 = 낙찰가율(sold/appraisal). 피처 = 종류·지역·회차·면적대·시세대비·경쟁(관심수).
- 단순부터: (종류×지역×회차) **그룹 중앙값** → 룰기반 매각가율 대체. 표본 늘면 GBM 회귀(Python sklearn cron 또는 TS).
- 효과: expected_bid 개선 → 마진·점수 전체 개선. `pipeline/eval/` 백테스트로 MAPE 비교 후 채택.

### 4b. 점수 가중치 재보정 (품질)
- P(sold & 수익) 또는 낙찰가율을 우리 서브점수로 회귀 → **데이터 기반 가중치**(현 `DEFAULT_SCORE_CONFIG` 대체 후보).
- 가드레일: 권리 하드룰 불변·오버라이드. 소프트(안전/경쟁/입지)만 재가중. 현행과 A/B 백테스트.

## 5. Phase 5 — (선택) 정책/컨텍스트 밴딧 = 정직한 "강화학습"
- 행동 = (추천 여부, 권장 max bid). 보상 = 실현마진, **off-policy 추정**: 우리 max_safe_bid ≥ 실제낙찰가면 그 가격에 낙찰 가정 → 마진 = 시세−낙찰가−비용; 아니면 미낙찰(보상 0).
- 입찰 공격성/임계값을 백테스트 기대마진 최대화로 튠. 실제 입찰 불필요(off-policy 평가). Phase 2~4 성숙 후.

## 6. 시퀀싱·트리거·지표
- 지금~4주: 축적. 주 1회 매칭건수 체크.
- **Phase 2 시작**: 매칭결과 ≥ ~40~50. → 2a 감사가 응찰자수/과거매각 캡처 필요 여부 결정.
- Phase 3: 서프라이즈 누적되며 상시.
- Phase 4: 매칭결과 ≥ ~150~300/모델.
- Phase 5: 이후 선택.
- **북극성 지표**: "우리 추천대로 했으면 실현마진 +였나?"(백테스트 P&L). 보조: 매칭률, 가격 MAPE/편향, AUC(passed→sold), 추천셋 낙찰가율.

## 7. 재사용 자산
`pipeline/eval/`(백테스트), 다이제스트(복기 섹션), 대시보드(복기 탭), memo 인프라(복기 LLM·throttle/캐시),
`gm_scores`/`DEFAULT_SCORE_CONFIG`(재가중 타깃), 경쟁신호(inq/interest). 연기항목(응찰자수·과거매각)은 **2a 감사 결과로 착수 결정**.
