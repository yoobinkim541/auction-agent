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
- Training rows (`TRAINING_ROWS_SQL`, shared by `ml:export` and `ml:shadow`) read D-7 inputs first, then D-1, and fall back to the latest listing/analysis rows only when no snapshot exists. `feature_source` is `d7`, `d1`, or `latest`; `latest` rows can carry post-sale `fail_count` and re-analysis values.
- `min_bid_price` in training rows is the result's minimum for that sale date. Past prediction snapshots stored the previous round's minimum.

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
   - Label `net-margin-v1`: matched, sold, and `(V − sold_amount − assumed_amount − acquisition tax − move-out − bond) / V ≥ 0.10`. `V` is the low end of the AVM 80% band, capped by the appraisal. With the AVM point estimate 63% of sold rows pass and the label correlates 0.75 with "sold"; with the low end 27% pass (correlation 0.47).
   - Rows without an AVM value have no label. Neither do rows whose assumed amount is more than 10× the larger of the appraisal and the AVM value: that is a parse error (two amounts read as one number). A deposit above the appraisal is a real loss and stays labelled.
   - Inputs: appraisal, that round's minimum bid, area, AVM value/band/basis, assumed amount, opposing tenant, rights grade, court, region, type.
   - Excluded: `total_score`, `recommendation`, `expected_bid`, `true_margin` (past prediction snapshots were rewritten after the auction), `fail_count` (latest row counts later failed rounds), view/bookmark counts (post-sale on rows without a D-7/D-1 snapshot), and every sale outcome.
   - Use: time-split AUC and precision@10% against `total_score`, min-bid/value cheapness, and a logistic regression on the same inputs. A listing whose minimum bid already leaves under 10% can never be good, so the report also gives AUC on the rows where the label is still open; that is the figure to judge by. Stored only as `features.good_listing` (`version`, `probability`, `conservative_value`) on the existing shadow row. It does not change bids, filters, or recommendations.
   - Shadow tracking: the report compares probabilities stored before 00:00 KST of the sale date with the label that arrives later. Judge after at least 4 weeks of sale dates.

## Market Value Model (AVM)

- `npm run ml:avm` trains on MOLIT sale trades in `gm_molit_cache` (apartment, row house/multiplex, officetel). Production only fetches officetel trades for districts with active officetel listings (last 12 months), so the script fills the remaining apartment-cache cells through the same `fetchMolitRaw` path (own key first). Until 2026-11 officetel trades came from the k-skill proxy under an ML-only key (`ml:RTMSDataSvcOffiTrade`) without lot numbers or cancellation flags; `avm-v2` uses the official data.
- Target: log price per m² relative to the tightest comparable median (same building and floor plan → building → dong and size → dong → district). XGBoost quantile regression (10/50/90%) with a conformal offset for the 80% band.
- Band calibration (`fit_calibrated`): a first model stops 60 days before the newest trade and sets the offset on those 60 days; the stored model is then refitted with them. Leaving the model 60 days stale covered 78.0 / 80.2 / 77.2% of later trades in three periods; refitting covered 80.6 / 81.8 / 80.0%. Per-type offsets, a 90- or 120-day window, and separate lower/upper offsets were tried and did not hold across the three periods. The holdout evaluation builds its model the same way.
- The forward check's "after training" row scores listings with the first model, because the stored one has seen every trade.
- Row house/multiplex error (13.8% MdAPE) drops to 11.8% on the trade holdout when the unit's own build year and same-age dong comparables are added. Not adopted: only 388 of 13,437 row-house listings have a build year (`gm_location_analysis.building.approvalDate`), so the model would train on a feature that is missing when it scores listings. Revisit once building-register data covers listings.
- Point-in-time: a valuation on day `t` only sees trades contracted in `(t − 30 − 365, t − 30]` (30 days = reporting lag). Training rows are trades valued on their own contract day.
- `gm_avm_estimates` holds one row per sale date. `as_of` is 7 days before the sale (today if the sale is further away). A row is rewritten only while `as_of` still advances; `--rebuild` recomputes everything. Past sale dates were backfilled with `as_of = sale_date − 7`; their comparables are point-in-time but the model weights were fitted on all trades.
- Listing keys come from the court raw fields (`hjguDong`+`hjguRd`, `daepyoLotno`, `buldNm`) and the exclusive area from `pjbBuldList` (`parseExclusiveArea` in `crawler/normalize.ts`, the same function the crawler uses to fill `gm_listings.area_m2`).
- Not covered: listings without an exclusive area (899 sale dates), and listings whose district has no trades in the cache (490, down from 3,351 after the code fixes below).
- District codes change. Bucheon (41190 → 41192/41194/41196, 2024-01), Hwaseong (41590 → 41591/41593/41595/41597, 2026-02) and Incheon (28110/28140 → 28125/28155, 28260 → 28275/28290, 2026-07) were reorganised, and the API returns nothing under the old codes, past months included. `ml:avm` warns in the daily log when a code's latest 6 or more cached months of apartment trades are all zero.
- The k-skill proxy returns 100 rows per call unless `num_of_rows` is given (max 1000, no paging); `fetchKskillDeals` asks for 1000.

## Model Order

1. Group median baseline: `property_type × region`.
2. scikit-learn: `HistGradientBoostingRegressor`, `LogisticRegression`, `RandomForestClassifier`.
3. XGBoost: optional challenger after sklearn baseline is stable; currently installed in `.venv-ml` and included by `npm run ml:eval`.
4. Non-negative time-window blend: `HistGradientBoostingRegressor` + XGBoost + group median + current expected-bid baseline.
5. Robust absolute-error regressor and validation-derived downside buffer for precision-first review.
6. PyTorch: defer until there is image/text/OCR/embedding data or much larger labels.

## Commands

```bash
npm run ml:avm -- --dry-run   # train the AVM and write artifacts/ml/avm_metrics.json without storing estimates
npm run ml:export
python3 scripts/ml/offline_eval.py --input artifacts/ml/outcome_eval.csv --output docs/phase2/ml-offline-report.md
npm run ml:shadow -- --dry-run
```

The daily learning batch runs `ml:avm` → `ml:eval` → `ml:shadow`; the last two read `gm_avm_estimates`.

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
- `npm run ml:shadow` stores only report-only predictions in `gm_shadow_scores`; it never updates `gm_scores`, bids, filters, or recommendations.

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
- `Good Listing Classification` splits the holdout by input source (`d7`, `d1`, `latest`). Only snapshot rows are free of post-sale values; judge the model on them once enough exist.
