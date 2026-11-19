import unittest

import pandas as pd

from scripts.ml.weekly_shortlist import render, selections


class WeeklySelectionsTest(unittest.TestCase):
    def test_later_observations_cannot_displace_committed_slots(self):
        rows = pd.DataFrame({
            'court': ['서울'] * 9, 'case_no': list('ABCDEFGHI'),
            'decision_time': ['2026-11-09'] * 8 + ['2026-11-10'],
            'sale_date': ['2026-11-10'] * 8 + ['2026-11-11'],
            'listing_id': range(9), 'confidence_rank': [3] * 9,
            'price_gap': [900, 800, 700, 600, 500, 400, 300, 200, 1000],
            'p': [None, .2, .3, .4, .5, .6, .7, .8, .99], 'shortlist_eligible': [True] * 9,
        })
        self.assertEqual(selections(rows, None).case_no.tolist(), list('ABCDEFG'))
        self.assertEqual(selections(rows, 'p').case_no.tolist(), list('HGFEDCB'))

    def test_case_number_is_only_unique_within_court_and_abstention_does_not_fill(self):
        rows = pd.DataFrame({
            'court': ['서울', '서울', '수원', '수원'], 'case_no': ['A', 'A', 'A', 'B'],
            'decision_time': ['2026-11-09'] * 4, 'sale_date': ['2026-11-10'] * 4,
            'listing_id': [1, 2, 3, 4], 'confidence_rank': [2, 3, 3, 3],
            'price_gap': [100, 50, 70, 80], 'p': [.8, .5, .3, None], 'shortlist_eligible': [True] * 4,
        })
        self.assertEqual(selections(rows, None).listing_id.tolist(), [4, 3, 2])
        self.assertEqual(selections(rows, 'p').listing_id.tolist(), [1, 3])

    def test_current_order_sees_only_the_shortlist_and_others_see_the_pool(self):
        rows = pd.DataFrame({
            'court': ['서울'] * 3, 'case_no': list('ABC'), 'decision_time': ['2026-11-09'] * 3,
            'sale_date': ['2026-11-10'] * 3, 'listing_id': [1, 2, 3], 'confidence_rank': [3] * 3,
            'price_gap': [100, 200, 300], 'p': [.1, .9, .5], 'shortlist_eligible': [True, False, True],
        })
        self.assertEqual(selections(rows, None).case_no.tolist(), ['C', 'A'])
        self.assertEqual(selections(rows, 'p').case_no.tolist(), ['B', 'C', 'A'])

    def test_only_trusted_clearing_prices_count_after_selection(self):
        base = dict(court="서울", item_no="1", sale_date="2026-11-10", snapped_at="2026-11-09T00:00:00Z",
                    observed_on="2026-11-09", feature_source="d1", fully_frozen=True, horizon_days=1,
                    precision_status="recommended", precision_confidence="high", trust_status="trusted",
                    snapshot_version="feature-v2", shortlist_eligible=True, comparison_eligible=True, assumed_amount=0,
                    conservative_value=200_000_000, min_bid_price=90_000_000, price_floor=90_000_000,
                    recommended_bid=100_000_000, hard_cap_bid=120_000_000, result_min_price=90_000_000,
                    cost_bid_price=100_000_000, acq_tax=1_100_000, move_out_cost=0, bond_cost=0, etc_cost=0,
                    target_margin_pct=.15, costs_captured=True, property_type="apartment", matched=True,
                    result_cd="001", sold=True, label_trusted=True, sold_amount=95_000_000,
                    outcome_trust_status="trusted", shadow_good_probability=None,
                    post_sale_value=200_000_000, post_sale_window_days=180)
        cases = [{}, {"sold_amount": 105_000_000}, {"sold_amount": 100_000_000},
                 {"label_trusted": False}, {"matched": False, "sold": None, "sold_amount": None, "result_cd": None},
                 {"sold": False, "sold_amount": None, "result_cd": "002"}, {"snapshot_version": None},
                 {"post_sale_value": None, "post_sale_window_days": None},
                 {"shortlist_eligible": False, "conservative_value": 300_000_000}]
        data = pd.DataFrame([{**base, **changes, "case_no": str(i), "listing_id": i} for i, changes in enumerate(cases)])
        report = render(data)
        self.assertIn("| 현행 정밀 | 8 | 7 | 7 | 6 | 2 | 1 | 2 | 1 | 1 | 50% |", report)
        self.assertIn("| 예상 순마진율 | 8 | 8 | 7 | 6 | 2 | 0 | 3 | 2 | 1 | 67% |", report)
        self.assertIn("| ML | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |", report)
        self.assertIn("순서 비교 가능한 주·시점: 1/1", report)

        small = render(data[data.case_no != "8"])
        self.assertIn("| 현행 정밀 | 7 (순서 비교 불가) |", small)
        self.assertIn("순서 비교 가능한 주·시점: 0/1", small)
