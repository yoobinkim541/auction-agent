# Phase2 ML Plan

## Principle

ML is report-only until it beats the current rule-based pipeline on time-split backtests. It must not auto-change bids, filters, or recommendations yet.

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
4. PyTorch: defer until there is image/text/OCR/embedding data or much larger labels.

## Commands

```bash
npm run ml:export
python3 scripts/ml/offline_eval.py --input artifacts/ml/outcome_eval.csv --output docs/phase2/ml-offline-report.md
```

With ML packages:

```bash
python3 -m venv .venv-ml
.venv-ml/bin/python -m pip install -r requirements-ml.txt
npm run ml:eval
```

## Adoption Gate

- `gm_outcome_eval` miss rate < 30%.
- Sold rows with sale-ratio labels >= 150.
- Time-split holdout beats current expected-bid MAE.
- No automatic bid/recommendation changes before manual review.

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
