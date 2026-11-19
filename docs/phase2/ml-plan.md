# Phase2 ML Plan

## Principle

ML is report-only until it beats the current rule-based pipeline on time-split backtests. It must not auto-change bids, filters, or recommendations yet.

## Trusted Outcome Boundary

- `gm_outcome_eval` is retained only for raw snapshot coverage, matched counts, and miss-rate reporting.
- `gm_trusted_outcome_eval` is the sole source for price/profit/error metrics, calibration groups, rights replay, surprise cases, and ML CSV labels.
- Outcome trust stores the checked `sold`, `appraisal_value`, and `sold_amount`; a later source-value change automatically removes that row from trusted metrics.
- Known matched unsold results are trusted with `sale_ratio = null`, so sale-outcome classification is no longer trained on sold-only data.
- Review summaries report raw, trusted, held, and quarantined row counts so data-quality exclusions remain visible.

## Point-in-Time Inputs

- All snapshot windows use KST dates. The daily batch runs at 21:00 UTC (06:00 KST the next day); a UTC window rewrote 86% of past prediction snapshots after the auction had started.
- `gm_feature_snapshots` freezes listing, rights, location, score, precision, and trust inputs once at D-1 (1 day left) and once at D-7 (first run with 2–7 days left; `days_to_sale` records the actual lead). Rows are never overwritten.
- Keep the exploratory price export separate from the adoption dataset. Only the latter can be used to decide whether to promote a ranking: take the actual frozen horizon, floor, costs, eligibility, bid and conservative value, not latest listing rows. The result-sheet floor is a round-consistency check, never a replacement for the production input.

## First Targets

1. Sale ratio regression
   - Target: `sold_amount / appraisal_value`.
   - Use: compare model-predicted sale ratio against current `expected_bid` logic.

2. Positive margin classification
   - Target: `realized_bid_margin > 0`.
   - Use: find whether passed/skip decisions align with profitable outcomes.

3. Safe bid hit-rate
   - Target: `sold_amount <= max_safe_bid`.
   - Use: only after new snapshots accumulate `max_safe_bid` labels.

4. Good listing classification
   - The old `net-margin-v1` target measured someone else's purchase at the observed winning price. It is not a label for our own bid.
   - Compare the recommended bid frozen before the sale with the confirmed winning price. Only a strictly higher bid counts as outbidding the winner; an equal bid is indeterminate. Price the transaction at **our bid**, not the runner-up's or the observed winning price. Subtract acquisition expenses and assumed rights once, then compare the estimated net margin with the target that was in force at the decision.
   - `post-sale-margin-v3` values the property with **later** same-building, same floor-plan (±5% area) sale trades, not with the frozen conservative value. v2 compared the frozen value against itself, so a model only re-learned the evaluator's own estimate. `ml:avm` writes `gm_post_sale_values` once per past sale: the median of area-normalized trades in the 180 days after the sale, written only after the window closes and a 30-day reporting delay passes (`post-sale-v1`). A won bid whose window is still open is `pending`; a closed window without such trades is `no_post_sale`. Neither is a loss or a training row.
   - Every outcome, an outbid loss included, becomes trainable only at `max(result known, sale date + 210 days KST)`. Training on losses as soon as they are known while wins wait seven months would bias the model toward losses. The cost is a seven-month label delay; the weekly replay shows `winnable` and `awaiting post-sale` counts right after the sale.
   - Missing rights information is not a verified zero. Untrusted or changed outcomes do not become negative examples. The post-sale value is a market estimate, not a realized resale return.
   - For adoption, compare three policies: the frozen precision shortlist order; highest estimated net margin rate at our bid (ranked by the frozen conservative value, known before the sale); highest saved shadow probability. The **comparison pool** (`gm_feature_snapshots.comparison_eligible`) is every recommended or conditional listing that passes the shortlist's trust, freshness, rights and bid-range gates; the current policy picks only from the shortlist inside it, the other two from the whole pool. Training and scoring use the same pool. One case per court, no backfilling missing predictions and no relaxing the rules to fill slots.
   - The weekly replay uses the **decision week** in Seoul. It takes up to seven cases in time order, ranking each day's cohort before moving to the next day. It does not sort the whole week using candidates that were unknown on Monday. D-7 (actual lead 2–7 days) and D-1 are separate experiments; never choose the better horizon after seeing a result.

## Market Value Model (AVM)

- `npm run ml:avm` trains on MOLIT sale trades in `gm_molit_cache` (apartment, row house/multiplex, officetel). Production only fetches officetel trades for districts with active officetel listings (last 12 months), so the script fills the remaining apartment-cache cells through the same `fetchMolitRaw` path (own key first). Until 2026-11 officetel trades came from the k-skill proxy under an ML-only key (`ml:RTMSDataSvcOffiTrade`) without lot numbers or cancellation flags; `avm-v2` uses the official data.
- Target: log price per m² relative to the tightest comparable median (same building and floor plan → building → dong and size → dong → district). XGBoost quantile regression (10/50/90%) with a conformal offset for the 80% band.
- `avm-v3` calibrates the lower bound by property type × comparable basis. A small cell uses the property-type calibration, then the global calibration if the type is sparse too. Unreliable or insufficient evidence triggers a separate follow-up list, never an automatic change to a bid or precision decision.
- The lower bound is checked separately from point-estimate error: for mature valuations with later same-building/similar-area sales, compare **each** later trade with the lower bound. The breach rate is the mean over valuations of the share of their later trades below the bound, so a property with many trades does not outweigh one with a single trade. (The old check compared the bound with the later median, which hides half of the price spread.) Rates on matched transactions alone do not describe unmatched properties.
- Row house/multiplex error (13.8% MdAPE) drops to 11.8% on the trade holdout when the unit's own build year and same-age dong comparables are added. Not adopted: only 388 of 13,437 row-house listings have a build year (`gm_location_analysis.building.approvalDate`), so the model would train on a feature that is missing when it scores listings. Revisit once building-register data covers listings.
- Monthly models use only trades known by the month's start. MOLIT cache cells do not preserve individual report times: when a trade has no reported/observed date, the backtest assumes contract date + 30 days. Historical corrections, cancellations and changes to source listing attributes cannot be perfectly reconstructed from mutable caches.
- Historical estimations are not production observations. Retrain using only transactions within the earlier monthly cutoff; historical reconstructions cannot silently replace a frozen decision input.
- Listing keys come from the court raw fields (`hjguDong`+`hjguRd`, `daepyoLotno`, `buldNm`) and the exclusive area from `pjbBuldList` (`parseExclusiveArea` in `crawler/normalize.ts`, the same function the crawler uses to fill `gm_listings.area_m2`).
- Not covered: listings without an exclusive area (899 sale dates), and listings whose district has no trades in the cache (490, down from 3,351 after the code fixes below).
- District codes change. Bucheon (41190 → 41192/41194/41196, 2024-01), Hwaseong (41590 → 41591/41593/41595/41597, 2026-02) and Incheon (28110/28140 → 28125/28155, 28260 → 28275/28290, 2026-07) were reorganised, and the API returns nothing under the old codes, past months included. `ml:avm` warns in the daily log when a code's latest 6 or more cached months of apartment trades are all zero.
- The k-skill proxy returns 100 rows per call unless `num_of_rows` is given (max 1000, no paging); `fetchKskillDeals` asks for 1000.

## Model Order

1. Group median baseline: `property_type × region`.
2. scikit-learn: `HistGradientBoostingRegressor`, `LogisticRegression`, `RandomForestClassifier`.
3. XGBoost: required for the AVM quantiles; optional challenger for the auction price ensemble.
4. Non-negative time-window blend: `HistGradientBoostingRegressor` + XGBoost + group median + current expected-bid baseline.
5. Robust absolute-error regressor and validation-derived downside buffer for precision-first review.
6. PyTorch: defer until there is image/text/OCR/embedding data or much larger labels.

## Commands

For an existing database already using the court-qualified keys, apply `db/migrate_frozen_decisions.sql` before deploying the writers. It adds `comparison_eligible` and `gm_post_sale_values`; older snapshots keep `comparison_eligible = null`, count as not fully frozen and are never upgraded. To replace old **AVM estimates** (not decision snapshots) with the monthly historical reconstruction, run `npm run ml:avm -- --rebuild` once on the batch host. Historical model artifacts are cached under `artifacts/ml/avm_month_cache/`.

```bash
npm run ml:avm -- --dry-run   # train the AVM and write artifacts/ml/avm_metrics.json without storing estimates
npm run ml:export
python3 scripts/ml/offline_eval.py --input artifacts/ml/outcome_eval.csv --output docs/phase2/ml-offline-report.md
npm run ml:shadow -- --dry-run
npm run ml:weekly            # fresh frozen export → artifacts/ml/weekly-shortlist.md
```

The daily learning batch runs `ml:avm` → `ml:eval` → `ml:shadow` → `ml:weekly`. The last report reads fresh horizon-specific probabilities. Daily parse freezes the decision inputs only after a successful precision refresh and audit.

With ML packages:

```bash
python3 -m venv .venv-ml
.venv-ml/bin/python -m pip install -r requirements-ml.txt
npm run ml:eval
```

## Adoption Gate

- Raw `gm_outcome_eval` miss rate < 30%.
- Trusted sold rows with sale-ratio labels >= 150.
- Time-split holdout beats current expected-bid MAE.
- Three rolling, case/item-purged forward windows should show the same direction before adoption.
- No automatic bid/recommendation changes before manual review.
- Price-ensemble outputs stay in `gm_shadow_scores`. `good-listing-v3` probabilities for `post-sale-margin-v3` go into `gm_decision_probabilities`, keyed by court, case, item, sale, horizon and model version. `gm_post_sale_values` is label-only and never a feature. None of these update `gm_scores`, bids, filters, or recommendations.

## Reference-Only Display

- Dashboard listings/details may show `ML 참고 보정가` from `property_type × region` median sale ratio when sample size >= 5.
- This is not an operating bid, not a filter, and not a recommendation override.
- Use it to spot over/under-estimation before manual review.
- Listing chips show `과다주의` when the reference price is at least 5% below the current expected bid.

## Operational Views

All outcome, snapshot, AVM, shadow-score and retry tables are keyed by `(court, case_no, item_no, …)`; the views join on `court` too, and the exported CSVs carry a `court` column. Case numbers are issued per court, so the same `case_no` under two courts is two different properties (`db/migrate_listing_identity_court.sql`). A past snapshot whose court has no listing row is left out of `gm_outcome_eval` rather than joined to another court's listing.

- `gm_ml_price_calibration`: cached reference calibration by `property_type × region` with median sale ratio and realized margin.
- `gm_result_retry_queue`: prioritized unmatched past-sale rows for bounded result re-collection.
- `gm_rights_risk_eval`: replay of rights-risk buckets against outcomes, including opposition tenant and assumed amount fields.

## Offline Report Additions

- `Reference Price Performance` compares reference median price error against current expected-bid error.
- `Rights Risk Review` groups matched outcomes by rights-risk grade.
- XGBoost appears as a challenger only in the report; no bids, filters, or recommendations are changed automatically.
- `ensemble_blend` learns non-negative weights on an inner time-ordered validation window and is evaluated only on the outer holdout.
- `ensemble_conservative` subtracts a validation-derived downside buffer; its value is stored in shadow only and is not an operating bid.
- The shadow command trains from `gm_trusted_outcome_eval`, predicts listings with a sale date 1 to `ML_SHADOW_LEAD_DAYS` days ahead (default 30, KST), and preserves feature hashes/components for later review. The sale day itself is excluded: the batch runs after bidding has opened.
- `Market Value Model (AVM)` reports holdout error against later trades, the same for the current tier rule, and a forward check of auction-listing estimates against later trades in the same building.
- Weekly replay reports selected cases, matched results, winnable bids, bids awaiting the post-sale window, decidable outcomes, hits, losses, score coverage and result-floor mismatches. Missing scores/labels must be visible, not treated as zero probability or a loss. A week whose pool has seven or fewer distinct court cases is marked `순서 비교 불가`: every policy can take the whole pool, so differences are not ranking effects. Inspect several resolved, rankable decision weeks at the same horizon before considering a manual **ranking-only** rollout. Safety gates, price caps and recommendation statuses never come from this model.
