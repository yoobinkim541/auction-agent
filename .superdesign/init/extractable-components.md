# Extractable Components

## AppShell
- Source: `web/src/App.tsx`
- Category: layout
- Description: Single-page dashboard shell with header, stats, filter controls, content views, overlays, and mobile tabbar.
- Extractable props: activeTab (string, default: "all"), showReview (boolean, default: false), showCfg (boolean, default: false)
- Hardcoded: product title, warning copy, admin job buttons, mobile tab labels

## TodayActions
- Source: `web/src/TodayActions.tsx`
- Category: basic
- Description: Prioritized action queue strip with severity-colored cards.
- Extractable props: actions (array), loading (boolean), error (string|null)
- Hardcoded: action labels, severity class mapping

## ListingRow
- Source: `web/src/App.tsx`
- Category: basic
- Description: Dense desktop table row for an auction listing with score, risk, prices, margin, D-Day, badges.
- Extractable props: item, score, groupByCase, caseSize
- Hardcoded: risk badge styles, score chips, Korean labels

## ListingCard
- Source: `web/src/App.tsx`
- Category: basic
- Description: Mobile listing card with summary metrics, score, D-Day, and risk/recommendation chips.
- Extractable props: item, score, groupByCase, caseSize
- Hardcoded: card metric labels, chip styling

## DetailDrawer
- Source: `web/src/Detail.tsx`
- Category: layout
- Description: Right-side detail drawer for rights, costs, location, fieldwork, source links, and reports.
- Extractable props: row, loading, position
- Hardcoded: keyboard hints, source link labels, section order

## ReviewPanel
- Source: `web/src/App.tsx`
- Category: basic
- Description: Phase2 ML/outcome review dashboard embedded in the page.
- Extractable props: data, loading, error
- Hardcoded: KPI labels, surprise group labels, review gate copy
