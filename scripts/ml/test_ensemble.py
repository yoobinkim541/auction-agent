import unittest

import numpy as np
import pandas as pd

from scripts.ml.ensemble import (
    _project_simplex,
    blend_predictions,
    current_expected_bid_predict,
    ensemble_confidence,
    fit_nonnegative_blend_weights,
    group_median_predict,
    normalize_weights,
)
from scripts.ml.offline_eval import (
    boolish,
    region_from_address,
    rolling_time_splits,
    safe_div,
    time_split,
)
from scripts.ml.shadow_ensemble import (
    feature_snapshot,
    json_value,
    snapshot_hash,
)


class EnsembleMathTest(unittest.TestCase):
    def test_normalize_weights_rejects_negative_mass_and_sums_to_one(self):
        weights = normalize_weights({"model_a": 2.0, "model_b": 1.0})

        self.assertAlmostEqual(weights["model_a"], 2 / 3)
        self.assertAlmostEqual(weights["model_b"], 1 / 3)
        with self.assertRaises(ValueError):
            normalize_weights({"model_a": -1.0, "model_b": 0.0})

    def test_blend_renormalizes_when_a_component_is_missing(self):
        prediction = blend_predictions(
            {"model_a": np.array([1.0, np.nan]), "model_b": np.array([3.0, 5.0])},
            {"model_a": 0.25, "model_b": 0.75},
            clip=None,
        )

        np.testing.assert_allclose(prediction, np.array([2.5, 5.0]))

    def test_weight_fit_prefers_component_with_lower_validation_error(self):
        target = np.array([1.0, 1.1, 0.9, 1.2, 1.05, 0.95])
        predictions = {
            "accurate": target.copy(),
            "biased": target + 0.8,
        }

        weights = fit_nonnegative_blend_weights(target, predictions)

        self.assertGreater(weights["accurate"], 0.8)
        self.assertAlmostEqual(sum(weights.values()), 1.0)

    def test_group_median_uses_training_rows_and_global_fallback(self):
        train = pd.DataFrame(
            [
                {"property_type": "apartment", "region": "서울 강남구", "sale_ratio": 0.8},
                {"property_type": "apartment", "region": "서울 강남구", "sale_ratio": 1.0},
                {"property_type": "villa", "region": "부산 해운대구", "sale_ratio": 0.6},
            ]
        )
        target = pd.DataFrame(
            [
                {"property_type": "apartment", "region": "서울 강남구"},
                {"property_type": "house", "region": "대전 서구"},
            ]
        )

        prediction = group_median_predict(train, target, min_group_rows=2)

        np.testing.assert_allclose(prediction, np.array([0.9, 0.8]))

    def test_time_splits_are_date_ordered_and_case_item_purged(self):
        frame = pd.DataFrame([
            {"case_no": "A", "item_no": "1", "sale_date": "2026-01-01", "sale_ratio": 0.8},
            {"case_no": "A", "item_no": "1", "sale_date": "2026-01-02", "sale_ratio": 0.9},
            {"case_no": "B", "item_no": "1", "sale_date": "2026-01-03", "sale_ratio": 0.7},
            {"case_no": "C", "item_no": "1", "sale_date": "2026-01-04", "sale_ratio": 0.6},
            {"case_no": "D", "item_no": "1", "sale_date": "2026-01-05", "sale_ratio": 0.5},
        ])
        frame["sale_date"] = pd.to_datetime(frame["sale_date"])

        train, test = time_split(frame, test_ratio=0.4)
        train_keys = set(zip(train["case_no"], train["item_no"]))
        test_keys = set(zip(test["case_no"], test["item_no"]))
        self.assertLess(train["sale_date"].max(), test["sale_date"].min())
        self.assertTrue(train_keys.isdisjoint(test_keys))
        self.assertGreaterEqual(len(rolling_time_splits(frame, n_splits=2, test_ratio=0.25, min_train_rows=1)), 1)


    def test_current_expected_bid_predict_computes_ratio_and_clips(self):
        frame = pd.DataFrame([
            {"appraisal_value": 200_000_000, "expected_bid": 160_000_000},
            {"appraisal_value": 100_000_000, "expected_bid": 300_000_000},  # ratio 3.0 -> clipped to 2.5
            {"appraisal_value": 0, "expected_bid": 100_000_000},            # divide by 0 -> nan
        ])
        result = current_expected_bid_predict(frame)
        self.assertAlmostEqual(result[0], 0.8)
        self.assertAlmostEqual(result[1], 2.5)
        self.assertTrue(np.isnan(result[2]))

    def test_ensemble_confidence_reflects_agreement_and_coverage(self):
        weights = {"model_a": 0.5, "model_b": 0.5}
        # High agreement
        high_agreement = {
            "model_a": np.array([0.8]),
            "model_b": np.array([0.8]),
        }
        conf_high = ensemble_confidence(high_agreement, weights)[0]
        self.assertGreaterEqual(conf_high, 0.95)

        # Divergent predictions
        divergent = {
            "model_a": np.array([0.4]),
            "model_b": np.array([1.2]),
        }
        conf_low = ensemble_confidence(divergent, weights)[0]
        self.assertLess(conf_low, conf_high)

        # Missing component reduces coverage
        missing_comp = {
            "model_a": np.array([0.8]),
            "model_b": np.array([np.nan]),
        }
        conf_partial = ensemble_confidence(missing_comp, weights)[0]
        self.assertAlmostEqual(conf_partial, 0.5)

    def test_project_simplex_sums_to_one_and_is_nonnegative(self):
        v = np.array([-0.5, 1.2, 0.8, -0.1])
        proj = _project_simplex(v)
        self.assertTrue((proj >= 0).all())
        self.assertAlmostEqual(float(proj.sum()), 1.0)

    def test_safe_div_and_boolish(self):
        num = pd.Series([10.0, 20.0, 30.0])
        den = pd.Series([2.0, 0.0, 5.0])
        div_result = safe_div(num, den)
        self.assertAlmostEqual(div_result[0], 5.0)
        self.assertTrue(pd.isna(div_result[1]))
        self.assertAlmostEqual(div_result[2], 6.0)

        b_series = pd.Series(["true", "t", "1", "yes", "false", "0", "n"])
        b_result = boolish(b_series).tolist()
        self.assertEqual(b_result, [True, True, True, True, False, False, False])

    def test_region_from_address(self):
        self.assertEqual(region_from_address("서울특별시 강남구 역삼동"), "서울특별시 강남구")
        self.assertEqual(region_from_address("경기도 수원시 영통구"), "경기도 수원시")
        self.assertEqual(region_from_address("부산광역시 해운대구"), "부산광역시 해운대구")
        self.assertEqual(region_from_address(""), "unknown")

    def test_feature_snapshot_and_hash(self):
        self.assertIsNone(json_value(None))
        self.assertIsNone(json_value(np.nan))
        self.assertEqual(json_value(np.int64(42)), 42)
        self.assertEqual(json_value(np.float64(3.14)), 3.14)
        self.assertEqual(json_value(pd.Timestamp("2026-06-22")), "2026-06-22")

        snap1 = {"appraisal_value": 200000000, "property_type": "apartment"}
        snap2 = {"property_type": "apartment", "appraisal_value": 200000000}
        self.assertEqual(snapshot_hash(snap1), snapshot_hash(snap2))
        self.assertEqual(len(snapshot_hash(snap1)), 64)

if __name__ == "__main__":
    unittest.main()
