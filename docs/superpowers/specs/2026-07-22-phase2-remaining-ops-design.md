# Phase2 Remaining Ops Design

## Goal

Finish the remaining Phase2 operational items that are still open in `docs/phase2/next-actions.md`: a bounded outcome retry worker and a report-only shadow score table. The goal is to reduce manual result backfill work while preserving the safety rule that ML outputs must not affect bids, filters, or recommendations yet.

## Scope

Included:
- Outcome retry status persistence for rows from `gm_result_retry_queue`.
- A bounded retry worker command that processes overdue unmatched outcomes and records per-key status.
- Shadow score storage for report-only model predictions.
- A shadow score evaluation view that joins predictions to later outcomes after a two-week observation window.
- Documentation updates marking the two remaining Phase2 items as implemented.

Excluded:
- Automatic adoption of model predictions into bid prices, filters, or recommendation logic.
- New crawler endpoints beyond the existing `collectSaleResults` and `collectCaseResults` adapters.
- Any deonakchal enrichment timer re-enable. It remains disabled until manual account safety review.

## Approach

Use Postgres as the durable source of truth. Add `gm_result_retry_status` for retry bookkeeping and update `gm_result_retry_queue` so already-successful rows and rows attempted too recently do not keep surfacing. Add `gm_shadow_scores` and `gm_shadow_score_eval` so offline model outputs can be stored and compared against future actual outcomes without touching production scoring.

Add a small TypeScript worker `scripts/retry-outcome-results.ts`. It reads bounded unmatched outcome rows using the same priority logic as `gm_result_retry_queue`, applies the worker cooldown from `OUTCOME_RETRY_COOLDOWN_HOURS`, tries active detail collection first, falls back to closed-case result lookup when needed, writes any result rounds through the same `gm_auction_results` table, and records status (`success`, `empty`, `blocked`, `error`) in `gm_result_retry_status`. This keeps the existing broad `collect:results` script intact and gives cron/bot/manual operators a narrower “retry just the misses” command.

## Data Model

`gm_result_retry_status` stores one row per `(case_no, item_no, sale_date)` with attempts, last status, last phase, last error, optional HTTP status, captcha flag, blocked reason, last round count, timestamps, and success timestamp.

`gm_shadow_scores` stores one report-only prediction per `(case_no, item_no, sale_date, model_name, model_version)`. Required fields are `predicted_sale_ratio`, `confidence`, `feature_snapshot_hash`, and `features`. The table intentionally has no link to `gm_scores` and no write path from the scoring engine.

`gm_shadow_score_eval` joins `gm_shadow_scores` to `gm_outcome_eval` and exposes error metrics only when the outcome is known. It also exposes `eligible_for_review`, which becomes true only when the sale date is at least 14 days old.

## Interfaces

- DB migration: `db/migrate_phase2_remaining_ops.sql`.
- Canonical schema: `db/schema.sql`.
- Worker command: `npm run retry:outcomes`.
- Worker environment knobs:
  - `OUTCOME_RETRY_LIMIT` default `50`.
  - `OUTCOME_RETRY_COOLDOWN_HOURS` default `24`.
  - `OUTCOME_RETRY_DRY_RUN=true` prints targets without network writes.
- Script output includes processed, success, empty, blocked, and error counters.

## Error Handling

The worker records every attempted key before moving to the next key. Courtauction IP blocks are recorded as `blocked` with `captcha_detected=true`, then the batch stops to protect the source and avoid repeated blocked traffic. Per-key non-blocking failures are recorded as `error` and the batch continues.

## Testing

- Add focused Vitest coverage for retry status classification and courtauction case key normalization in a pure helper module.
- Run `npm test` and `npm run typecheck`.
- Run `bash -n` only for shell changes if shell files change; this design does not change shell scripts.
- Run `cd web && npm run build` and `cd server && mvn test` after schema/API-adjacent changes to preserve the previously verified full stack.

## Safety Invariants

- Shadow scores are report-only and never update `gm_scores`, `gm_location_analysis`, or listing filters.
- Retry worker uses bounded batches and cooldowns.
- A block/captcha signal stops the batch instead of repeatedly hitting the same source.
- `gyeongmae-enrich.timer` remains disabled until manual deonakchal account review.
