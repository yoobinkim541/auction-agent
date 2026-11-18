import unittest

import pandas as pd

from scripts.ml.good_listing import (
    LABEL_VERSION,
    LEAKY_COLUMNS,
    acquisition_tax_rate,
    allowed_features,
    conservative_value,
    eval_shadow_tracking,
    floor_margin,
    feature_frame,
    good_listing_mask,
    labelled_rows,
    net_margin,
    precision_at_fraction,
)


def listing(**overrides) -> dict:
    row = {
        "property_type": "apartment", "appraisal_value": 600e6, "min_bid_price": 420e6, "area_m2": 60.0,
        "avm_value": 550e6, "avm_low": 500e6, "avm_high": 600e6,
        "sold": True, "sold_amount": 400e6, "assumed_amount": 0.0, "move_out_cost": 2e6, "bond_cost": 1e6,
    }
    row.update(overrides)
    return row


class GoodListingContractTest(unittest.TestCase):
    def test_features_do_not_include_the_label_or_its_rewrite(self):
        self.assertFalse(LEAKY_COLUMNS.intersection(allowed_features()))
        with self.assertRaises(RuntimeError):
            allowed_features(["min_bid_price", "fail_count"])

    def test_feature_frame_keeps_only_pre_sale_inputs(self):
        frame = pd.DataFrame([listing(true_margin=0.4, expected_bid=80.0, market_price=120.0, total_score=90.0, fail_count=3)])

        built = feature_frame(frame)

        self.assertEqual(list(built.columns), allowed_features())
        self.assertFalse(LEAKY_COLUMNS.intersection(built.columns))
        self.assertAlmostEqual(float(built.loc[0, "min_bid_ratio"]), 0.7)
        self.assertAlmostEqual(float(built.loc[0, "min_to_avm"]), 420 / 550)
        self.assertAlmostEqual(float(built.loc[0, "min_to_conservative"]), 420 / 500)
        self.assertAlmostEqual(float(built.loc[0, "avm_band_width"]), 100 / 550)

    def test_tax_follows_the_first_home_brackets(self):
        rates = acquisition_tax_rate(
            pd.Series(["apartment", "villa", "apartment", "officetel"]),
            pd.Series([500e6, 750e6, 1_000e6, 300e6]),
            pd.Series([60.0, 60.0, 100.0, 30.0]),
        )
        for rate, expected in zip(rates, [0.011, 0.022, 0.035, 0.046]):
            self.assertAlmostEqual(rate, expected)

    def test_margin_is_measured_against_the_low_band_after_costs(self):
        frame = pd.DataFrame([listing()])
        # 500 - 400 - tax 4.4 (1.1%) - move-out 2 - bond 1 = 92.6
        self.assertAlmostEqual(float(net_margin(frame)[0]), 92.6 / 500)

    def test_appraisal_caps_the_value(self):
        frame = pd.DataFrame([listing(appraisal_value=450e6)])
        self.assertAlmostEqual(float(conservative_value(frame)[0]), 450e6)
        self.assertAlmostEqual(float(net_margin(frame)[0]), 42.6 / 450)

    def test_label_needs_a_sale_and_ten_percent_left(self):
        frame = pd.DataFrame([
            listing(),                          # 18.5% left
            listing(sold=False, sold_amount=None),
            listing(sold_amount=450e6),         # 500 - 450 - 4.95 - 3 = 8.4% left
            listing(assumed_amount=60e6),       # the assumed deposit eats the margin
            listing(appraisal_value=450e6),     # 9.5% against the appraisal cap
        ])

        self.assertEqual(good_listing_mask(frame).tolist(), [True, False, False, False, False])

    def test_floor_margin_is_the_margin_at_the_minimum_bid(self):
        frame = pd.DataFrame([listing(), listing(min_bid_price=480e6)])
        # 500 - 420 - tax 4.62 - 3 = 72.38; a 480 floor leaves 500 - 480 - 5.28 - 3 = 11.72
        self.assertAlmostEqual(float(floor_margin(frame)[0]), 72.38 / 500)
        self.assertAlmostEqual(float(floor_margin(frame)[1]), 11.72 / 500)

    def test_rows_without_a_usable_value_have_no_label(self):
        frame = pd.DataFrame([
            listing(),
            listing(avm_value=None, avm_low=None, avm_high=None),
            listing(assumed_amount=9e12),       # two amounts joined into one: a parse error
        ])

        self.assertEqual(labelled_rows(frame).tolist(), [True, False, False])
        self.assertEqual(good_listing_mask(frame).tolist(), [True, False, False])

    def test_a_deposit_above_the_appraisal_is_a_real_loss_not_a_parse_error(self):
        frame = pd.DataFrame([listing(assumed_amount=700e6)])

        self.assertEqual(labelled_rows(frame).tolist(), [True])
        self.assertEqual(good_listing_mask(frame).tolist(), [False])
        self.assertLess(float(net_margin(frame)[0]), -1.0)

    def test_shadow_tracking_counts_only_this_label_version_with_a_label(self):
        rows = [
            listing(shadow_good_probability=0.9, shadow_good_version=LABEL_VERSION),
            listing(shadow_good_probability=0.2, shadow_good_version=LABEL_VERSION, sold=False, sold_amount=None),
            listing(shadow_good_probability=0.8, shadow_good_version="older-label"),
            listing(shadow_good_probability=None, shadow_good_version=None),
            listing(shadow_good_probability=0.7, shadow_good_version=LABEL_VERSION, avm_value=None, avm_low=None),
        ]
        frame = pd.DataFrame(rows)
        frame["sale_date"] = pd.to_datetime(["2026-11-17", "2026-11-18", "2026-11-18", "2026-11-19", "2026-11-19"])
        frame["matched"] = True
        frame["total_score"] = [50.0, 60.0, 70.0, 80.0, 90.0]

        tracked = eval_shadow_tracking(frame)

        self.assertEqual(tracked["rows"], 2)
        self.assertEqual(tracked["days"], 2)
        self.assertAlmostEqual(tracked["good_rate"], 0.5)
        self.assertAlmostEqual(tracked["model"]["auc"], 1.0)
        self.assertAlmostEqual(tracked["current_score"]["auc"], 0.0)

    def test_precision_at_fraction_ranks_high_scores_first(self):
        precision, count = precision_at_fraction([0.1, 0.9, 0.2, 0.8], [False, True, False, False], 0.5)

        self.assertEqual(count, 2)
        self.assertAlmostEqual(precision, 0.5)


if __name__ == "__main__":
    unittest.main()
