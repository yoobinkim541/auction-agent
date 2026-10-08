# Phase2 ML Plan

## Principle

ML is report-only until it beats the current rule-based pipeline on time-split backtests. It must not auto-change bids, filters, or recommendations yet.

## Trusted Outcome Boundary

- `gm_outcome_eval` is retained only for raw snapshot coverage, matched counts, and miss-rate reporting.
- `gm_trusted_outcome_eval` is the sole source for price/profit/error metrics, calibration groups, rights replay, surprise cases, and ML CSV labels.
- Outcome trust stores the checked `sold`, `appraisal_value`, and `sold_amount`; a later source-value change automatically removes that row from trusted metrics.
- Known matched unsold results are trusted with `sale_ratio = null`, so sale-outcome classification is no longer trained on sold-only data.
- Review summaries report raw, trusted, held, and quarantined row counts so data-quality exclusions remain visible.

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

## Model Order

1. Group median baseline: `property_type × region`.
2. scikit-learn: `HistGradientBoostingRegressor`, `LogisticRegression`, `RandomForestClassifier`.
3. XGBoost: optional challenger after sklearn baseline is stable; currently installed in `.venv-ml` and included by `npm run ml:eval`.
4. Non-negative time-window blend: `HistGradientBoostingRegressor` + XGBoost + group median + current expected-bid baseline.
5. Robust absolute-error regressor and validation-derived downside buffer for precision-first review.
6. PyTorch: defer until there is image/text/OCR/embedding data or much larger labels.

## Commands

```bash
npm run ml:export
python3 scripts/ml/offline_eval.py --input artifacts/ml/outcome_eval.csv --output docs/phase2/ml-offline-report.md
npm run ml:shadow -- --dry-run
```

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

- `gm_ml_price_calibration`: cached reference calibration by `property_type × region` with median sale ratio and realized margin.
- `gm_result_retry_queue`: prioritized unmatched past-sale rows for bounded result re-collection.
- `gm_rights_risk_eval`: replay of rights-risk buckets against outcomes, including opposition tenant and assumed amount fields.

## Offline Report Additions

- `Reference Price Performance` compares reference median price error against current expected-bid error.
- `Rights Risk Review` groups matched outcomes by rights-risk grade.
- XGBoost appears as a challenger only in the report; no bids, filters, or recommendations are changed automatically.
- `ensemble_blend` learns non-negative weights on an inner time-ordered validation window and is evaluated only on the outer holdout.
- `ensemble_conservative` subtracts a validation-derived downside buffer; its value is stored in shadow only and is not an operating bid.
- The shadow command trains from `gm_trusted_outcome_eval`, predicts the next `ML_SHADOW_LEAD_DAYS` listings (default 30), and preserves feature hashes/components for later review.
