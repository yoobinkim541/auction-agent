# Precision-First Auction Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 검증 가능한 소수 후보만 추천하고 사용자 결정을 학습 가능한 이벤트로 축적하는 정밀도 우선 경매 에이전트와 결정 인박스를 구축한다.

**Architecture:** 결정형 데이터 신뢰성 평가와 권리 하드 게이트가 먼저 후보 자격을 제한하고, 보수적 가격 평가가 추천·조건부·보류·제외 상태와 입찰 상한을 산출한다. PostgreSQL은 평가·결정 이벤트의 원천이며 Spring API가 정밀 후보와 결정 저널을 제공하고 React 대시보드는 전체 목록보다 결정 인박스를 우선한다.

**Tech Stack:** Node.js 22, TypeScript 6, Vitest 4, PostgreSQL 16/pgvector, Spring Boot 3.3/Java 17/JdbcTemplate, React 19, Vite 8.

**Spec:** `docs/superpowers/specs/2026-08-21-precision-first-auction-agent-design.md`

## Global Constraints

- 최종 추천은 기본 주 5건이며 설정 가능한 범위는 3~7건이다.
- 핵심 데이터가 없거나 충돌하면 `recommended`가 아니라 `hold` 또는 `quarantined`다.
- 인수금액, 대항력, 특수권리 등 권리 하드룰을 ML이나 사용자 선호가 변경하지 못한다.
- 결과 이상치는 삭제하지 않고 격리 사유와 함께 보존하며 학습·보정 통계에서 제외한다.
- 사진 파일은 매각·취하 후 삭제하되 해시·시각·삭제 사유 메타데이터는 보존한다.
- 기존 `/api/listings`, `gm_scores`, 배치, 텔레그램, 사진 수명주기와 하위 호환을 유지한다.
- 코드 변경은 TDD로 진행하며 각 작업의 관련 테스트와 타입체크를 통과한 뒤 한국어 커밋으로 푸시한다.
- 런타임이 만든 `artifacts/listing-photos` 변경은 어떤 커밋에도 포함하지 않는다.

---

## File Map

- `shared/data-trust.ts`: 매물 원천·권리·입지의 신뢰성 판정 순수 모듈.
- `shared/outcome-trust.ts`: 낙찰결과 매칭·금액 이상치 판정 순수 모듈.
- `shared/data-trust.test.ts`, `shared/outcome-trust.test.ts`: 경계값과 불확실성 불변조건.
- `db/migrate_precision_data_trust.sql`: 신뢰성·결과격리 테이블과 신뢰 결과 뷰.
- `db/migrate_precision_recommendations.sql`: 정밀 추천 평가와 후보 뷰.
- `db/migrate_decision_journal.sql`: 사용자 결정 이벤트와 현재 상태 뷰.
- `db/schema.sql`: 신규 설치용 정본 스키마.
- `shared/db.ts`: 평가·결정 이벤트 저장 함수.
- `pipeline/precision/evaluate.ts`: 추천 상태와 보수적 가격·입찰가 산출.
- `pipeline/precision/evaluate.test.ts`: 하드 게이트, 가격 충돌, 후보 상태 테스트.
- `pipeline/run.ts`: 분석 완료 후 신뢰성과 정밀 평가 저장.
- `scripts/backfill-data-trust.ts`: 기존 매물과 결과 신뢰성 백필.
- `scripts/backfill-precision.ts`: 기존 분석 결과 정밀 평가 백필.
- `scripts/precision-audit.ts`: 추천 수·누락·격리·중복 SQL 불변조건 감사.
- `scripts/precision-audit.test.ts`: 감사 판정과 종료코드 순수 로직.
- `scripts/trusted-outcome-sources.test.ts`: 학습·보정 쿼리가 신뢰 결과 뷰를 사용하는지 회귀 검사.
- `server/src/main/java/com/gyeongmae/service/ListingService.java`: 정밀 후보·결정 저널 쿼리.
- `server/src/main/java/com/gyeongmae/web/ListingController.java`: 추천·결정 API.
- `server/src/test/java/com/gyeongmae/web/ListingControllerTest.java`: 요청 검증과 응답 계약.
- `web/src/api.ts`: 정밀 추천·결정 API 타입과 클라이언트.
- `web/src/precision.ts`: 추천 상태 문구와 표시 모델 순수 함수.
- `web/src/precision.test.ts`: 사용자 오해를 막는 상태·근거 문구 테스트.
- `web/src/PrecisionInbox.tsx`: 3~7건 결정 인박스.
- `web/src/PrecisionVerdict.tsx`: 추천 근거·탈락 가능성·입찰가 표시.
- `web/src/DecisionActions.tsx`: 검토·관심·보류·임장·입찰·제외 기록 UI.
- `web/src/Detail.tsx`: 정밀 판정과 결정 액션을 상세 상단에 연결.
- `web/src/App.tsx`: 정밀 인박스를 기본 동선으로 연결.
- `web/src/styles.css`: 결정 인박스와 모바일 상태 스타일.
- `docs/precision-first-operations.md`: 백필, 감사, 플래그, 롤백 운영 절차.

---

### Task 1: Listing Data Trust Evaluator

**Files:**
- Create: `shared/data-trust.ts`
- Create: `shared/data-trust.test.ts`

**Interfaces:**
- Consumes: 분석 파이프라인이 보유한 매물, 권리, 입지, 문서 요약.
- Produces: `evaluateListingTrust(input: ListingTrustInput, now?: Date): ListingTrustResult`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { evaluateListingTrust, type ListingTrustInput } from './data-trust.ts';

const complete = (over: Partial<ListingTrustInput> = {}): ListingTrustInput => ({
  caseNo: '2026타경1', itemNo: '1', appraisalValue: 300_000_000,
  minBidPrice: 210_000_000, crawledAt: '2026-08-21T00:00:00Z',
  rightsAnalyzed: true, registryCount: 2, tenantCount: 0,
  moneyParseWarnings: 0, documentItemMismatch: false,
  locationAnalyzed: true, marketPrice: 350_000_000,
  expectedBidPrice: 230_000_000, comparableCount: 3,
  analysisAt: '2026-08-21T00:00:00Z',
  ...over,
});

describe('evaluateListingTrust', () => {
  it('marks complete evidence trusted', () => {
    expect(evaluateListingTrust(complete(), new Date('2026-08-21T12:00:00Z')).status).toBe('trusted');
  });
  it('holds missing market evidence', () => {
    const result = evaluateListingTrust(complete({ marketPrice: null, comparableCount: 0 }));
    expect(result.status).toBe('hold');
    expect(result.reasonCodes).toContain('MISSING_MARKET_PRICE');
  });
  it('quarantines item mismatch and money warnings', () => {
    const result = evaluateListingTrust(complete({ documentItemMismatch: true, moneyParseWarnings: 1 }));
    expect(result.status).toBe('quarantined');
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['ITEM_MISMATCH', 'MONEY_PARSE_WARNING']));
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run shared/data-trust.test.ts`

Expected: FAIL because `shared/data-trust.ts` does not exist.

- [ ] **Step 3: Implement the evaluator**

```ts
export type DataTrustStatus = 'trusted' | 'hold' | 'quarantined';
export type DataTrustReasonCode =
  | 'MISSING_RIGHTS' | 'EMPTY_REGISTRY' | 'MISSING_LOCATION'
  | 'MISSING_MARKET_PRICE' | 'MISSING_EXPECTED_BID' | 'INSUFFICIENT_COMPS'
  | 'ITEM_MISMATCH' | 'MONEY_PARSE_WARNING' | 'STALE_ANALYSIS';

export interface ListingTrustInput {
  caseNo: string; itemNo: string; appraisalValue: number | null; minBidPrice: number | null;
  crawledAt: string; rightsAnalyzed: boolean; registryCount: number; tenantCount: number;
  moneyParseWarnings: number; documentItemMismatch: boolean; locationAnalyzed: boolean;
  marketPrice: number | null; expectedBidPrice: number | null; comparableCount: number;
  analysisAt: string | null;
}

export interface ListingTrustResult {
  status: DataTrustStatus; score: number; reasonCodes: DataTrustReasonCode[];
  checks: Record<string, boolean>; evaluatorVersion: 'listing-trust-v1';
}
```

Implement a deterministic severity order: any `ITEM_MISMATCH` or `MONEY_PARSE_WARNING` is `quarantined`; missing or stale evidence is `hold`; only zero reasons is `trusted`. Deduct fixed points per failed check and clamp score to 0..100.

- [ ] **Step 4: Run focused and root validation**

Run: `npx vitest run shared/data-trust.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit and push**

```bash
git add shared/data-trust.ts shared/data-trust.test.ts
git commit -m "add) 매물 데이터 신뢰성 판정기 추가"
git push origin codex/courtauction-photo-lifecycle
```

---

### Task 2: Outcome Trust Evaluator

**Files:**
- Create: `shared/outcome-trust.ts`
- Create: `shared/outcome-trust.test.ts`

**Interfaces:**
- Consumes: 사건·물건·매각일·감정가·낙찰가와 결과 중복·일괄매각 신호.
- Produces: `evaluateOutcomeTrust(input: OutcomeTrustInput): OutcomeTrustResult`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { evaluateOutcomeTrust } from './outcome-trust.ts';

describe('evaluateOutcomeTrust', () => {
  it('trusts a plausible matched sale', () => {
    expect(evaluateOutcomeTrust({ appraisalValue: 300_000_000, soldAmount: 240_000_000,
      duplicateResultCount: 1, saleDateMatches: true, batchSaleSuspected: false }).status).toBe('trusted');
  });
  it('quarantines extreme sale ratios', () => {
    const result = evaluateOutcomeTrust({ appraisalValue: 495_900_000, soldAmount: 23_000_000_000,
      duplicateResultCount: 1, saleDateMatches: true, batchSaleSuspected: false });
    expect(result.status).toBe('quarantined');
    expect(result.reasonCodes).toContain('EXTREME_SALE_RATIO');
  });
  it('quarantines suspected aggregate results', () => {
    expect(evaluateOutcomeTrust({ appraisalValue: 216_000_000, soldAmount: 1_076_670_010,
      duplicateResultCount: 1, saleDateMatches: true, batchSaleSuspected: true }).reasonCodes)
      .toContain('BATCH_SALE_SUSPECTED');
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run shared/outcome-trust.test.ts`

Expected: FAIL because `shared/outcome-trust.ts` does not exist.

- [ ] **Step 3: Implement the evaluator**

Define `OutcomeTrustStatus = 'trusted' | 'hold' | 'quarantined'`. Quarantine sale ratios below `0.2` or above `1.5`, duplicate rows above one, sale-date mismatch, and batch-sale suspicion. Hold missing appraisal or sold amount. Return ratio, reason codes, checks, and `outcome-trust-v1`.

- [ ] **Step 4: Validate boundaries**

Run: `npx vitest run shared/outcome-trust.test.ts shared/data-trust.test.ts`

Expected: PASS including ratios exactly 0.2 and 1.5.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit and push**

```bash
git add shared/outcome-trust.ts shared/outcome-trust.test.ts
git commit -m "add) 낙찰결과 이상치 격리 판정기 추가"
git push origin codex/courtauction-photo-lifecycle
```

---

### Task 3: Trust Persistence and Backfill

**Files:**
- Create: `db/migrate_precision_data_trust.sql`
- Modify: `db/schema.sql`
- Modify: `shared/db.ts`
- Create: `scripts/backfill-data-trust.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 `ListingTrustResult`, Task 2 `OutcomeTrustResult`.
- Produces: `gm_data_trust`, `gm_outcome_trust`, `gm_trusted_outcome_eval`, `saveListingDataTrust`, `saveOutcomeTrust`, `npm run trust:backfill`.

- [ ] **Step 1: Add the migration contract**

```sql
create table if not exists gm_data_trust (
  listing_id bigint primary key references gm_listings(id) on delete cascade,
  status text not null check (status in ('trusted','hold','quarantined')),
  score int not null check (score between 0 and 100),
  reason_codes jsonb not null default '[]'::jsonb,
  checks jsonb not null default '{}'::jsonb,
  evaluator_version text not null,
  input_hash text not null,
  evaluated_at timestamptz not null default now()
);

create table if not exists gm_outcome_trust (
  case_no text not null, item_no text not null, sale_date date not null,
  status text not null check (status in ('trusted','hold','quarantined')),
  sale_ratio numeric, reason_codes jsonb not null default '[]'::jsonb,
  checks jsonb not null default '{}'::jsonb, evaluator_version text not null,
  evaluated_at timestamptz not null default now(),
  primary key (case_no,item_no,sale_date)
);
```

Create `gm_trusted_outcome_eval` as `gm_outcome_eval` joined to `gm_outcome_trust` where status is `trusted`.

- [ ] **Step 2: Add persistence functions**

Add exact signatures:

```ts
export async function saveListingDataTrust(listingId: number, result: ListingTrustResult, inputHash: string): Promise<void>
export async function saveOutcomeTrust(caseNo: string, itemNo: string, saleDate: string, result: OutcomeTrustResult): Promise<void>
```

Use upserts and JSON serialization through the existing `j()` helper.

- [ ] **Step 3: Add the bounded backfill command**

`scripts/backfill-data-trust.ts` accepts `TRUST_BACKFILL_LIMIT` default `5000` and `--outcomes-only`. It reads listing analyses and documents in one SQL query, maps them to `ListingTrustInput`, saves each result, then evaluates unmatched/sold outcomes. Print `trusted`, `hold`, `quarantined`, and top reason counts.

- [ ] **Step 4: Apply migration in a transaction and validate schema**

Run: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrate_precision_data_trust.sql`

Expected: exit 0.

Run: `npm run trust:backfill -- --limit=50`

Expected: 50 or fewer listing rows evaluated and all status counters sum to processed.

Run: `npm run typecheck && npm test`

Expected: all root tests pass.

- [ ] **Step 5: Commit and push**

```bash
git add db/migrate_precision_data_trust.sql db/schema.sql shared/db.ts scripts/backfill-data-trust.ts package.json
git commit -m "add) 데이터 신뢰성 저장과 백필 흐름 추가"
git push origin codex/courtauction-photo-lifecycle
```

---

### Task 4: Trusted Outcome Metrics

**Files:**
- Modify: `scripts/eval-report.ts`
- Modify: `scripts/export-ml-dataset.ts`
- Modify: `server/src/main/java/com/gyeongmae/service/ListingService.java`
- Modify: `docs/phase2/ml-plan.md`

**Interfaces:**
- Consumes: Task 3 `gm_trusted_outcome_eval`.
- Produces: anomaly-free evaluation, ML export, and dashboard metrics while retaining raw coverage counts.

- [ ] **Step 1: Write a failing SQL-source test**

Create a focused Vitest test that reads the three source files and asserts model/error queries reference `gm_trusted_outcome_eval`, while coverage reporting still references `gm_outcome_eval`.

```ts
expect(evalSource).toContain('from gm_trusted_outcome_eval');
expect(exportSource).toContain('from gm_trusted_outcome_eval');
expect(serviceSource).toContain('gm_trusted_outcome_eval');
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run scripts/trusted-outcome-sources.test.ts`

Expected: FAIL because the production queries still use raw outcomes.

- [ ] **Step 3: Switch price and model metrics to trusted outcomes**

Keep raw `past_snapshots`, `matched`, and miss rate in a separate coverage query. Calculate MAPE, calibration groups, rights replay, surprise cases, and ML CSV from `gm_trusted_outcome_eval`. Add raw, trusted, hold, quarantined row counts to the review API response.

- [ ] **Step 4: Verify known outliers are excluded**

Run: `npm run trust:backfill -- --outcomes-only`

Run: `npm run eval:report`

Expected: report includes trusted/quarantined counts and does not list `2025타경908` as an overpriced trusted case.

Run: `npm run ml:export`

Expected: exported CSV has no sale ratio below 0.2 or above 1.5.

- [ ] **Step 5: Run regression tests, commit, and push**

Run: `npm test && npm run typecheck`

```bash
git add scripts/eval-report.ts scripts/export-ml-dataset.ts scripts/trusted-outcome-sources.test.ts server/src/main/java/com/gyeongmae/service/ListingService.java docs/phase2/ml-plan.md
git commit -m "fix) 신뢰 가능한 낙찰결과만 학습과 보정에 사용"
git push origin codex/courtauction-photo-lifecycle
```

---

### Task 5: Precision Recommendation Evaluator

**Files:**
- Create: `pipeline/precision/evaluate.ts`
- Create: `pipeline/precision/evaluate.test.ts`

**Interfaces:**
- Consumes: `ListingTrustResult`, 권리·입지·가격 분석 요약.
- Produces: `evaluatePrecision(input: PrecisionInput): PrecisionEvaluation`.

- [ ] **Step 1: Write failing recommendation-gate tests**

```ts
const safe = precisionInput();
expect(evaluatePrecision(safe).status).toBe('recommended');
expect(evaluatePrecision({ ...safe, trustStatus: 'hold' }).status).toBe('hold');
expect(evaluatePrecision({ ...safe, assumedAmount: 10_000_000 }).status).toBe('rejected');
expect(evaluatePrecision({ ...safe, occupantLabel: '점유관계 미상' }).status).toBe('conditional');
expect(evaluatePrecision({ ...safe, comparablePrices: [] }).status).toBe('hold');
expect(evaluatePrecision({ ...safe, minBidPrice: safe.maxSafeBid + 1 }).status).toBe('rejected');
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run pipeline/precision/evaluate.test.ts`

Expected: FAIL because the precision evaluator does not exist.

- [ ] **Step 3: Implement exact output types**

```ts
export type PrecisionStatus = 'recommended' | 'conditional' | 'hold' | 'rejected';
export interface PrecisionEvaluation {
  status: PrecisionStatus;
  confidence: 'high' | 'medium' | 'low';
  conservativeValue: number | null;
  recommendedBid: number | null;
  hardCapBid: number | null;
  reasonCodes: string[];
  strengths: string[];
  risks: string[];
  requiredChecks: string[];
  evaluatorVersion: 'precision-v1';
}
```

Rules: trust `hold/quarantined` cannot be recommended; assumed amount or danger flags reject; review-required rights hold; unknown occupancy is conditional; fewer than two comparable prices holds unless market confidence is high and at least one independent price basis exists; conservative value is the minimum of trusted market price and comparable-price 25th percentile; price bases diverging above 20% hold; hard cap is the minimum of existing max-safe-bid and cost-adjusted target-margin cap; min bid above hard cap rejects; recommended bid is capped by hard cap and never below min bid.

- [ ] **Step 4: Validate all gate combinations**

Run: `npx vitest run pipeline/precision/evaluate.test.ts shared/data-trust.test.ts`

Expected: PASS with table-driven tests for every status.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit and push**

```bash
git add pipeline/precision/evaluate.ts pipeline/precision/evaluate.test.ts
git commit -m "add) 정밀 추천 하드 게이트와 보수적 입찰가 추가"
git push origin codex/courtauction-photo-lifecycle
```

---

### Task 6: Precision Persistence, Pipeline, and Shortlist

**Files:**
- Create: `db/migrate_precision_recommendations.sql`
- Modify: `db/schema.sql`
- Modify: `shared/db.ts`
- Modify: `pipeline/run.ts`
- Create: `pipeline/precision/input.ts`
- Create: `pipeline/precision/input.test.ts`
- Create: `scripts/backfill-precision.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 5 `PrecisionEvaluation`.
- Produces: `gm_precision_evaluations`, `gm_precision_shortlist`, continuous analysis writes, `npm run precision:backfill`.

- [ ] **Step 1: Add schema and persistence contract**

Create one current row per listing with status, confidence, conservative value, recommended/hard-cap bid, reason arrays, evaluator version, input hash, and evaluated timestamp. Create `gm_precision_shortlist` that only exposes active `recommended` rows, ranks one representative per case, then orders by confidence, conservative margin, and sale date. Do not fill the requested limit in SQL by weakening filters.

- [ ] **Step 2: Write a failing pipeline integration test**

Extract mapping to `pipeline/precision/input.ts` and test that rights, location, site comparable prices, trust status, costs, and occupancy map without unit conversion.

- [ ] **Step 3: Integrate after analysis persistence**

In `pipeline/run.ts`, save rights and location first, evaluate listing trust, save trust, evaluate precision, save precision, then save the legacy score. A precision failure must save `hold` with an internal evaluation error reason and must not turn the legacy score into a recommendation.

- [ ] **Step 4: Backfill and verify shortlist invariants**

Run: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrate_precision_recommendations.sql`

Run: `npm run trust:backfill && npm run precision:backfill`

Run SQL checks:

```sql
select count(*) from gm_precision_shortlist where trust_status <> 'trusted';
select count(*) from gm_precision_shortlist where assumed_amount <> 0;
select count(*) from gm_precision_shortlist where hard_cap_bid < min_bid_price;
```

Expected: all three counts are 0.

- [ ] **Step 5: Run tests, commit, and push**

Run: `npm test && npm run typecheck`

```bash
git add db/migrate_precision_recommendations.sql db/schema.sql shared/db.ts pipeline/run.ts pipeline/precision/input.ts pipeline/precision/input.test.ts scripts/backfill-precision.ts package.json
git commit -m "add) 정밀 추천 저장과 주간 후보 뷰 연결"
git push origin codex/courtauction-photo-lifecycle
```

---

### Task 7: Precision and Decision Journal API

**Files:**
- Create: `db/migrate_decision_journal.sql`
- Modify: `db/schema.sql`
- Modify: `server/src/main/java/com/gyeongmae/service/ListingService.java`
- Modify: `server/src/main/java/com/gyeongmae/web/ListingController.java`
- Create: `server/src/test/java/com/gyeongmae/web/ListingControllerTest.java`

**Interfaces:**
- Produces: `GET /api/recommendations/precision?limit=5`, `GET /api/listings/{id}/decisions`, `POST /api/listings/{id}/decisions`.

- [ ] **Step 1: Add decision event schema**

```sql
create table if not exists gm_decision_events (
  id bigint generated always as identity primary key,
  listing_id bigint not null references gm_listings(id) on delete cascade,
  decision text not null check (decision in ('reviewing','favorite','hold','fieldwork','bid_review','rejected')),
  reason_code text,
  note text not null default '', target_bid bigint,
  precision_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

Create `gm_current_decisions` with `distinct on (listing_id)` ordered by `created_at desc, id desc`. Create `gm_decision_preference_summary` as a report-only aggregate of decision and reason counts. It exposes `sample_size` and `eligible_for_personalization = sample_size >= 50`; it does not change production ranking.

- [ ] **Step 2: Write failing MockMvc contract tests**

Test precision limit clamping to 3..7, valid decision POST returning 201, missing decision returning 400, unknown reason returning 400, and listing not found returning 404. Mock `ListingService` so tests do not require PostgreSQL.

- [ ] **Step 3: Implement service queries and validation**

Precision endpoint must join `gm_precision_shortlist` to the existing slim listing JSON and include `precision` and `current_decision`. Add `GET /api/review/decisions` for decision counts, reason distribution, funnel conversion, and personalization eligibility. Decision POST accepts:

```json
{"decision":"rejected","reasonCode":"price","note":"상한 초과","targetBid":230000000}
```

Allowed reason codes are `price`, `rights`, `location`, `field`, `capital`, `schedule`, `preference`, `data_missing`. Save the current precision row as `precision_snapshot` in the same insert.

- [ ] **Step 4: Validate API and migration**

Run: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrate_decision_journal.sql`

Run: `cd server && mvn test`

Expected: MockMvc tests pass.

Run: `curl -fsS 'http://localhost:8080/api/recommendations/precision?limit=5'`

Expected: JSON array length at most 5 and every row has `precision.status=recommended`.

- [ ] **Step 5: Commit and push**

```bash
git add db/migrate_decision_journal.sql db/schema.sql server/src/main/java/com/gyeongmae/service/ListingService.java server/src/main/java/com/gyeongmae/web/ListingController.java server/src/test/java/com/gyeongmae/web/ListingControllerTest.java
git commit -m "add) 정밀 후보와 사용자 결정 저널 API 추가"
git push origin codex/courtauction-photo-lifecycle
```

---

### Task 8: Web Decision Inbox and Detail Verdict

**Files:**
- Modify: `web/src/api.ts`
- Create: `web/src/precision.ts`
- Create: `web/src/precision.test.ts`
- Create: `web/src/PrecisionInbox.tsx`
- Create: `web/src/PrecisionVerdict.tsx`
- Create: `web/src/DecisionActions.tsx`
- Modify: `web/src/Detail.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: Task 7 API contracts.
- Produces: default precision inbox, explicit uncertainty copy, persisted user decisions.

- [ ] **Step 1: Write failing copy and state tests**

```ts
expect(precisionView({ status: 'hold', reason_codes: ['MISSING_MARKET_PRICE'] }).label).toBe('보류');
expect(precisionView({ status: 'hold', reason_codes: ['MISSING_MARKET_PRICE'] }).summary)
  .toContain('시세 근거 부족');
expect(canShowBid({ status: 'recommended', hard_cap_bid: 240_000_000 })).toBe(true);
expect(canShowBid({ status: 'hold', hard_cap_bid: 240_000_000 })).toBe(false);
```

- [ ] **Step 2: Add API types and clients**

Define `PrecisionObj`, `DecisionEvent`, `DecisionInput`, `fetchPrecisionRecommendations(limit)`, `fetchDecisions(id)`, and `saveDecision(id,input)`. Clamp client limit to 3..7 and reuse `apiJson`.

- [ ] **Step 3: Build isolated components**

`PrecisionInbox` shows at most seven cards and never displays a legacy passed row as recommended. `PrecisionVerdict` lists strengths, risks, required checks, conservative value, recommended bid, hard cap, confidence, and evaluated timestamp. `DecisionActions` requires a reason for hold/rejected, keeps note optional, and updates after a successful POST.

- [ ] **Step 4: Integrate default flow**

Place the precision inbox before `TodayActions`. Rename the existing actions section to `운영·보강 상태` and collapse it by default. Add precision verdict and decisions to the top of `Detail`. If the precision API fails, show `정밀 추천을 불러오지 못했습니다` and a link to the legacy list; do not label legacy scores as precise recommendations.

- [ ] **Step 5: Run web QA**

Run: `cd web && npx vitest run`

Run: `cd web && npm run build`

Expected: tests and production build pass.

Use browser QA at desktop and 390px mobile widths to verify inbox, detail verdict, decision save, reload persistence, keyboard navigation, and API-error copy.

- [ ] **Step 6: Commit and push**

```bash
git add web/src/api.ts web/src/precision.ts web/src/precision.test.ts web/src/PrecisionInbox.tsx web/src/PrecisionVerdict.tsx web/src/DecisionActions.tsx web/src/Detail.tsx web/src/App.tsx web/src/styles.css
git commit -m "add) 정밀 추천 결정 인박스와 판단 기록 UI 추가"
git push origin codex/courtauction-photo-lifecycle
```

---

### Task 9: Precision Audit and Operations

**Files:**
- Create: `scripts/precision-audit.ts`
- Create: `scripts/precision-audit.test.ts`
- Modify: `package.json`
- Create: `docs/precision-first-operations.md`
- Modify: `deploy/daily-parse.sh`

**Interfaces:**
- Produces: `npm run precision:audit`, daily bounded backfill/audit, operator runbook.

- [ ] **Step 1: Write failing audit tests**

Test `auditResult(metrics)` returns failure when a recommended row has non-trusted data, assumed amount, hard cap below min bid, duplicate case representative, or weekly count above seven. Test warning-only behavior for zero recommendations.

- [ ] **Step 2: Implement read-only audit**

The script queries exact invariant counts, status distributions, top hold/quarantine reasons, recommendation count, decision conversion, and trusted outcome coverage. It prints JSON with `ok`, `failures`, `warnings`, and `metrics`, and exits 1 only for safety invariant failures.

- [ ] **Step 3: Add daily bounded refresh**

After analysis and before digest, run trust and precision backfills for rows changed in the last two days, then `precision:audit`. A failed safety audit must prevent a precision digest but must not delete legacy analysis or photos. Send the failure through the existing Telegram failure path.

- [ ] **Step 4: Document operation and rollback**

Document migration order, backfill limits, audit interpretation, feature flag, API smoke checks, service restart, rollback to legacy list, and the rule never to train from `gm_outcome_eval` directly.

- [ ] **Step 5: Validate shell and full stack**

Run: `bash -n deploy/daily-parse.sh`

Run: `npm run precision:audit`

Run: `npm test && npm run typecheck`

Expected: all pass and audit returns `ok=true` or only zero-recommendation warning.

- [ ] **Step 6: Commit and push**

```bash
git add scripts/precision-audit.ts scripts/precision-audit.test.ts package.json docs/precision-first-operations.md deploy/daily-parse.sh
git commit -m "add) 정밀 추천 운영 감사와 일일 검증 흐름 추가"
git push origin codex/courtauction-photo-lifecycle
```

---

### Task 10: Production Migration, Full QA, and Completion Audit

**Files:**
- Modify: `README.md`
- Create: `docs/qa/2026-08-21-precision-first-final-qa.md`

**Interfaces:**
- Consumes: Tasks 1–9.
- Produces: deployed precision flow, reproducible QA evidence, final commit and push.

- [ ] **Step 1: Record pre-deploy state**

Capture current branch/commit, service status, DB table counts, active listing counts, photo metadata counts, and backup command output. Do not stage runtime photo changes.

- [ ] **Step 2: Apply migrations and backfills**

Apply the three migrations with `ON_ERROR_STOP=1`, run full trust/outcome and precision backfills, then run `precision:audit`. Record processed counts and status distributions.

- [ ] **Step 3: Run complete automated verification**

Run:

```bash
npm test
npm run typecheck
cd web && npm run build
cd server && mvn test
bash -n deploy/daily-parse.sh deploy/evening-collect.sh scripts/notify-telegram.sh
```

Expected: every command exits 0.

- [ ] **Step 4: Restart and smoke-test production services**

Restart API and web services, verify `/api/health`, precision recommendations, one detail, decision GET/POST using a reversible `reviewing` event, photo serving for an active photo, and legacy listings. Verify batch timers remain active and Telegram failure routing is configured without printing tokens.

- [ ] **Step 5: Perform browser regression QA**

Verify desktop and mobile: precision inbox count, empty state, detail explanations, source links, decision save/reload, whole-list fallback, map, comparison, fieldwork, ML review, photo gallery, and no horizontal overflow. Capture screenshots under `artifacts/qa` but do not commit them unless explicitly needed.

- [ ] **Step 6: Complete requirement-by-requirement audit**

For every completion condition in the spec, link authoritative evidence: source file, test output, SQL result, API response, service state, or browser screenshot. Mark uncertain evidence as incomplete and fix before completion.

- [ ] **Step 7: Update docs, commit, and push**

Update README with the precision-first workflow and add the final QA report containing commands, timestamps, result summaries, known trade-offs, and rollback instructions.

```bash
git add README.md docs/qa/2026-08-21-precision-first-final-qa.md
git commit -m "docs) 정밀 추천 운영 적용과 최종 QA 결과 기록"
git push origin codex/courtauction-photo-lifecycle
```

- [ ] **Step 8: Verify remote state**

Run: `git status --short --branch`

Expected: only pre-existing runtime `artifacts/listing-photos` changes remain.

Run: `git log --oneline origin/codex/courtauction-photo-lifecycle..HEAD`

Expected: no output, proving all commits are pushed.
