import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from scripts.ml.avm import (
    EPOCH,
    FEATURES,
    FORWARD_DAYS,
    GAP_DAYS,
    WINDOW_DAYS,
    XGBOOST_AVAILABLE,
    LowerCalibration,
    apply_stored_band,
    build_index,
    calibrate_lower,
    cohort_evidence_status,
    comp_features,
    conformal_offset,
    design_matrix,
    forward_check,
    forward_exceedance,
    month_start_day,
    prepare_targets,
    prepare_trades,
    post_sale_values,
    score_targets,
    stored_prices,
    upcoming_review,
    value_by_month,
    vintage_fingerprint,
)


class ShiftModel:
    """Test double. Production caches only a real XGBoost model."""

    def __init__(self, shift: float):
        self.shift = float(shift)

    def predict(self, features):
        return np.full((len(features), 3), self.shift)


def date(day: int) -> str:
    return (EPOCH + pd.Timedelta(days=day)).strftime("%Y-%m-%d")


def trade(day: int, price: float, jibun: str = "10-1", dong: str = "가동", area: float = 60.0) -> dict:
    return {
        "kind": "apt", "sgg": "11110", "dong": dong, "jibun": jibun, "name": "단지", "area_m2": area,
        "floor": 5, "build_year": 2010, "deal_date": date(day), "price": price, "direct": "false",
    }


def target(day: int, jibun: str = "10-1", dong: str = "가동", area: float | None = 60.0) -> dict:
    return {
        "case_no": "2026타경1", "item_no": "1", "sale_date": date(day + 7), "as_of": date(day),
        "kind": "apt", "sgg": "11110", "dong": dong, "jibun": jibun, "name": "단지", "area_m2": area, "floor": 5,
    }


class ZeroModel:
    """Predicts no adjustment on top of the anchor."""

    def predict(self, features):
        return np.zeros((len(features), 3))


class PointInTimeTest(unittest.TestCase):
    def test_trades_inside_the_reporting_gap_are_not_visible(self):
        valuation_day = 9000
        trades = prepare_trades(pd.DataFrame([
            trade(valuation_day - GAP_DAYS - 10, 600_000_000),
            trade(valuation_day - GAP_DAYS + 1, 900_000_000),   # contracted, but not yet reliably reported
            trade(valuation_day + 5, 990_000_000),              # after the valuation day
        ]))
        targets = prepare_targets(pd.DataFrame([target(valuation_day)]))
        comps = comp_features(build_index(trades), targets)
        self.assertEqual(comps.loc[0, "b_n"], 1)
        self.assertAlmostEqual(comps.loc[0, "b_med"], np.log(600_000_000 / 60.0))

    def test_trades_older_than_the_window_are_dropped(self):
        valuation_day = 9000
        trades = prepare_trades(pd.DataFrame([
            trade(valuation_day - GAP_DAYS - WINDOW_DAYS, 300_000_000),
            trade(valuation_day - GAP_DAYS - WINDOW_DAYS + 1, 600_000_000),
        ]))
        comps = comp_features(build_index(trades), prepare_targets(pd.DataFrame([target(valuation_day)])))
        self.assertEqual(comps.loc[0, "b_n"], 1)
        self.assertAlmostEqual(comps.loc[0, "b_med"], np.log(600_000_000 / 60.0))

    def test_a_trade_never_sees_itself_when_used_as_a_training_row(self):
        trades = prepare_trades(pd.DataFrame([trade(9000, 600_000_000), trade(9000 + GAP_DAYS, 660_000_000)]))
        comps = comp_features(build_index(trades), trades)
        self.assertEqual(comps.loc[0, "b_n"], 0)
        self.assertEqual(comps.loc[1, "b_n"], 1)
        self.assertAlmostEqual(comps.loc[1, "b_med"], np.log(600_000_000 / 60.0))


class AnchorTest(unittest.TestCase):
    def setUp(self):
        self.day = 9000
        seen = self.day - GAP_DAYS - 20
        self.trades = prepare_trades(pd.DataFrame(
            [trade(seen, 600_000_000, jibun="10-1")]
            + [trade(seen - offset, 480_000_000, jibun=f"20-{offset}") for offset in range(3)]
            + [trade(seen, 300_000_000, jibun="30-1", dong="나동", area=120.0)]
        ))
        self.index = build_index(self.trades)

    def design(self, **overrides):
        targets = prepare_targets(pd.DataFrame([target(self.day, **overrides)]))
        comps = comp_features(self.index, targets)
        return targets, comps, design_matrix(targets, comps)

    def test_same_building_wins_over_the_neighbourhood(self):
        _, _, design = self.design()
        self.assertEqual(design.loc[0, "basis"], "building_area")
        self.assertAlmostEqual(design.loc[0, "anchor"], np.log(600_000_000 / 60.0))

    def test_unknown_building_falls_back_to_similar_size_in_the_dong(self):
        _, _, design = self.design(jibun="99-9")
        self.assertEqual(design.loc[0, "basis"], "dong_area")
        self.assertAlmostEqual(design.loc[0, "anchor"], np.log(480_000_000 / 60.0))

    def test_too_few_trades_give_no_anchor(self):
        _, _, design = self.design(jibun="99-9", dong="다동")
        self.assertEqual(design.loc[0, "basis"], "sgg_area")
        _, _, empty = self.design(jibun="99-9", dong="다동", area=300.0)
        self.assertEqual(empty.loc[0, "basis"], "sgg")

    def test_value_is_anchor_price_per_m2_times_area(self):
        targets, comps, design = self.design()
        scored = score_targets(ZeroModel(), 0.0, targets, design, comps)
        self.assertAlmostEqual(scored.loc[0, "value"], 600_000_000, delta=1)
        self.assertEqual(scored.loc[0, "building_comps"], 1)

    def test_no_area_means_no_value(self):
        targets, comps, design = self.design(area=None)
        scored = score_targets(ZeroModel(), 0.0, targets, design, comps)
        self.assertTrue(np.isnan(scored.loc[0, "value"]))
        self.assertEqual(scored.loc[0, "basis"], "no_area")


class NameMatchTest(unittest.TestCase):
    def setUp(self):
        self.day = 9000
        rows = [trade(self.day - GAP_DAYS - 20, 200_000_000, area=30.0), trade(self.day - GAP_DAYS - 25, 210_000_000, area=30.0)]
        for row, name in zip(rows, ["센트라움", "센트라움 2차"]):
            row.update({"kind": "offi", "jibun": None, "name": name})
        self.index = build_index(prepare_trades(pd.DataFrame(rows)))

    def comps(self, name: str | None):
        row = target(self.day, area=30.0)
        row.update({"kind": "offi", "jibun": "316-3", "name": name})
        targets = prepare_targets(pd.DataFrame([row]), self.index)
        return targets, comp_features(self.index, targets)

    def test_listing_name_with_a_suffix_matches_the_traded_building(self):
        targets, comps = self.comps("센트라움주건축물")
        self.assertEqual(targets.loc[0, "bkey"], "n:센트라움")
        self.assertEqual(comps.loc[0, "b_n"], 1)

    def test_the_longest_matching_name_wins(self):
        targets, _ = self.comps("센트라움 2차 에이동")
        self.assertEqual(targets.loc[0, "bkey"], "n:센트라움2차")

    def test_unnamed_or_unrelated_listings_stay_unmatched(self):
        for name in (None, "힐스테이트", "센트"):
            _, comps = self.comps(name)
            self.assertEqual(comps.loc[0, "b_n"], 0, name)
            self.assertEqual(comps.loc[0, "d_n"], 2, name)


class ForwardCheckTest(unittest.TestCase):
    def test_only_later_trades_of_the_same_floor_plan_count(self):
        day = 9000
        trades = prepare_trades(pd.DataFrame([
            trade(day - GAP_DAYS - 5, 500_000_000),             # visible to the estimate: not a forward trade
            trade(day - GAP_DAYS + 5, 660_000_000),             # contracted before as_of: not strictly subsequent
            trade(day + 40, 540_000_000),
            trade(day + 40, 900_000_000, area=120.0),           # another floor plan
            trade(day + 400, 990_000_000),                      # beyond the horizon
        ]))
        index = build_index(trades)
        targets = prepare_targets(pd.DataFrame([target(day)]), index)
        estimates = pd.DataFrame({"value": [540_000_000.0]})
        checked = forward_check(index, targets, estimates)
        self.assertEqual(checked["apt"]["rows"], 1)
        # Including the 660m gap trade would pull the median to 600m.
        self.assertAlmostEqual(checked["apt"]["bias"], 0.0)
        self.assertEqual(forward_check(index, targets, estimates, after_day=day + 1), {})


    def test_a_five_percent_larger_unit_is_normalized_and_a_wider_one_is_dropped(self):
        day = 9000
        trades = prepare_trades(pd.DataFrame([
            trade(day + 40, 630_000_000, area=63.0),
            trade(day + 40, 900_000_000, area=70.0),
        ]))
        index = build_index(trades)
        targets = prepare_targets(pd.DataFrame([target(day)]), index)
        estimates = pd.DataFrame({
            "value": [600_000_000.0],
            "value_low": [610_000_000.0],
            "basis": ["building"],
            "calibration_level": ["cell"],
            "cold_start": [False],
        })
        result = forward_exceedance(index, targets, estimates, day + FORWARD_DAYS + GAP_DAYS)
        self.assertEqual(result["confirm_trades"], 1)
        self.assertEqual(result["breach_trades"], 1)
        self.assertEqual(result["breach_denominator"], 1)
        self.assertAlmostEqual(result["similar_size"], 0.05)

    def test_each_later_trade_is_compared_with_the_lower_bound_not_their_median(self):
        day = 9000
        trades = prepare_trades(pd.DataFrame([
            trade(day + 30, 500_000_000),
            trade(day + 60, 600_000_000),
            trade(day + 90, 700_000_000),
            trade(day + 40, 600_000_000, jibun="55-5"),
        ]))
        index = build_index(trades)
        targets = prepare_targets(pd.DataFrame([target(day), target(day, jibun="55-5")]), index)
        estimates = pd.DataFrame({
            "value": [600_000_000.0, 600_000_000.0],
            "value_low": [550_000_000.0, 550_000_000.0],
            "basis": ["building", "building"],
            "calibration_level": ["cell", "cell"],
            "cold_start": [False, False],
        })
        result = forward_exceedance(index, targets, estimates, day + FORWARD_DAYS + GAP_DAYS)
        # The 600m median clears the 550m bound; one of three trades does not.
        self.assertEqual(result["breach_denominator"], 2)
        self.assertEqual(result["confirm_trades"], 4)
        self.assertEqual(result["breach_trades"], 1)
        # Row-weighted: (1/3 + 0) / 2, not 1/4 pooled over trades.
        self.assertAlmostEqual(result["exceedance_rate"], 1 / 6)
        cohort = result["by_cohort"]["apt|building"]
        self.assertEqual(cohort["mature_with_confirm"], 2)
        self.assertAlmostEqual(cohort["exceedance_rate"], 1 / 6)


class PostSaleValueTest(unittest.TestCase):
    def test_only_closed_windows_after_the_sale_are_written(self):
        sale = 9007
        trades = prepare_trades(pd.DataFrame([
            trade(sale, 900_000_000),                 # sale day itself is not after the sale
            trade(sale - 20, 900_000_000),            # before the sale
            trade(sale + 10, 630_000_000, area=63.0),  # +5% unit, scaled to 600m
            trade(sale + 100, 640_000_000),
            trade(sale + 50, 900_000_000, area=70.0),  # another floor plan
            trade(sale + FORWARD_DAYS + 1, 100_000_000),  # after the window
        ]))
        index = build_index(trades)
        rows = [dict(target(sale - 7), court="서울중앙"), dict(target(sale - 7, jibun="99-9"), court="서울중앙")]
        targets = prepare_targets(pd.DataFrame(rows), index)
        closed = sale + FORWARD_DAYS + GAP_DAYS
        self.assertTrue(post_sale_values(index, targets, closed - 1).empty)
        values = post_sale_values(index, targets, closed)
        self.assertEqual(len(values), 2)
        valued = values.iloc[0]
        self.assertEqual(valued["sale_date"], date(sale))
        self.assertEqual(valued["confirms"], 2)
        self.assertAlmostEqual(valued["value"], 620_000_000.0)
        self.assertEqual(valued["window_days"], FORWARD_DAYS)
        empty = values.iloc[1]
        self.assertEqual(empty["confirms"], 0)
        self.assertTrue(np.isnan(empty["value"]))


class StoredBandTest(unittest.TestCase):
    def test_a_negative_offset_cannot_cross_the_median(self):
        quantiles = np.array([[-0.2, 0.0, 0.1]])
        low, mid, high = apply_stored_band(quantiles, np.array([-0.5]), np.array([-0.3]))
        self.assertLessEqual(low[0], mid[0])
        self.assertGreaterEqual(high[0], mid[0])
        self.assertAlmostEqual(low[0], 0.0)
        self.assertAlmostEqual(high[0], 0.0)
        value_low, value, value_high = stored_prices(np.array([100.0]), quantiles, np.array([-0.5]), np.array([-0.3]))
        self.assertLessEqual(value_low[0], value[0])
        self.assertGreaterEqual(value_high[0], value[0])

class BandTest(unittest.TestCase):
    def test_offset_widens_the_band_until_it_covers_the_target_share(self):
        actual = np.linspace(-1.0, 1.0, 201)
        quantiles = np.tile(np.array([-0.1, 0.0, 0.1]), (len(actual), 1))
        offset = conformal_offset(quantiles, actual, coverage=0.8)
        scores = np.maximum(quantiles[:, 0] - actual, actual - quantiles[:, -1])
        rank = int(np.ceil((len(scores) + 1) * 0.8))
        self.assertAlmostEqual(offset, float(np.sort(scores)[min(rank, len(scores)) - 1]))
        covered = ((actual >= -0.1 - offset) & (actual <= 0.1 + offset)).mean()
        self.assertGreaterEqual(covered, 0.8)
        self.assertLess(covered, 0.90)


def _scored_value(anchor: float, area: float, shift: float) -> float:
    return float(np.exp(anchor) * area * np.exp(shift))


def _fit_shift(trades: pd.DataFrame, leak: str, early_cutoff: int):
    seen = []

    def fitter(eligible, design, random_state, min_train, min_calibration):
        seen.append(eligible)
        shift = 0.0 if leak not in set(eligible["marker"]) else 1.0
        return ShiftModel(shift), LowerCalibration.uniform(0.0)

    return fitter, seen


class MonthlyCutoffTest(unittest.TestCase):
    def _bundle(self, extra_rows: list[dict] | None = None, markers: list[str] | None = None):
        start = month_start_day(int((pd.Timestamp("2024-06-15") - EPOCH).days))
        rows = [
            trade(start - 500, 500_000_000),
            trade(start - 200, 600_000_000),
            trade(start - 180, 610_000_000),
            trade(start - 160, 620_000_000),
        ]
        labels = ["origin", "pad", "pad", "pad"]
        if extra_rows:
            rows.extend(extra_rows)
            labels.extend(markers or ["extra"] * len(extra_rows))
        frame = pd.DataFrame(rows)
        frame["marker"] = labels
        trades = prepare_trades(frame)
        index = build_index(trades)
        design = design_matrix(trades, comp_features(index, trades))
        return start, trades, index, design

    def test_a_month_does_not_train_on_trades_known_after_its_start(self):
        start = month_start_day(int((pd.Timestamp("2024-06-15") - EPOCH).days))
        leak = trade(start - 10, 900_000_000)
        start, trades, index, design = self._bundle([leak], ["leak"])
        late_as_of = start + 40
        late_start = month_start_day(late_as_of)
        self.assertGreater(int(trades.loc[trades["marker"] == "leak", "known_day"].iloc[0]), start)
        self.assertLessEqual(int(trades.loc[trades["marker"] == "leak", "known_day"].iloc[0]), late_start)
        targets = prepare_targets(pd.DataFrame([
            target(start + 14),
            target(late_as_of),
        ]), index)
        tcomps = comp_features(index, targets)
        tdesign = design_matrix(targets, tcomps)
        fitter, seen = _fit_shift(trades, "leak", start)
        estimates, _months = value_by_month(
            trades, design, targets, tdesign, tcomps,
            fitter=fitter, min_train=2, min_calibration=1,
        )
        self.assertEqual(len(seen), 2)
        early_fit = next(frame for frame in seen if "leak" not in set(frame["marker"]))
        late_fit = next(frame for frame in seen if "leak" in set(frame["marker"]))
        self.assertLessEqual(int(early_fit["known_day"].max()), start)
        self.assertLessEqual(int(late_fit["known_day"].max()), late_start)
        self.assertAlmostEqual(
            estimates.iloc[0]["value"],
            _scored_value(float(tdesign.iloc[0]["anchor"]), float(targets.iloc[0]["area_m2"]), 0.0),
        )
        self.assertAlmostEqual(
            estimates.iloc[1]["value"],
            _scored_value(float(tdesign.iloc[1]["anchor"]), float(targets.iloc[1]["area_m2"]), 1.0),
        )

    def test_an_early_month_does_not_borrow_a_later_model(self):
        start = month_start_day(int((pd.Timestamp("2024-06-15") - EPOCH).days))
        extras = [trade(start - 15 + i, 400_000_000) for i in range(3)]
        leak = trade(start - 10, 900_000_000)
        start, trades, index, design = self._bundle([leak, *extras], ["leak", "late", "late", "late"])
        targets = prepare_targets(pd.DataFrame([
            target(start + 14),
            target(start + 40),
        ]), index)
        tcomps = comp_features(index, targets)
        tdesign = design_matrix(targets, tcomps)
        self.assertTrue(pd.notna(tdesign.iloc[0]["anchor"]))
        fitter, seen = _fit_shift(trades, "leak", start)
        estimates, months = value_by_month(
            trades, design, targets, tdesign, tcomps,
            fitter=fitter, min_train=4, min_calibration=2,
        )
        self.assertEqual(len(seen), 1)
        self.assertIn("leak", set(seen[0]["marker"]))
        self.assertTrue(pd.isna(estimates.iloc[0]["value"]))
        self.assertTrue(bool(estimates.iloc[0]["cold_start"]))
        self.assertTrue(pd.notna(estimates.iloc[1]["value"]))
        self.assertEqual(months[0]["source"], "cold")
        self.assertEqual(months[1]["source"], "fit")

    def test_a_reported_timestamp_overrides_the_assumed_lag(self):
        start = month_start_day(int((pd.Timestamp("2024-06-15") - EPOCH).days))
        early = trade(start - 10, 700_000_000)
        late = trade(start - 40, 800_000_000)
        frame = pd.DataFrame([
            trade(start - 500, 500_000_000),
            trade(start - 200, 600_000_000),
            trade(start - 180, 610_000_000),
            trade(start - 160, 620_000_000),
            early,
            late,
        ])
        frame["marker"] = ["origin", "pad", "pad", "pad", "early_report", "late_report"]
        frame["reported_at"] = [None, None, None, None, date(start - 1), date(start + 5)]
        trades = prepare_trades(frame)
        early_row = trades[trades["marker"] == "early_report"].iloc[0]
        late_row = trades[trades["marker"] == "late_report"].iloc[0]
        self.assertEqual(int(early_row["known_day"]), start - 1)
        self.assertEqual(int(late_row["known_day"]), start + 5)
        index = build_index(trades)
        design = design_matrix(trades, comp_features(index, trades))
        targets = prepare_targets(pd.DataFrame([target(start + 14)]), index)
        tcomps = comp_features(index, targets)
        tdesign = design_matrix(targets, tcomps)
        fitter, seen = _fit_shift(trades, "late_report", start)
        value_by_month(trades, design, targets, tdesign, tcomps, fitter=fitter, min_train=2, min_calibration=1)
        self.assertEqual(len(seen), 1)
        markers = set(seen[0]["marker"])
        self.assertIn("early_report", markers)
        self.assertNotIn("late_report", markers)

    def test_a_building_name_first_seen_after_the_cutoff_is_not_matched(self):
        as_of = 9000
        past = trade(as_of - GAP_DAYS - 20, 200_000_000, area=30.0)
        past.update({"kind": "offi", "jibun": None, "name": "미래타워"})
        future = trade(as_of + 10, 800_000_000, area=30.0)
        future.update({"kind": "offi", "jibun": None, "name": "신축타워"})
        index = build_index(prepare_trades(pd.DataFrame([past, future])))
        future_name = target(as_of, area=30.0)
        future_name.update({"kind": "offi", "jibun": "316-3", "name": "신축타워"})
        unmatched = prepare_targets(pd.DataFrame([future_name]), index)
        self.assertNotEqual(unmatched.loc[0, "bkey"], "n:신축타워")
        self.assertEqual(comp_features(index, unmatched).loc[0, "b_n"], 0)
        past_name = target(as_of, area=30.0)
        past_name.update({"kind": "offi", "jibun": "316-3", "name": "미래타워"})
        matched = prepare_targets(pd.DataFrame([past_name]), index)
        self.assertEqual(matched.loc[0, "bkey"], "n:미래타워")


class SparseCalibrationTest(unittest.TestCase):
    def test_sparse_cells_fall_back_instead_of_using_their_own_quantile(self):
        scores = np.concatenate([np.full(5, 0.9), np.full(100, 0.1), np.full(3, 0.9)])
        kinds = np.array(["apt"] * 105 + ["rh"] * 3)
        bases = np.array(["building"] * 5 + ["dong"] * 100 + ["sgg"] * 3)
        calibrated = calibrate_lower(kinds, bases, np.zeros(len(scores)), -scores)
        offset, level = calibrated.resolve("apt", "building")
        self.assertEqual(level, "kind")
        self.assertLess(offset, 0.3)
        self.assertAlmostEqual(calibrated.cell[("apt", "building")], 0.9)
        self.assertNotAlmostEqual(offset, 0.9)
        rh_offset, rh_level = calibrated.resolve("rh", "sgg")
        self.assertEqual(rh_level, "global")
        self.assertNotAlmostEqual(rh_offset, 0.9)
        dense = calibrate_lower(
            np.array(["apt"] * 50),
            np.array(["building_area"] * 50),
            np.zeros(50),
            -np.full(50, 0.3),
        )
        dense_offset, dense_level = dense.resolve("apt", "building_area")
        self.assertEqual(dense_level, "cell")
        self.assertAlmostEqual(dense_offset, 0.3)

    def test_a_non_finite_score_does_not_poison_the_cell_quantile(self):
        kinds = np.array(["apt"] * 50)
        bases = np.array(["building"] * 50)
        q_low = np.zeros(50)
        actual = -np.full(50, 0.2)
        actual[0] = np.nan
        calibrated = calibrate_lower(kinds, bases, q_low, actual)
        offset, level = calibrated.resolve("apt", "building")
        self.assertEqual(level, "cell")
        self.assertAlmostEqual(offset, 0.2)
        self.assertEqual(calibrated.cell_n[("apt", "building")], 49)


class LowerBreachTest(unittest.TestCase):
    def test_only_strictly_subsequent_mature_confirms_count(self):
        day = 9000
        trades = prepare_trades(pd.DataFrame([
            trade(day - GAP_DAYS + 5, 200_000_000),
            trade(day + 40, 600_000_000),
            trade(day + 40, 900_000_000, area=120.0),
            trade(day + 400, 100_000_000),
            trade(day + 50, 300_000_000, jibun="55-5"),
        ]))
        index = build_index(trades)
        targets = prepare_targets(pd.DataFrame([
            target(day),
            target(day, jibun="55-5"),
            target(day, jibun="88-8"),
            target(day, jibun="66-6"),
        ]), index)
        estimates = pd.DataFrame({
            "value": [540_000_000.0, 540_000_000.0, 540_000_000.0, np.nan],
            "value_low": [550_000_000.0, 500_000_000.0, 500_000_000.0, np.nan],
            "basis": ["building", "building", "building", "no_comps"],
            "calibration_level": ["cell", "cell", "cell", None],
            "cold_start": [False, False, False, True],
        })
        today = day + FORWARD_DAYS + GAP_DAYS
        result = forward_exceedance(index, targets, estimates, today)
        self.assertEqual(result["breach_denominator"], 2)
        self.assertEqual(result["breach_trades"], 1)
        self.assertEqual(result["confirm_trades"], 2)
        self.assertAlmostEqual(result["exceedance_rate"], 0.5)
        self.assertEqual(result["missing_by_basis"]["no_comps"], 1)
        self.assertGreaterEqual(result["mature_without_confirm"], 1)
        immature = forward_exceedance(index, targets, estimates, day + 10)
        self.assertEqual(immature["breach_denominator"], 0)
        self.assertGreater(immature["immature_with_confirm"], 0)
        self.assertIn("apt", immature["immature_error_by_kind"])

    def test_sparse_evidence_is_not_called_a_breach(self):
        self.assertEqual(cohort_evidence_status(5, 0.5, "cell"), "insufficient_evidence")
        self.assertEqual(cohort_evidence_status(25, 0.32, "cell"), "lower_breach")
        self.assertEqual(cohort_evidence_status(25, 0.20, "cell"), "lower_breach")
        self.assertEqual(cohort_evidence_status(25, 0.10, "cell"), "ok")
        self.assertEqual(cohort_evidence_status(25, 0.10, "kind"), "insufficient_evidence")

    def test_upcoming_review_caps_the_list_and_skips_past_sales(self):
        today = 10000
        rows = []
        for i in range(35):
            rows.append({
                "court": "서울중앙지방법원",
                "case_no": f"2024타경{i:02d}",
                "item_no": "1",
                "sale_date": date(today + 10 + i),
                "kind": "apt",
            })
        rows.append({
            "court": "서울중앙지방법원", "case_no": "past", "item_no": "1",
            "sale_date": date(today - 1), "kind": "apt",
        })
        rows.append({
            "court": "서울중앙지방법원", "case_no": "today-sale", "item_no": "1",
            "sale_date": date(today), "kind": "apt",
        })
        rows.append({
            "court": "서울중앙지방법원", "case_no": "ok-cohort", "item_no": "1",
            "sale_date": date(today + 5), "kind": "rh",
        })
        targets = pd.DataFrame(rows)
        estimates = pd.DataFrame({
            "value": [500.0] * len(rows),
            "basis": ["building"] * (len(rows) - 1) + ["dong"],
            "calibration_level": ["cell"] * len(rows),
            "cold_start": [False] * len(rows),
        })
        exceedance = {"by_cohort": {
            "apt|building": {
                "kind": "apt", "basis": "building", "mature_with_confirm": 25,
                "confirm_trades": 60, "breach_trades": 19, "exceedance_rate": 0.32, "calibration_level": "cell",
                "status": "lower_breach",
            },
            "rh|dong": {
                "kind": "rh", "basis": "dong", "mature_with_confirm": 25,
                "confirm_trades": 60, "breach_trades": 2, "exceedance_rate": 0.04, "calibration_level": "cell",
                "status": "ok",
            },
        }}
        review = upcoming_review(targets, estimates, exceedance, today, cap=30)
        self.assertEqual(review["total"], 35)
        self.assertEqual(review["shown"], 30)
        self.assertEqual(review["cap"], 30)
        cases = [row["case_no"] for row in review["rows"]]
        self.assertNotIn("past", cases)
        self.assertNotIn("today-sale", cases)
        self.assertNotIn("ok-cohort", cases)
        self.assertTrue(all(row["note"].startswith("추가 실거래 확인") for row in review["rows"]))
        self.assertIn("하한 이탈", review["rows"][0]["note"])
        self.assertIn("20건", review["threshold"])
        self.assertIn("10%", review["threshold"])
        self.assertNotIn("20%", review["threshold"])
        self.assertIn("5%", review["evidence"])
        self.assertNotIn("15%", review["evidence"])
        self.assertIn("분모", review["evidence"])


class CacheFingerprintTest(unittest.TestCase):
    @unittest.skipUnless(XGBOOST_AVAILABLE, "native cache roundtrip needs xgboost")
    def test_a_price_change_or_corrupt_fingerprint_refits(self):
        start = month_start_day(int((pd.Timestamp("2024-06-15") - EPOCH).days))
        frame = pd.DataFrame([
            trade(start - 500, 500_000_000),
            trade(start - 200, 600_000_000),
            trade(start - 180, 610_000_000),
            trade(start - 160, 620_000_000),
        ])
        trades = prepare_trades(frame)
        index = build_index(trades)
        design = design_matrix(trades, comp_features(index, trades))
        targets = prepare_targets(pd.DataFrame([target(start + 14)]), index)
        tcomps = comp_features(index, targets)
        tdesign = design_matrix(targets, tcomps)
        calls = []

        def fitter(eligible, eligible_design, random_state, min_train, min_calibration):
            calls.append(len(eligible))
            import xgboost as xgb
            residual = eligible["log_ppm2"].to_numpy() - eligible_design["anchor"].to_numpy()
            model = xgb.XGBRegressor(
                objective="reg:quantileerror",
                quantile_alpha=np.array([0.1, 0.5, 0.9]),
                n_estimators=1,
                max_depth=1,
                n_jobs=1,
                random_state=0,
            )
            model.fit(eligible_design[FEATURES], residual)
            return model, LowerCalibration.uniform(0.0)

        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            decoy = cache / "avm-test" / "1-deadbeefdeadbeefdeadbeef.json"
            decoy.parent.mkdir(parents=True)
            decoy.write_text("{}", encoding="utf-8")
            kwargs = dict(
                fitter=fitter, min_train=2, min_calibration=1,
                cache_dir=cache, cache_version="avm-test",
            )
            value_by_month(trades, design, targets, tdesign, tcomps, **kwargs)
            value_by_month(trades, design, targets, tdesign, tcomps, **kwargs)
            self.assertEqual(calls, [3])
            saved = list((cache / "avm-test").glob("*.json"))
            saved = [path for path in saved if path.name != decoy.name]
            self.assertEqual(len(saved), 1)
            meta = json.loads(saved[0].read_text(encoding="utf-8"))
            meta["fingerprint"] = "corrupt"
            saved[0].write_text(json.dumps(meta), encoding="utf-8")
            value_by_month(trades, design, targets, tdesign, tcomps, **kwargs)
            self.assertEqual(calls, [3, 3])
            changed = trades.copy()
            changed.loc[changed.index[-1], "price"] = float(changed.loc[changed.index[-1], "price"]) + 1
            self.assertNotEqual(
                vintage_fingerprint(trades, design, "avm-test"),
                vintage_fingerprint(changed, design, "avm-test"),
            )
            value_by_month(changed, design, targets, tdesign, tcomps, **kwargs)
            self.assertEqual(calls, [3, 3, 3])

    def test_a_residual_change_moves_the_fingerprint(self):
        start = month_start_day(int((pd.Timestamp("2024-06-15") - EPOCH).days))
        trades = prepare_trades(pd.DataFrame([
            trade(start - 500, 500_000_000),
            trade(start - 200, 600_000_000),
            trade(start - 180, 610_000_000),
        ]))
        design = design_matrix(trades, comp_features(build_index(trades), trades))
        changed = trades.copy()
        changed.loc[changed.index[-1], "log_ppm2"] = float(changed.loc[changed.index[-1], "log_ppm2"]) + 0.01
        self.assertNotEqual(
            vintage_fingerprint(trades, design, "avm-test"),
            vintage_fingerprint(changed, design, "avm-test"),
        )


if __name__ == "__main__":
    unittest.main()
