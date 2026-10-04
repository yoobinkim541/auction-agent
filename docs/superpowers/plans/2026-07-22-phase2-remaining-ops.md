# Phase2 Remaining Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Phase2's remaining operational items: a bounded outcome retry worker and report-only shadow score storage/evaluation.

**Architecture:** Postgres stores durable retry and shadow-score state. A TypeScript worker consumes `gm_result_retry_queue`, reuses existing courtauction result collectors, records retry status, and stops on block/captcha signals. Shadow scores remain isolated from operational scoring and are evaluated through a read-only view.

**Tech Stack:** PostgreSQL SQL migration/schema, TypeScript + tsx scripts, Vitest, existing `node-postgres` helper, existing courtauction result collectors.

## Global Constraints

- Do not auto-change bids, filters, listing scores, or recommendations from shadow scores.
- Use existing `collectSaleResults` and `collectCaseResults`; add no new crawler endpoint.
- Batch retries are bounded by `OUTCOME_RETRY_LIMIT` default `50`.
- Retry cooldown defaults to `OUTCOME_RETRY_COOLDOWN_HOURS=24`.
- `OUTCOME_RETRY_DRY_RUN=true` must avoid network calls and DB writes except reads.
- A blocked/captcha signal stops the batch.
- Keep `gyeongmae-enrich.timer` disabled.
- Do not introduce new runtime dependencies.

---

## File Structure

- `db/migrate_phase2_remaining_ops.sql`: migration for retry status table, shadow score table, updated retry queue view, and shadow score eval view.
- `db/schema.sql`: canonical schema copy of the same DB objects.
- `scripts/outcome-retry-utils.ts`: pure helpers for case normalization, status classification, and counters.
- `scripts/outcome-retry-utils.test.ts`: Vitest coverage for helper behavior.
- `scripts/retry-outcome-results.ts`: bounded worker command.
- `package.json`: add `retry:outcomes` script.
- `docs/phase2/next-actions.md`: mark remaining items as done and record commands.

---

### Task 1: DB Retry and Shadow Score Objects

**Files:**
- Create: `db/migrate_phase2_remaining_ops.sql`
- Modify: `db/schema.sql`

**Interfaces:**
- Produces: `gm_result_retry_status(case_no, item_no, sale_date, attempts, last_status, last_phase, last_error, last_http_status, captcha_detected, blocked_reason, last_round_count, last_attempted_at, succeeded_at)`.
- Produces: updated `gm_result_retry_queue` that skips successful rows and rows attempted inside cooldown.
- Produces: `gm_shadow_scores` and `gm_shadow_score_eval`.

- [ ] **Step 1: Add migration SQL**

Create `db/migrate_phase2_remaining_ops.sql` with:

```sql
create table if not exists gm_result_retry_status (
  case_no text not null,
  item_no text not null default '1',
  sale_date date not null,
  attempts int not null default 0,
  last_status text not null default 'pending',
  last_phase text,
  last_error text,
  last_http_status int,
  captcha_detected boolean not null default false,
  blocked_reason text,
  last_round_count int not null default 0,
  last_attempted_at timestamptz,
  succeeded_at timestamptz,
  primary key (case_no, item_no, sale_date),
  check (last_status in ('pending','success','empty','blocked','error'))
);

create index if not exists gm_result_retry_status_status_idx on gm_result_retry_status (last_status, last_attempted_at desc);

create table if not exists gm_shadow_scores (
  id bigint generated always as identity primary key,
  case_no text not null,
  item_no text not null default '1',
  sale_date date not null,
  model_name text not null,
  model_version text not null,
  predicted_sale_ratio double precision not null,
  confidence double precision,
  feature_snapshot_hash text not null,
  features jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (case_no, item_no, sale_date, model_name, model_version),
  check (predicted_sale_ratio > 0),
  check (confidence is null or (confidence >= 0 and confidence <= 1))
);

create index if not exists gm_shadow_scores_case_sale_idx on gm_shadow_scores (case_no, item_no, sale_date);
create index if not exists gm_shadow_scores_model_idx on gm_shadow_scores (model_name, model_version, created_at desc);

create or replace view gm_result_retry_queue as
  select e.case_no, coalesce(nullif(e.item_no,''),'1') as item_no, e.sale_date, e.court, e.property_type, e.address,
         (current_date - e.sale_date)::int as days_overdue,
         e.total_score, e.passed_filter, e.recommendation, e.expected_bid, e.min_bid_price, e.inq_cnt, e.interest_cnt,
         coalesce(rs.attempts, 0) as retry_attempts,
         rs.last_status as retry_last_status,
         rs.last_attempted_at as retry_last_attempted_at,
         case
           when e.sale_date < current_date - 14 then 100
           when e.passed_filter then 80
           when e.total_score >= 70 then 70
           else 50
         end as retry_priority
    from gm_outcome_eval e
    left join gm_result_retry_status rs
      on rs.case_no = e.case_no
     and rs.item_no = coalesce(nullif(e.item_no,''),'1')
     and rs.sale_date = e.sale_date
   where e.sale_date < current_date
     and e.matched = false
     and coalesce(rs.last_status, 'pending') <> 'success'
     and (rs.last_attempted_at is null or rs.last_attempted_at < now() - interval '24 hours')
   order by retry_priority desc, e.sale_date desc, e.case_no, item_no;

create or replace view gm_shadow_score_eval as
  select s.id, s.case_no, s.item_no, s.sale_date, s.model_name, s.model_version,
         s.predicted_sale_ratio, s.confidence, s.feature_snapshot_hash, s.created_at,
         e.property_type, e.court, e.address, e.appraisal_value, e.matched, e.sold,
         e.sold_amount, e.sale_ratio, e.realized_bid_margin,
         case when e.sale_ratio is not null then s.predicted_sale_ratio - e.sale_ratio end as sale_ratio_error,
         case when e.sale_ratio is not null then abs(s.predicted_sale_ratio - e.sale_ratio) end as abs_sale_ratio_error,
         (e.sale_date <= current_date - 14) as eligible_for_review
    from gm_shadow_scores s
    left join gm_outcome_eval e
      on e.case_no = s.case_no
     and coalesce(nullif(e.item_no,''),'1') = s.item_no
     and e.sale_date = s.sale_date;
```

- [ ] **Step 2: Append the same SQL to `db/schema.sql`**

Add the migration SQL near the Phase2 operational views. Keep object names and column names identical.

- [ ] **Step 3: Verify definitions exist**

Run:

```bash
rg -n "gm_result_retry_status|gm_shadow_scores|gm_shadow_score_eval" db/schema.sql db/migrate_phase2_remaining_ops.sql
```

Expected: both SQL files contain all three objects.

---

### Task 2: Pure Retry Helpers and Tests

**Files:**
- Create: `scripts/outcome-retry-utils.ts`
- Create: `scripts/outcome-retry-utils.test.ts`

**Interfaces:**
- Produces: `toCourtCaseNo(caseNo: string): string`.
- Produces: `toCourtItemNo(itemNo: string | null | undefined): string`.
- Produces: `statusFromRounds(rounds: SaleResultRound[]): 'success' | 'empty'`.
- Produces: `emptyRetryCounters(): RetryCounters`.

- [ ] **Step 1: Add tests**

Create tests that assert:
- `2025-103154` becomes `2025타경103154`.
- `2025타경103154` stays unchanged.
- blank, null, and non-positive item numbers become `'1'`.
- non-empty rounds are `success`; empty rounds are `empty`.

Run:

```bash
npm test -- scripts/outcome-retry-utils.test.ts
```

Expected before implementation: import/function errors.

- [ ] **Step 2: Implement helpers**

Implement the four exports in `scripts/outcome-retry-utils.ts` using existing `normalizeCaseNo` and the exported `SaleResultRound` type.

- [ ] **Step 3: Verify helper tests pass**

Run:

```bash
npm test -- scripts/outcome-retry-utils.test.ts
```

Expected: helper tests pass.

---

### Task 3: Outcome Retry Worker

**Files:**
- Create: `scripts/retry-outcome-results.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `gm_outcome_eval` plus `gm_result_retry_status`, using the same priority logic exposed by `gm_result_retry_queue`.
- Consumes: `collectSaleResults`, `collectCaseResults`, `courtCodeByName`, `nextSaleDate`, `failedRoundCount`.
- Produces: `npm run retry:outcomes`.
- Produces: rows in `gm_result_retry_status` and `gm_auction_results`.

- [ ] **Step 1: Add package script**

Add:

```json
"retry:outcomes": "tsx scripts/retry-outcome-results.ts"
```

- [ ] **Step 2: Add worker implementation**

Create a worker that:
- reads `OUTCOME_RETRY_LIMIT`, `OUTCOME_RETRY_DRY_RUN`;
- selects bounded unmatched rows from `gm_outcome_eval` with `OUTCOME_RETRY_COOLDOWN_HOURS`;
- skips rows without `courtCodeByName(court)`;
- in dry-run mode prints targets and exits without collectors;
- tries `collectSaleResults([case])`, then `collectCaseResults([case])` when active rounds are empty;
- upserts rounds into `gm_auction_results`;
- updates `gm_listings.sale_date`, `min_bid_price`, and `fail_count` when `nextSaleDate` returns a future date;
- upserts `gm_result_retry_status` with `success` or `empty`;
- catches `CourtAuctionBlockedError` by message/name, records `blocked`, stops the batch;
- records other errors as `error` and continues.

- [ ] **Step 3: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript exits 0.

---

### Task 4: Documentation Update

**Files:**
- Modify: `docs/phase2/next-actions.md`

**Interfaces:**
- Consumes: commands and DB objects from Tasks 1-3.
- Produces: updated operational docs.

- [ ] **Step 1: Mark remaining items complete**

Update `docs/phase2/next-actions.md`:
- Mark item 8 as ✅ with `npm run retry:outcomes`, status table, bounded cooldown, block-stop behavior.
- Mark item 9 as ✅ with `gm_shadow_scores`, `gm_shadow_score_eval`, and report-only invariant.
- Keep disabled timer note unchanged.

- [ ] **Step 2: Review docs**

Run:

```bash
sed -n '1,180p' docs/phase2/next-actions.md
```

Expected: Later section shows both tasks complete and no automatic ML adoption.

---

### Task 5: Full Verification and Commit

**Files:**
- Verify all files from Tasks 1-4.

**Interfaces:**
- Produces: verified local commit.

- [ ] **Step 1: Run targeted tests**

```bash
npm test -- scripts/outcome-retry-utils.test.ts
```

Expected: tests pass.

- [ ] **Step 2: Run root tests**

```bash
npm test
```

Expected: all Vitest tests pass.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Run web build**

```bash
cd web && npm run build
```

Expected: exits 0.

- [ ] **Step 5: Run server tests**

```bash
cd server && mvn test
```

Expected: exits 0.

- [ ] **Step 6: Inspect git status**

```bash
git status --short
```

Expected: only intentional files changed.

- [ ] **Step 7: Commit**

```bash
git add db/migrate_phase2_remaining_ops.sql db/schema.sql scripts/outcome-retry-utils.ts scripts/outcome-retry-utils.test.ts scripts/retry-outcome-results.ts package.json docs/phase2/next-actions.md docs/superpowers/plans/2026-07-22-phase2-remaining-ops.md
git commit -m "add) Phase2 결과 재시도와 shadow score 운영 기반 추가" -m "작업 내용:
- 결과 retry 상태 테이블과 bounded retry worker를 추가했습니다.
- shadow score 저장 테이블과 outcome 평가 view를 추가했습니다.
- Phase2 next-actions 문서를 구현 상태로 갱신했습니다.

성과:
- 미매칭 결과 재수집을 수동 추적 없이 제한된 배치로 실행할 수 있습니다.
- ML 예측은 운영 점수와 분리된 report-only shadow lane에서 검증할 수 있습니다.

Trade-off:
- retry worker는 기존 courtauction 수집 함수만 재사용하며 신규 응찰자수 캡처는 포함하지 않습니다."
```
