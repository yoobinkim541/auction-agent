import unittest

import numpy as np
import pandas as pd

from scripts.ml.avm import (
    EPOCH,
    GAP_DAYS,
    WINDOW_DAYS,
    build_index,
    comp_features,
    conformal_offset,
    design_matrix,
    forward_check,
    prepare_targets,
    prepare_trades,
    score_targets,
)


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
            trade(day - GAP_DAYS + 5, 660_000_000),
            trade(day + 40, 540_000_000),
            trade(day + 40, 900_000_000, area=120.0),           # another floor plan
            trade(day + 400, 990_000_000),                      # beyond the horizon
        ]))
        index = build_index(trades)
        targets = prepare_targets(pd.DataFrame([target(day)]), index)
        estimates = pd.DataFrame({"value": [540_000_000.0]})
        checked = forward_check(index, targets, estimates)
        self.assertEqual(checked["apt"]["rows"], 1)
        self.assertAlmostEqual(checked["apt"]["bias"], 540 / 600 - 1)
        self.assertEqual(forward_check(index, targets, estimates, after_day=day + 1), {})


class BandTest(unittest.TestCase):
    def test_offset_widens_the_band_until_it_covers_the_target_share(self):
        actual = np.linspace(-1.0, 1.0, 201)
        quantiles = np.tile(np.array([-0.1, 0.0, 0.1]), (len(actual), 1))
        offset = conformal_offset(quantiles, actual, coverage=0.8)
        covered = ((actual >= -0.1 - offset) & (actual <= 0.1 + offset)).mean()
        self.assertGreaterEqual(covered, 0.8)
        self.assertLess(covered, 0.83)


if __name__ == "__main__":
    unittest.main()
