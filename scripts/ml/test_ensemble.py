import unittest

import numpy as np
import pandas as pd

from scripts.ml.ensemble import (
    blend_predictions,
    fit_nonnegative_blend_weights,
    group_median_predict,
    normalize_weights,
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


if __name__ == "__main__":
    unittest.main()
