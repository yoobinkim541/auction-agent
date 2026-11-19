import unittest

import pandas as pd

from scripts.ml.good_listing import (
    DECISION_FAILED_AUCTION,
    DECISION_LABEL_VERSION,
    DECISION_LOSSES,
    DECISION_NO_POST_SALE,
    DECISION_PENDING,
    LABEL_VERSION,
    LEAKY_COLUMNS,
    SKLEARN_AVAILABLE,
    acquisition_tax_rate,
    allowed_features,
    bid_margin,
    conservative_value,
    decision_feature_frame,
    decision_outcomes,
    decision_split,
    eval_shadow_tracking,
    feature_frame,
    floor_margin,
    good_listing_mask,
    labelled_rows,
    net_margin,
    post_sale_margin,
    precision_at_fraction,
    score_eligible,
    score_frozen_decisions,
    tax_at_bid,
    training_eligible,
    training_rows,
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



def decision_row(**overrides) -> dict:
    row = {
        "court": "서울중앙지방법원",
        "case_no": "2026타경1",
        "item_no": "1",
        "sale_date": "2026-10-15",
        "horizon_days": 7,
        "feature_source": "d7",
        "snapshot_version": "feature-v2",
        "observed_on": "2026-10-01",
        "snapped_at": "2026-10-01T00:00:00+09:00",
        "result_captured_at": "2026-10-16T01:00:00Z",
        "trust_evaluated_at": "2026-10-16T02:00:00Z",
        "label_trusted": True,
        "fully_frozen": True,
        "shortlist_eligible": True,
        "comparison_eligible": True,
        "matched": True,
        "sold": True,
        "sold_amount": 250_000_000,
        "result_cd": "001",
        "recommended_bid": 300_000_000,
        "hard_cap_bid": 400_000_000,
        "price_floor": 200_000_000,
        "min_bid_price": 200_000_000,
        "result_min_price": 100_000_000,
        "conservative_value": 500_000_000,
        "post_sale_value": 500_000_000,
        "post_sale_confirms": 3,
        "post_sale_window_days": 180,
        "target_margin_pct": 0.10,
        "assumed_amount": 0,
        "move_out_cost": 2_000_000,
        "bond_cost": 1_000_000,
        "etc_cost": 0,
        "acq_tax_rate_pct": 1.1,
        "cost_bid_price": 300_000_000,
        "property_type": "apartment",
        "area_m2": 60,
        "appraisal_value": 500_000_000,
    }
    row.update(overrides)
    return row


class PostSaleMarginDecisionTest(unittest.TestCase):
    def test_legacy_label_version_stays_on_the_exploratory_model(self):
        self.assertEqual(LABEL_VERSION, "net-margin-v1")
        self.assertEqual(DECISION_LABEL_VERSION, "post-sale-margin-v3")
        self.assertNotIn(DECISION_FAILED_AUCTION, DECISION_LOSSES)
        self.assertNotIn("failed", DECISION_LOSSES)
        self.assertNotIn(DECISION_PENDING, DECISION_LOSSES)
        self.assertNotIn(DECISION_NO_POST_SALE, DECISION_LOSSES)

    def test_hit_requires_a_strict_clear_inside_the_frozen_bounds(self):
        frame = pd.DataFrame([decision_row()])
        self.assertEqual(decision_outcomes(frame).tolist(), ["hit"])
        self.assertGreater(float(post_sale_margin(frame).iloc[0]), 0.10)

    def test_label_grades_against_the_post_sale_value_not_the_frozen_value(self):
        # The frozen value promises a 38% margin; later same-unit trades leave under 10%.
        frame = pd.DataFrame([decision_row(post_sale_value=340_000_000)])
        self.assertGreater(float(bid_margin(frame).iloc[0]), 0.30)
        self.assertLess(float(post_sale_margin(frame).iloc[0]), 0.10)
        self.assertEqual(decision_outcomes(frame).tolist(), ["below_target"])
        richer = pd.DataFrame([decision_row(conservative_value=310_000_000, post_sale_value=500_000_000)])
        self.assertLess(float(bid_margin(richer).iloc[0]), 0.10)
        self.assertEqual(decision_outcomes(richer).tolist(), ["hit"])

    def test_open_window_is_pending_and_an_empty_window_is_no_post_sale(self):
        pending = pd.DataFrame([decision_row(post_sale_value=None, post_sale_confirms=None, post_sale_window_days=None)])
        self.assertEqual(decision_outcomes(pending).tolist(), ["pending"])
        self.assertFalse(bool(training_eligible(pending).iloc[0]))
        empty = pd.DataFrame([decision_row(post_sale_value=None, post_sale_confirms=0)])
        self.assertEqual(decision_outcomes(empty).tolist(), ["no_post_sale"])
        self.assertFalse(bool(training_eligible(empty).iloc[0]))

    def test_outbid_and_invalid_bids_do_not_wait_for_the_post_sale_window(self):
        rows = [
            decision_row(recommended_bid=200_000_000, sold_amount=250_000_000, post_sale_value=None, post_sale_window_days=None),
            decision_row(recommended_bid=450_000_000, sold_amount=250_000_000, post_sale_value=None, post_sale_window_days=None),
        ]
        self.assertEqual(decision_outcomes(pd.DataFrame(rows)).tolist(), ["outbid", "invalid_bid"])

    def test_equal_rounded_bid_is_a_tie_not_a_loss(self):
        frame = pd.DataFrame([decision_row(sold_amount=300_000_000)])
        self.assertEqual(decision_outcomes(frame).tolist(), ["tie"])

    def test_bid_below_the_sold_amount_is_outbid_even_if_also_below_the_floor(self):
        frame = pd.DataFrame([decision_row(recommended_bid=250_000_000, sold_amount=390_000_000, price_floor=300_000_000)])
        self.assertEqual(decision_outcomes(frame).tolist(), ["outbid"])

    def test_bid_above_the_sale_but_outside_the_frozen_floor_is_invalid(self):
        frame = pd.DataFrame([decision_row(
            recommended_bid=250_000_000,
            sold_amount=200_000_000,
            price_floor=300_000_000,
            min_bid_price=200_000_000,
            result_min_price=100_000_000,
        )])
        self.assertEqual(decision_outcomes(frame).tolist(), ["invalid_bid"])

    def test_floor_audit_is_not_the_minimum_bid_constraint(self):
        frame = pd.DataFrame([decision_row(
            price_floor=None,
            recommended_bid=250_000_000,
            sold_amount=200_000_000,
            min_bid_price=300_000_000,
            result_min_price=100_000_000,
        )])
        self.assertEqual(decision_outcomes(frame).tolist(), ["invalid_bid"])

    def test_short_margin_is_below_target_not_a_hit(self):
        frame = pd.DataFrame([decision_row(target_margin_pct=0.90)])
        self.assertEqual(decision_outcomes(frame).tolist(), ["below_target"])

    def test_missing_assumed_amount_is_unknown_not_zero(self):
        frame = pd.DataFrame([decision_row(assumed_amount=None)])
        self.assertTrue(pd.isna(bid_margin(frame).iloc[0]))
        self.assertEqual(decision_outcomes(frame).tolist(), ["abstain"])

    def test_explicit_zero_assumed_amount_is_usable(self):
        frame = pd.DataFrame([decision_row(assumed_amount=0)])
        self.assertEqual(decision_outcomes(frame).tolist(), ["hit"])

    def test_missing_target_margin_is_not_filled_with_the_evaluator_default(self):
        frame = pd.DataFrame([decision_row(target_margin_pct=None)])
        self.assertEqual(decision_outcomes(frame).tolist(), ["abstain"])

    def test_confirmed_failed_auction_is_not_a_loss(self):
        frame = pd.DataFrame([decision_row(result_cd="002", sold=False, sold_amount=None, recommended_bid=500_000_000)])
        self.assertEqual(decision_outcomes(frame).tolist(), ["failed_auction"])
        self.assertNotIn("failed_auction", DECISION_LOSSES)

    def test_result_codes_normalize_and_unmapped_codes_stay_unknown(self):
        rows = [
            decision_row(result_cd="2", sold=False, sold_amount=None),
            decision_row(result_cd="002.0", sold=False, sold_amount=None),
            decision_row(result_cd="유찰", sold=False, sold_amount=None),
            decision_row(result_cd="003", sold=False, sold_amount=None),
            decision_row(result_cd="001", sold=False, sold_amount=250_000_000),
            decision_row(result_cd=None, outcome_kind="취하", sold=False, sold_amount=None),
            decision_row(result_cd=None, matched=False, sold=None, sold_amount=None),
        ]
        self.assertEqual(decision_outcomes(pd.DataFrame(rows)).tolist(), [
            "failed_auction",
            "failed_auction",
            "unknown",
            "unknown",
            "unknown",
            "unknown",
            "missing",
        ])

    def test_missing_assumed_below_the_sale_is_abstain_not_outbid(self):
        frame = pd.DataFrame([decision_row(
            assumed_amount=None,
            recommended_bid=100_000_000,
            sold_amount=250_000_000,
        )])
        self.assertEqual(decision_outcomes(frame).tolist(), ["abstain"])
        self.assertFalse(bool(training_eligible(frame).iloc[0]))

    def test_outcome_trust_status_does_not_widen_label_trusted(self):
        frame = pd.DataFrame([decision_row(label_trusted=False, outcome_trust_status="trusted")])
        self.assertFalse(bool(training_eligible(frame).iloc[0]))
        self.assertTrue(bool(training_eligible(pd.DataFrame([decision_row()])).iloc[0]))

    def test_blank_source_or_snapshot_mismatch_is_not_trainable(self):
        self.assertFalse(bool(training_eligible(pd.DataFrame([decision_row(feature_source="")])).iloc[0]))
        self.assertFalse(bool(training_eligible(pd.DataFrame([decision_row(feature_source="d1", horizon_days=7)])).iloc[0]))
        self.assertFalse(bool(training_eligible(pd.DataFrame([decision_row(snapshot_version="legacy")])).iloc[0]))
        self.assertFalse(bool(training_eligible(pd.DataFrame([decision_row(fully_frozen=False)])).iloc[0]))
        self.assertFalse(bool(training_eligible(pd.DataFrame([decision_row(comparison_eligible=False)])).iloc[0]))
        conditional = decision_row(shortlist_eligible=False, comparison_eligible=True)
        self.assertTrue(bool(training_eligible(pd.DataFrame([conditional])).iloc[0]))

    def test_null_attention_is_imputed_and_confidence_keeps_its_order(self):
        frame = pd.DataFrame([decision_row(inq_cnt=None, interest_cnt=None, market_confidence=None, precision_confidence="high")])
        built = decision_feature_frame(frame)
        self.assertTrue(pd.isna(built.loc[0, "inq_cnt"]))
        self.assertEqual(built.loc[0, "market_confidence"], "unknown")
        self.assertEqual(float(built.loc[0, "precision_confidence_rank"]), 3.0)
        missing = decision_feature_frame(pd.DataFrame([decision_row(precision_confidence="n/a")]))
        self.assertTrue(pd.isna(missing.loc[0, "precision_confidence_rank"]))

    def test_score_eligible_requires_frozen_provenance_and_known_rights(self):
        self.assertTrue(bool(score_eligible(pd.DataFrame([decision_row()])).iloc[0]))
        self.assertFalse(bool(score_eligible(pd.DataFrame([decision_row(assumed_amount=None)])).iloc[0]))
        self.assertFalse(bool(score_eligible(pd.DataFrame([decision_row(fully_frozen=False)])).iloc[0]))
        row = decision_row()
        del row["fully_frozen"]
        self.assertFalse(bool(score_eligible(pd.DataFrame([row])).iloc[0]))

    def test_tax_is_recomputed_at_our_bid_and_not_added_to_the_frozen_bundle(self):
        frame = pd.DataFrame([decision_row(
            recommended_bid=400_000_000,
            cost_bid_price=300_000_000,
            acq_tax=3_300_000,
            fixed_costs=6_300_000,
            sold_amount=200_000_000,
        )])
        self.assertAlmostEqual(float(bid_margin(frame).iloc[0]), 0.1852, places=4)
        self.assertNotAlmostEqual(float(bid_margin(frame).iloc[0]), 0.1786, places=3)

    def test_same_price_keeps_the_frozen_tax_instead_of_recomputing(self):
        frame = pd.DataFrame([decision_row(
            recommended_bid=300_000_000,
            cost_bid_price=300_000_000,
            acq_tax=9_999_000,
            acq_tax_rate_pct=12.4,
        )])
        self.assertAlmostEqual(float(tax_at_bid(frame).iloc[0]), 9_999_000)


    def test_fixed_costs_recover_nontax_only_when_components_are_missing(self):
        frame = pd.DataFrame([decision_row(
            recommended_bid=400_000_000,
            cost_bid_price=300_000_000,
            acq_tax=3_300_000,
            fixed_costs=6_300_000,
            move_out_cost=None,
            bond_cost=None,
            sold_amount=200_000_000,
        )])
        self.assertAlmostEqual(float(bid_margin(frame).iloc[0]), 0.1852, places=4)

    def test_missing_move_out_without_a_frozen_bundle_abstains(self):
        frame = pd.DataFrame([decision_row(move_out_cost=None, fixed_costs=None, acq_tax=None)])
        self.assertTrue(pd.isna(bid_margin(frame).iloc[0]))
        self.assertEqual(decision_outcomes(frame).tolist(), ["abstain"])

    def test_bracket_mismatch_does_not_invent_a_tax_rate(self):
        frame = pd.DataFrame([decision_row(acq_tax_rate_pct=2.5, cost_bid_price=300_000_000, recommended_bid=400_000_000)])
        self.assertTrue(pd.isna(tax_at_bid(frame).iloc[0]))
        self.assertEqual(decision_outcomes(frame).tolist(), ["abstain"])

    def test_flat_frozen_rate_moves_to_our_bid(self):
        frame = pd.DataFrame([decision_row(
            property_type="land",
            acq_tax_rate_pct=12.4,
            cost_bid_price=200_000_000,
            recommended_bid=350_000_000,
            acq_tax=None,
            sold_amount=200_000_000,
            hard_cap_bid=400_000_000,
            price_floor=200_000_000,
        )])
        rate = acquisition_tax_rate(pd.Series(["land"]), pd.Series([350_000_000.0]), pd.Series([60.0]))
        self.assertGreater(float(rate.iloc[0]), 0.04)
        self.assertAlmostEqual(float(tax_at_bid(frame).iloc[0]), 43_400_000)

    def test_features_exclude_the_outcome_and_the_floor_audit(self):
        frame = pd.DataFrame([decision_row(fail_count=4, total_score=90, sold_amount=250_000_000)])
        built = decision_feature_frame(frame)
        self.assertFalse(LEAKY_COLUMNS.intersection(built.columns))
        self.assertNotIn("result_min_price", built.columns)
        self.assertNotIn("sold_amount", built.columns)
        self.assertAlmostEqual(float(built.loc[0, "price_floor"]), 200_000_000)

    def test_single_freeze_day_does_not_fall_back_to_row_order(self):
        frame = pd.DataFrame([
            decision_row(case_no="A", observed_on="2026-10-01", snapped_at="2026-10-01T00:00:00+09:00"),
            decision_row(case_no="B", sold_amount=480_000_000, recommended_bid=300_000_000, observed_on="2026-10-01", snapped_at="2026-10-01T09:00:00+09:00"),
        ])
        train, test, reason = decision_split(frame)
        self.assertEqual(reason, "single_freeze_day")
        self.assertTrue(train.empty)
        self.assertTrue(test.empty)

    def test_result_known_after_the_later_freeze_is_not_trainable(self):
        frame = pd.DataFrame([
            decision_row(
                case_no="A",
                observed_on="2026-10-01",
                snapped_at="2026-10-01T00:00:00+09:00",
                sale_date="2026-10-10",
                result_captured_at="2026-10-20T00:00:00Z",
                trust_evaluated_at="2026-10-20T01:00:00Z",
            ),
            decision_row(
                case_no="B",
                sold_amount=480_000_000,
                recommended_bid=300_000_000,
                observed_on="2026-10-08",
                snapped_at="2026-10-08T00:00:00+09:00",
                sale_date="2026-10-18",
                result_captured_at="2026-10-21T00:00:00Z",
                trust_evaluated_at="2026-10-21T01:00:00Z",
            ),
        ])
        train, test, reason = decision_split(frame)
        self.assertEqual(reason, "no_earlier_known_result")
        self.assertTrue(train.empty)
        self.assertTrue(test.empty)

    def test_same_case_is_purged_from_training(self):
        train = pd.DataFrame([decision_row(case_no="SAME", item_no="1.0")])
        predict = pd.DataFrame([decision_row(
            case_no="SAME",
            item_no="1",
            observed_on="2027-06-01",
            snapped_at="2027-06-01T00:00:00+09:00",
            sale_date="2027-06-10",
        )])
        self.assertTrue(training_rows(train, predict).empty)

    def test_label_known_after_the_post_sale_window_closes_can_train(self):
        train = pd.DataFrame([
            decision_row(case_no="PAST"),
            decision_row(case_no="LOST", recommended_bid=200_000_000, sold_amount=250_000_000),
        ])
        # Sold 2026-10-15; the window closes at 2026-10-15 + 180 + 30 days = 2027-05-13 KST.
        early = pd.DataFrame([decision_row(case_no="NEXT", observed_on="2027-05-12", snapped_at="2027-05-12T00:00:00+09:00", sale_date="2027-05-20")])
        self.assertTrue(training_rows(train, early).empty)
        late = pd.DataFrame([decision_row(case_no="NEXT", observed_on="2027-05-14", snapped_at="2027-05-14T00:00:00+09:00", sale_date="2027-05-20")])
        self.assertEqual(training_rows(train, late)["case_no"].tolist(), ["PAST", "LOST"])

    def test_missing_result_timestamps_abstain_instead_of_scoring(self):
        rows = [decision_row(case_no=str(i), result_captured_at=None, trust_evaluated_at=None) for i in range(6)]
        predict = pd.DataFrame([decision_row(case_no="NEXT", observed_on="2027-06-01", snapped_at="2027-06-01T00:00:00+09:00", sale_date="2027-06-10")])
        self.assertIsNone(score_frozen_decisions(pd.DataFrame(rows), predict))

    @unittest.skipUnless(SKLEARN_AVAILABLE, "scikit-learn missing")
    def test_score_fits_each_horizon_without_leaking_later_results(self):
        rows = []
        for index in range(100):
            hit = index % 2 == 0
            rows.append(decision_row(
                case_no=f"2026타경{index}",
                recommended_bid=280_000_000 if hit else 300_000_000,
                sold_amount=200_000_000 if hit else 480_000_000,
                appraisal_value=480_000_000 + index,
            ))
        predict = pd.DataFrame([
            decision_row(case_no="NEXT", observed_on="2027-06-01", snapped_at="2027-06-01T00:00:00+09:00", sale_date="2027-06-10", feature_source="d7"),
            decision_row(case_no="HELD", observed_on="2027-06-01", snapped_at="2027-06-01T00:00:00+09:00", sale_date="2027-06-10", comparison_eligible=False),
            decision_row(case_no="COND", observed_on="2027-06-01", snapped_at="2027-06-01T00:00:00+09:00", sale_date="2027-06-10", shortlist_eligible=False),
            decision_row(case_no="LATEST", observed_on="2027-06-01", snapped_at="2027-06-01T00:00:00+09:00", sale_date="2027-06-10", feature_source="latest", horizon_days=7),
            decision_row(case_no="D1", observed_on="2027-06-02", snapped_at="2027-06-02T00:00:00+09:00", sale_date="2027-06-09", feature_source="d1", horizon_days=1),
        ])
        scored = score_frozen_decisions(pd.DataFrame(rows), predict, random_state=0)
        self.assertIsNotNone(scored)
        self.assertEqual(list(scored.columns), ["court", "case_no", "item_no", "sale_date", "horizon_days", "probability"])
        self.assertEqual(scored["case_no"].tolist(), ["NEXT", "COND"])
        self.assertTrue(scored["probability"].between(0, 1).all())
        self.assertIsNone(score_frozen_decisions(pd.DataFrame(rows[:10]), predict))



if __name__ == "__main__":
    unittest.main()
