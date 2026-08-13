# Pages

## / — Auction Dashboard

Entry: `web/src/App.tsx`

Dependencies:
- `web/src/main.tsx`
  - `web/src/App.tsx`
    - `web/src/labels.ts`
    - `web/src/ui.tsx`
      - `web/src/filters.ts`
      - `web/src/api.ts`
      - `web/src/listing-utils.ts`
    - `web/src/api.ts`
    - `web/src/scoring.ts`
    - `web/src/MapView.tsx`
    - `web/src/CompareView.tsx`
    - `web/src/ConfigPanel.tsx`
    - `web/src/Legend.tsx`
    - `web/src/Detail.tsx`
      - `web/src/detail-blocks.tsx`
      - `web/src/CostCalculator.tsx`
    - `web/src/filters.ts`
    - `web/src/listing-utils.ts`
    - `web/src/useListings.ts`
    - `web/src/useTodayActions.ts`
    - `web/src/TodayActions.tsx`
    - `web/src/useIncremental.ts`
    - `web/src/export-csv.ts`
    - `web/src/persistence.ts`
    - `web/src/useMediaQuery.ts`

Actual desktop render branch: `App` renders table `table.grid` when `viewMode === 'list' && !isMobile`, cards only on mobile via CSS, map only when map mode is selected. The default page includes header/disclaimer, stats, week calendar, TodayActions strip, controls, optional legend/config/review panels, grid table/list content, detail drawer and compare modal as overlays.
