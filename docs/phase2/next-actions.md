# Phase2 Next Actions

## Now

1. Stabilize courtauction result collection. ✅
   - Split egress config so deonakchal account-protection proxy does not unintentionally control courtauction.
   - Add a small smoke command for `/pgj/index.on` and pgj15A result lookup.
   - Make `collect-results` save partial successes and report failed keys.
   - Add `gm_result_retry_queue` so missed past-sale rows can be retried by overdue/score priority without guessing manually.

2. Fix eval metric semantics. ✅
   - Verify `gm_outcome_eval.residual` direction.
   - Align report wording for over/under prediction.
   - Add counts for why sold rows drop out of priceStats.

3. Replace sold-rate quality with profit-aware quality. ✅
   - Add `would_have_won_under_max_safe_bid`.
   - Add realized margin at actual sold amount.
   - Report pass/skip performance by realized margin, not only sold 여부.
   - Add rights-risk replay via `gm_rights_risk_eval` so clean/caution/risky buckets can be compared against matched outcomes.

## Next

4. Build surprise review table. ✅
   - Output top `overpriced`, `avoid_but_sold`, `passed_but_unsold` rows to dashboard and `artifacts/ml/ml-surprises.csv`.
   - Include property type, region, interest/inquiry, score, recommendation, true margin, sale ratio.

5. Add dashboard review surface. ✅
   - Add a 복기 tab showing coverage, price error, and surprise cases.
   - Link each surprise row to listing detail.

6. Start conservative price calibration only after coverage improves. ✅ reference-only display added
   - Gate: miss rate < 30% and sold rows with expected_bid >= 150.
   - First model: property_type × region median sale ratio is shown as `ML 참고 보정가` only when sample size >= 5.
   - Adopt only after time-split backtest beats current expected_bid MAPE; do not auto-change bids/recommendations yet.
   - Use cached `gm_ml_price_calibration` view for listing/API performance instead of per-row calibration scans.
   - Dashboard shows `과다주의` when reference price is at least 5% below current expected bid.

7. Keep ML challengers report-only. ✅
   - XGBoost is installed in `.venv-ml` and included in `npm run ml:eval`.
   - `ensemble_blend` learns weights only from an inner time-ordered validation window and is compared on the outer holdout.
   - `npm run ml:shadow -- --dry-run` previews current shadow predictions; normal execution writes only `gm_shadow_scores`.
   - Model predictions remain isolated from bids, filters, `gm_scores`, and recommendations until manual review approves adoption.
   - Outcome labels are snapshot-value checked; matched unsold rows are available for sale-outcome classification.
   - Rolling case/item-purged validation and a conservative downside buffer are included in the report-only lane.

## Later

8. Add outcome retry worker. ✅
   - Run `npm run retry:outcomes` for bounded batches; default `OUTCOME_RETRY_LIMIT=50` and `OUTCOME_RETRY_COOLDOWN_HOURS=24`.
   - Persist per-key retry status in `gm_result_retry_status`, including blocked reason, last HTTP status, captcha flag, attempts, and success timestamp.
   - Stop the batch on block/captcha signals so a bad egress session does not keep hammering courtauction.

9. Add shadow score table. ✅
   - Store `model_name`, `model_version`, `predicted_sale_ratio`, `confidence`, and `feature_snapshot_hash` in `gm_shadow_scores`.
   - Compare shadow scores against later outcomes with `gm_shadow_score_eval`, with `eligible_for_review` only after a two-week observation window.
   - `npm run ml:shadow` trains from trusted outcomes and upserts the next 30 days of ensemble predictions with feature/component snapshots.
   - Keep shadow scores report-only; they do not update bids, filters, `gm_scores`, or recommendations.

## Keep Disabled

- Keep `gyeongmae-enrich.timer` disabled until deonakchal account status is manually confirmed safe.
