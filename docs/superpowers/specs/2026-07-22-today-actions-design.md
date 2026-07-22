# Today Actions Queue Design

## Goal

Reduce daily manual review by turning scattered signals into one prioritized "today actions" queue. The dashboard should answer: "What should I check now, and why?" without requiring the user to inspect every listing, digest, favorite, crawl log, and review tab separately.

## Scope

Implement the first vertical slice with a shared DB-backed queue, a Spring API endpoint, and a dashboard strip.

Included action types:

- `recrawl_needed`: source data is incomplete or stale enough that analysis should not be trusted.
- `rights_enrichment`: a courtauction listing needs deonakchal tenant enrichment because occupancy is unknown.
- `bid_soon`: a passed or favorite listing has an auction date within seven days.
- `fieldwork`: a passed or favorite listing has unfinished fieldwork checklist items.
- `review_result`: outcome collection or post-auction review needs attention.

Out of scope for this slice:

- Mutating action state such as dismiss, snooze, or assign.
- Replacing existing recommendation, favorite, digest, or review screens.
- Auto-running crawl, enrich, collect, or analyze jobs from the action card.

## Architecture

The queue has one source of truth: a Postgres view named `gm_today_actions`.

The view returns rows with:

- `listing_id`
- `case_no`
- `item_no`
- `action_type`
- `priority`
- `severity`
- `title`
- `reason`
- `due_date`
- `sort_date`
- `source_url`

Spring exposes the view through `GET /api/actions/today?limit=20`. The endpoint returns a JSON array ordered by `priority desc, sort_date asc, case_no, item_no`.

The React dashboard loads the endpoint independently from the listing list. It renders a compact "오늘 할 일" strip below crawl/stats banners and above filters. Clicking an action opens the corresponding listing detail drawer by `case_no`; it does not mutate current filters or sort order.

## Action Rules

The first version uses deterministic SQL rules:

- `recrawl_needed`
  - listing report headline starts with `[데이터 불완전]`, or
  - listing has no rights analysis or location analysis while still active.
- `rights_enrichment`
  - source is `courtauction`, and
  - eviction occupant label is `점유관계 미상`, and
  - listing is passed, favorite, or has `total_score >= 70`.
- `bid_soon`
  - sale date is today through seven days from today, and
  - listing is passed or favorite.
- `fieldwork`
  - listing is passed or favorite, and
  - generated fieldwork checklist count is greater than checked note count.
- `review_result`
  - result retry queue has overdue rows, or
  - an outcome surprise from `gm_outcome_eval` has `sale_date >= current_date - 14` and is linked to a listing available in the dashboard.

Priority is numeric and comparable across action types:

- 100+: same-day or data-trust blockers.
- 80-99: auction date within seven days.
- 60-79: rights enrichment or fieldwork blockers.
- 40-59: review and learning-loop tasks.

Severity is one of `danger`, `warn`, or `info`.

## UI Behavior

The action strip shows at most 8 visible cards, with a count for hidden additional actions. Each card shows:

- action label
- case number and optional item number
- short title
- reason
- due date when available

Empty state: if the endpoint returns no rows, the strip is hidden.

Loading/error behavior:

- Loading should not block the main listing table.
- API failure should show a small non-blocking warning in the strip area.
- Existing listing loading and crawl stale banners remain unchanged.

## Data Flow

1. DB view derives actions from listings, scores, rights, location report, fieldwork notes, retry queue, and outcome review data.
2. `ListingService.todayActionsJson(limit)` reads the view and returns JSON text.
3. `ListingController` exposes `GET /api/actions/today`.
4. `web/src/api.ts` defines `TodayAction` and `fetchTodayActions`.
5. `App.tsx` loads actions and passes them to a small `TodayActions` component.
6. `TodayActions` calls the existing detail open flow with `case_no`.

## Error Handling

- Invalid `limit` values are clamped server-side to `1..50`.
- Missing optional fields are returned as null rather than causing row omission.
- The frontend handles network failure locally and does not set the global listing error state.
- If a clicked listing no longer exists, the existing detail fetch error behavior applies.

## Testing

Required verification:

- `npm run typecheck`
- `npm test`
- Spring compile or test command if available without requiring external services.

Focused tests:

- API TypeScript type compiles.
- New React component renders empty, loading error, and sample actions.
- SQL view is included in `db/schema.sql` and a migration file.

## Implementation Notes

Keep the first slice read-only. Do not add dismiss/snooze until the user has used the queue and can say which actions are noisy. The value of this feature is shared prioritization, not another editable task system.
