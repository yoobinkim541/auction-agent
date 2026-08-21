# Task 6 Report: Precision Persistence, Pipeline, and Shortlist

## Implementation

- Added `gm_precision_evaluations` with one current row per listing, all evaluation arrays, evaluator metadata, deterministic input hash, and evaluation timestamp.
- Added `gm_precision_shortlist`, restricted to active `recommended` listings with trusted data, zero assumed amount, and hard cap at or above minimum bid. It keeps one representative per case and orders by confidence, conservative margin, then sale date.
- Added pure trust and precision input builders. `SiteComparable.dealManwon` converts to won once (`* 10_000`); all other monetary inputs remain won.
- Updated continuous persistence order to rights, location, trust, precision, then legacy score. Precision exceptions persist a low-confidence `hold` with `INTERNAL_EVALUATION_ERROR` and disable a passing legacy score.
- Added bounded `precision:backfill` with `--limit=N` and `PRECISION_BACKFILL_LIMIT`.
- Added `crawled_at` to analysis reads and preserved it in `rowToListing`; explicit root `parsed_json.itemNo` / `item_no` are the only embedded document mismatch signals.

## Files Changed

- `db/migrate_precision_recommendations.sql`
- `db/schema.sql`
- `shared/db.ts`
- `pipeline/run.ts`
- `pipeline/precision/input.ts`
- `pipeline/precision/input.test.ts`
- `scripts/backfill-precision.ts`
- `package.json`

`package-lock.json` was pre-existing controller-owned unstaged work and was not edited or staged. `artifacts/listing-photos` was not touched.

## RED/GREEN TDD Evidence

### RED

```bash
npm test -- pipeline/precision/input.test.ts
```

```text
FAIL pipeline/precision/input.test.ts
Error: Cannot find module './input.ts'
Test Files 1 failed
```

After adding the error-result expectation:

```text
FAIL precision input mapping > creates a low-confidence hold when precision evaluation throws
TypeError: internalEvaluationHold is not a function
```

### GREEN

```bash
npm test -- pipeline/precision/input.test.ts
```

```text
Test Files 1 passed (1)
Tests 4 passed (4)
```

The test covers actual crawled time, explicit item number semantics, one-and-only-one site-comparable conversion, monetary mapping, deterministic hashing, and the fail-closed error result.

## Commands and Outputs

### Migration

```bash
set -a
. .env
set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrate_precision_recommendations.sql
```

```text
.env: line 17: 220.79.191.14: command not found
CREATE TABLE
CREATE INDEX
CREATE VIEW
```

The pre-existing shell parsing warning did not prevent `psql` from receiving the configured URL. Node backfills use `dotenv/config`.

### Backfills

Required high-limit trust command issued:

```bash
npm run trust:backfill -- --limit=25000
```

Runner health capture:

```bash
npm run trust:backfill -- --limit=1; printf 'trust_runner_exit=%s\n' "$?"
```

```text
processed listings=1 outcomes=1
trusted=0 hold=1 quarantined=1
top reasons: EMPTY_REGISTRY:1, INSUFFICIENT_COMPS:1, MISSING_SOLD_AMOUNT:1, SALE_DATE_MISMATCH:1
trust_runner_exit=0
```

```bash
npm run precision:backfill -- --limit=25000
```

```text
processed listings=19813
recommended=0 conditional=133 hold=5718 rejected=13962
top reasons: OCCUPANCY_UNKNOWN:19052, TRUST_STATUS_UNRESOLVED:18375, MARGIN_BELOW_TARGET:11582, NO_VALID_COMPARABLE_PRICES:10654, RIGHTS_REVIEW_REQUIRED:10576, MIN_BID_ABOVE_HARD_CAP:6581, PRICE_BASIS_DIVERGENCE:5306, DANGER_FLAGS_PRESENT:2682, MISSING_OR_NON_POSITIVE_EXPECTED_BID:2485, RISK_GRADE_CAUTION:1138
```

Final row-count output:

```text
 listings | trust_rows | precision_rows
----------+------------+----------------
    19813 |      19813 |          19813
```

### SQL Invariants

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off \
  -c "select count(*) from gm_precision_shortlist where trust_status <> 'trusted';" \
  -c "select count(*) from gm_precision_shortlist where assumed_amount <> 0;" \
  -c "select count(*) from gm_precision_shortlist where hard_cap_bid < min_bid_price;"
```

```text
 count
-------
     0
(1 row)

 count
-------
     0
(1 row)

 count
-------
     0
(1 row)
```

### Root Validation

```bash
npm test && npm run typecheck
```

```text
Test Files 50 passed (50)
Tests 523 passed (523)

> gyeongmae-agent@0.1.0 typecheck
> tsc --noEmit
```

`git diff --check` completed without output.

## Self-Review

- Confirmed only site comparables are rescaled, once.
- Confirmed actual crawl timestamps are persisted through the analysis mapper.
- Confirmed evaluator exception persistence is a low-confidence hold and cannot leave a legacy passing score.
- Confirmed the shortlist exposes and filters `trust_status`, `assumed_amount`, and `min_bid_price` before case ranking.
- Confirmed no SQL limit weakens eligibility; no package-lock or photo artifact change is staged.

## Concerns

- The strict backfill produced zero `recommended` rows, so the initial shortlist is empty until source completeness, trust, occupancy, and margin evidence improve.
- Shell sourcing `.env` emits a pre-existing parse warning. Migration and Node dotenv-backed backfills completed; normalize local `.env` formatting separately for routine shell `psql` use.

## Commit

- `04ecb0c add) 정밀 추천 저장과 주간 후보 뷰 연결`

---

# Task 6 Fix Round 1 Report

## Changed Behavior and Files

- `scripts/daily-digest.ts` now reads top recommendations, shortlist counts, and weekly upcoming candidates only from `gm_precision_shortlist`; it no longer uses `gm_scores.passed_filter` for Telegram recommendations.
- `scripts/digest-queries.ts` adds the digest query boundary and clamps `DIGEST_TOP_N` to integer `3..7` (default `5`) without any fallback to legacy rows. An empty shortlist continues into `formatDigest`'s existing zero-recommendation message.
- Historical digest recap now uses `gm_precision_evaluations.status = 'recommended'`, so expired recommendations remain attributable without making them active shortlist candidates.
- `pipeline/precision/persist.ts` is a dependency-injected continuous persistence boundary. `pipeline/run.ts` uses it to persist rights/location, then trust, then precision, and finally legacy diagnostics.
- Added `scripts/digest-queries.test.ts` and `pipeline/precision/persist.test.ts`; `package-lock.json` remains pre-existing and unstaged, and `artifacts/listing-photos` was not touched.

## RED/GREEN Evidence

### RED

```bash
npm test -- scripts/digest-queries.test.ts pipeline/precision/persist.test.ts
```

```text
FAIL scripts/digest-queries.test.ts
Error: Cannot find module './digest-queries.ts'
FAIL pipeline/precision/persist.test.ts
Error: Cannot find module './persist.ts'
Test Files 2 failed (2)
```

### GREEN

```bash
npm test -- scripts/digest-queries.test.ts pipeline/precision/persist.test.ts
```

```text
Test Files 2 passed (2)
Tests 5 passed (5)
```

The tests cover strict digest count clamping, shortlist-only active/upcoming query sources, precision-status result recap, rights/location → trust → precision persistence order, evaluator exceptions producing a low-confidence internal-error hold, and fail-closed legacy scores.

## Validation

```bash
npm test && npm run typecheck
```

```text
Test Files 52 passed (52)
Tests 528 passed (528)
> tsc --noEmit
```

```bash
git diff --check
```

```text
(no output; passed)
```

## Self-Review and Concerns

- The active recommendation path does not join or rank by `gm_scores`; legacy scores remain persisted only as diagnostic compatibility data.
- `gm_precision_shortlist` retains its strict gates and SQL has no condition that relaxes eligibility to fill `DIGEST_TOP_N`.
- Strict evidence can still produce zero Telegram recommendations; this is intentional and preserves precision rather than filling the digest.

---

# Task 6 Fix Round 2 Report

## Root Cause and Resolution

- The prior `persistPrecisionStages` accepted all save and evaluator callbacks from `pipeline/run.ts`. Its unit test therefore exercised injected mocks rather than the production persistence wiring.
- `persistPrecisionStages` now owns the concrete `shared/db.ts` persistence calls, actual trust input/evaluation, actual precision input/evaluation, and input hashing. `pipeline/run.ts` passes only computed analysis data to this boundary.
- The production sequence is now exactly `saveRightsAnalysis` → `saveLocationAnalysis` → `backfillFailCountFromSaleRounds` → `saveListingDataTrust` → `savePrecisionEvaluation` → `saveScore`.
- The integration-style test mocks only `shared/db.ts`, so it cannot write to PostgreSQL, while executing the same boundary used by `pipeline/run.ts`. A narrow evaluator override forces a real thrown precision-evaluator path.
- Updated `scripts/daily-digest.ts` header to identify `gm_precision_shortlist` as the recommendation source.

## RED/GREEN TDD Evidence

### RED

```bash
npm test -- pipeline/precision/persist.test.ts
```

```text
FAIL pipeline/precision/persist.test.ts
TypeError: stages.saveRights is not a function
TypeError: setPrecisionEvaluatorForTesting is not a function
Test Files 1 failed (1)
Tests 2 failed (2)
```

The test failed because the old callback-injection API could not accept the production-shaped input or inject the evaluator failure seam.

### GREEN

```bash
npm test -- pipeline/precision/persist.test.ts
```

```text
Test Files 1 passed (1)
Tests 2 passed (2)
```

## Commands and Outputs

```bash
npm test -- pipeline/precision/persist.test.ts pipeline/precision/input.test.ts scripts/digest-queries.test.ts
```

```text
Test Files 3 passed (3)
Tests 9 passed (9)
```

```bash
npm test && npm run typecheck
```

```text
Test Files 52 passed (52)
Tests 528 passed (528)

> gyeongmae-agent@0.1.0 typecheck
> tsc --noEmit
```

```bash
git diff --check
```

```text
(no output; passed)
```

## Self-Review

- Confirmed `pipeline/run.ts` invokes only `persistPrecisionStages` for the six-step persistence sequence; it no longer imports persistence functions or trust/precision evaluators.
- Confirmed the production boundary calls actual `shared/db.ts`, `evaluateListingTrust`, and `evaluatePrecision` implementations; only database writes are mocked by the test.
- Confirmed the order test covers all six required function calls, including sale-round fail-count backfill.
- Confirmed the forced evaluator exception persists a `hold` / `low` evaluation with `INTERNAL_EVALUATION_ERROR` and writes a passing legacy score as failed with the internal-error reason.
- Confirmed no real PostgreSQL writes occur in the test, and `package-lock.json` plus photo artifacts remain unstaged and untouched by this change.
