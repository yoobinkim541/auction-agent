#!/usr/bin/env python3
"""Report-only classifier for listings that sell with a real net margin.

The label is known only after the sale. A listing is good when it sold and
the winner kept at least ``GOOD_MARGIN`` of a conservative market value after
costs:

    net_margin = (V - W - assumed - tax(W) - move_out - bond) / V

``V`` is the low end of the 80% band of the report-only market value model
(gm_avm_estimates, fixed seven days before the sale), capped by the appraisal.
The band is wide where comparables are thin, so a villa valued from its
neighbourhood needs a deeper discount than an apartment valued from its own
building. With the point estimate instead, 63% of sold listings pass and the
label is close to "it sold". ``W`` is the winning bid. Rows without ``V`` have
no label and are left out: calling them "not good" would teach the model that
missing comparables mean a bad listing.

Inputs are limited to what a buyer can see before the sale date. The current
score, recommendation and expected bid are excluded because old prediction
snapshots were rewritten after the auction; ``fail_count`` is excluded because
the latest listing row counts the rounds that failed afterwards.

That net-margin label is exploratory only. Weekly review and the decision
model use ``DECISION_LABEL_VERSION`` (post-sale-margin-v3): the frozen
recommended bid is strictly above the sold amount, inside the frozen floor and
hard cap, and still leaves the frozen target margin after tax at that bid when
the value is the post-sale market value — the median of same-building
same-floor-plan trades in the 180 days after the sale (gm_post_sale_values).
The frozen conservative value is not the label value: the recommended bid is
derived from it, so it would grade the bid against its own input. A winning
bid whose post-sale window is still open is ``pending``; a closed window with
no such trade is ``no_post_sale``. Neither is a loss. Ties are indeterminate.
Missing, withdrawn, changed and unknown results are not losses. A confirmed
유찰 is result code 002 only, and it is not a loss. Court text and outcome
kind columns are not read. A missing assumed amount is unknown, not zero, and
is not trained as outbid. Training requires ``label_trusted`` exactly true,
``fully_frozen``, the frozen comparison pool, and a feature-v2 snapshot whose
source matches the horizon. Every label counts as known only after the
post-sale window closes, so recent outbid rows do not train ahead of their
matching hits.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np
import pandas as pd

try:
    from sklearn.compose import ColumnTransformer
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import average_precision_score, roc_auc_score
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, StandardScaler

    SKLEARN_AVAILABLE = True
except Exception:
    SKLEARN_AVAILABLE = False

GOOD_MARGIN = 0.10
LABEL_VERSION = "net-margin-v1"
MODEL_NAME = "good-listing"
MODEL_VERSION = "good-listing-v3"
DECISION_LABEL_VERSION = "post-sale-margin-v3"
POST_SALE_WINDOW_DAYS = 180          # avm.POST_SALE_DAYS
POST_SALE_REPORT_GAP_DAYS = 30       # avm.GAP_DAYS; a window counts as known only after this delay
SNAPSHOT_VERSION = "feature-v2"
EVALUATOR_DEFAULT_TARGET_MARGIN = 0.15  # live persist default; never filled in when the frozen column is null
MIN_TRAIN_ROWS = 80
MIN_TEST_ROWS = 20
MIN_CLASS_ROWS = 30
DEFAULT_MOVE_OUT_COST = 1_500_000
ASSUMED_PARSE_ERROR_MULTIPLE = 10
POINT_IN_TIME_SOURCES = ("d7", "d1")   # inputs frozen before the sale; anything else is the latest row
FLAT_TAX_RATE_PCT = 4.0               # at or above this, the frozen rate is not the 1–3% housing bracket
TAX_RATE_MATCH_PP = 0.05
DECISION_HIT = "hit"
DECISION_OUTBID = "outbid"
DECISION_BELOW_TARGET = "below_target"
DECISION_INVALID_BID = "invalid_bid"
DECISION_TIE = "tie"
DECISION_FAILED_AUCTION = "failed_auction"
DECISION_WITHDRAWN = "withdrawn"
DECISION_CHANGED = "changed"
DECISION_MISSING = "missing"
DECISION_UNKNOWN = "unknown"
DECISION_ABSTAIN = "abstain"
DECISION_PENDING = "pending"          # winning bid, post-sale window not closed or not recorded yet
DECISION_NO_POST_SALE = "no_post_sale"  # window closed with no same-building same-floor-plan trade
DECISION_LOSSES = (DECISION_OUTBID, DECISION_BELOW_TARGET, DECISION_INVALID_BID)
DECISION_UNRESOLVED = (
    DECISION_TIE, DECISION_FAILED_AUCTION, DECISION_WITHDRAWN, DECISION_CHANGED,
    DECISION_MISSING, DECISION_UNKNOWN, DECISION_ABSTAIN, DECISION_PENDING, DECISION_NO_POST_SALE,
)
DECISION_OUTCOMES = (DECISION_HIT, *DECISION_LOSSES, *DECISION_UNRESOLVED)
DECISION_NUMERIC = [
    "appraisal_value", "price_floor", "area_m2", "is_collective_building",
    "recommended_bid", "hard_cap_bid", "conservative_value", "target_margin_pct",
    "bid_to_value", "floor_to_value", "assumed_to_value",
    "move_out_cost", "bond_cost", "etc_cost",
    "avm_value", "avm_band_width", "avm_building_comps",
    "inq_cnt", "interest_cnt", "has_opposition_tenant",
    "precision_confidence_rank",
]
DECISION_CATEGORICAL = [
    "property_type", "court", "region", "avm_basis", "risk_grade",
    "market_confidence", "target_margin_source",
]
CONFIDENCE_RANK = {"high": 3.0, "medium": 2.0, "low": 1.0}

# Known before the sale. The price inputs are the listing's floor and the market value, never the winning bid.
PRICE_FEATURES = [
    "appraisal_value",
    "min_bid_price",
    "min_bid_ratio",
    "area_m2",
    "is_collective_building",
    "avm_value",
    "min_to_avm",
    "min_to_conservative",
    "avm_to_appraisal",
    "avm_band_width",
    "avm_building_comps",
]
RIGHTS_FEATURES = ["assumed_to_avm", "has_opposition_tenant"]
# View and bookmark counts. Rows without a D-7/D-1 snapshot carry counts read after the sale, so these stay out
# of the scoring model until snapshot rows dominate the training set; they are only compared in the report.
ATTENTION_FEATURES = ["inq_cnt", "interest_cnt"]
NUMERIC_FEATURES = PRICE_FEATURES + RIGHTS_FEATURES
CATEGORICAL_FEATURES = ["property_type", "court", "region", "avm_basis", "risk_grade"]
FLAG_FEATURES = {"has_opposition_tenant", "is_collective_building"}

# Post-sale outcomes, or pre-sale fields that reconstruct the outcome.
LEAKY_COLUMNS = frozenset({
    "true_margin",
    "expected_bid",
    "market_price",
    "expected_to_appraisal",
    "expected_to_min",
    "market_to_appraisal",
    "market_to_min",
    "sale_ratio",
    "sold_amount",
    "realized_bid_margin",
    "post_sale_value",
    "post_sale_margin",
    "post_sale_confirms",
    "post_sale_window_days",
    "net_margin",
    "residual",
    "residual_pct",
    "would_have_won_under_max_safe_bid",
    "passed_filter",
    "total_score",
    "recommendation",
    "fail_count",
    "shadow_good_probability",
    "sold",
    "matched",
    "positive_margin",
    "good",
    "result_min_price",
    "result_cd",
    "result_captured_at",
    "trust_evaluated_at",
    "outcome_trust_status",
    "decision_outcome",
    "floor_audit",
    "min_bid_mismatch",
})


def allowed_features(numeric: Iterable[str] = NUMERIC_FEATURES, categorical: Iterable[str] = CATEGORICAL_FEATURES) -> list[str]:
    features = [*numeric, *categorical]
    overlap = LEAKY_COLUMNS.intersection(features)
    if overlap:
        raise RuntimeError(f"good-listing features overlap the label: {sorted(overlap)}")
    return features


def _number(frame: pd.DataFrame, name: str) -> pd.Series:
    if name not in frame.columns:
        return pd.Series(np.nan, index=frame.index, dtype=float)
    return pd.to_numeric(frame[name], errors="coerce")


def acquisition_tax_rate(property_type: pd.Series, price: pd.Series, area_m2: pd.Series) -> pd.Series:
    """Acquisition tax plus surtaxes as a fraction of the price.

    Same base case as ``acquisitionTaxRate`` in pipeline/cost/acquisition.ts: an
    individual buying a first home pays 1-3% by price; anything else pays 4.6%.
    """
    base = (price / 1e8 * 2 / 3 - 3).clip(lower=1.0, upper=3.0)
    housing = base * 1.1 + np.where(area_m2 > 85, 0.2, 0.0)
    is_housing = property_type.isin(["apartment", "villa", "house"])
    return pd.Series(np.where(is_housing, housing, 4.6), index=price.index) / 100


def sane_assumed_amount(frame: pd.DataFrame) -> pd.Series:
    """Rights the buyer takes over. NaN only for amounts no property could carry.

    A senior tenant's deposit can exceed the appraisal, and that is a real loss the label must see.
    Only amounts far beyond the property's worth are parse errors (digits of two amounts joined).
    """
    assumed = _number(frame, "assumed_amount").fillna(0.0)
    ceiling = pd.concat([_number(frame, "appraisal_value"), _number(frame, "avm_value")], axis=1).max(axis=1)
    return assumed.where(~(assumed > ceiling * ASSUMED_PARSE_ERROR_MULTIPLE))


def conservative_value(frame: pd.DataFrame) -> pd.Series:
    """Low end of the market value band, never above the appraisal. NaN without a market value."""
    low = _number(frame, "avm_low")
    appraisal = _number(frame, "appraisal_value").where(lambda series: series > 0)
    return pd.concat([low, appraisal], axis=1).min(axis=1).where(low > 0)


def net_margin(frame: pd.DataFrame) -> pd.Series:
    """Winner's margin against the conservative value after tax and costs. NaN when it cannot be computed."""
    value = conservative_value(frame)
    sold_amount = _number(frame, "sold_amount")
    property_type = frame["property_type"] if "property_type" in frame.columns else pd.Series("", index=frame.index)
    tax = sold_amount * acquisition_tax_rate(property_type, sold_amount, _number(frame, "area_m2"))
    costs = sane_assumed_amount(frame) + tax + _number(frame, "move_out_cost").fillna(DEFAULT_MOVE_OUT_COST) + _number(frame, "bond_cost").fillna(0.0)
    return ((value - sold_amount - costs) / value).where(value > 0)


def floor_margin(frame: pd.DataFrame) -> pd.Series:
    """Net margin if the listing sold at its minimum bid: the most a winner could keep."""
    return net_margin(frame.assign(sold_amount=_number(frame, "min_bid_price")))


def labelled_rows(frame: pd.DataFrame) -> pd.Series:
    """Rows whose label can be trusted: a market value exists and the assumed amount is usable."""
    return conservative_value(frame).notna() & sane_assumed_amount(frame).notna()


def good_listing_mask(frame: pd.DataFrame, margin: float = GOOD_MARGIN) -> pd.Series:
    """Sold, and the winner kept at least ``margin`` of the conservative value after costs."""
    sold = frame["sold"].fillna(False).astype(bool) if "sold" in frame.columns else pd.Series(False, index=frame.index)
    return sold & (net_margin(frame) >= margin)


def _numeric_flag(series: pd.Series) -> pd.Series:
    if series.dtype == bool:
        return series.astype(float)
    text = series.astype(str).str.lower()
    flagged = text.isin(["true", "t", "1", "yes", "y"])
    numeric = pd.to_numeric(series, errors="coerce")
    return numeric.where(numeric.notna(), flagged.astype(float))


def feature_frame(frame: pd.DataFrame, numeric: Iterable[str] = NUMERIC_FEATURES, categorical: Iterable[str] = CATEGORICAL_FEATURES) -> pd.DataFrame:
    numeric, categorical = list(numeric), list(categorical)
    allowed = allowed_features(numeric, categorical)
    value = _number(frame, "avm_value").where(lambda series: series > 0)
    appraisal = _number(frame, "appraisal_value").where(lambda series: series > 0)
    derived = {
        "min_bid_ratio": _number(frame, "min_bid_price") / appraisal,
        "min_to_avm": _number(frame, "min_bid_price") / value,
        "min_to_conservative": _number(frame, "min_bid_price") / conservative_value(frame),
        "avm_to_appraisal": value / appraisal,
        "avm_band_width": (_number(frame, "avm_high") - _number(frame, "avm_low")) / value,
        "assumed_to_avm": sane_assumed_amount(frame) / value,
    }
    columns: dict[str, pd.Series] = {}
    for name in numeric:
        if name in derived:
            columns[name] = derived[name]
        elif name in FLAG_FEATURES and name in frame.columns:
            columns[name] = _numeric_flag(frame[name])
        else:
            columns[name] = _number(frame, name)
    for name in categorical:
        if name not in frame.columns:
            columns[name] = pd.Series("unknown", index=frame.index, dtype=object)
        else:
            columns[name] = frame[name].fillna("unknown").astype(str).replace({"": "unknown", "nan": "unknown"})
    return pd.DataFrame(columns, index=frame.index)[allowed]


def _pipeline(random_state: int, numeric: list[str], categorical: list[str], linear: bool) -> Pipeline:
    if not SKLEARN_AVAILABLE:
        raise RuntimeError("scikit-learn이 설치되어 있지 않습니다")
    if linear:
        preprocessor = ColumnTransformer([
            ("num", Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]), numeric),
            ("cat", Pipeline([
                ("impute", SimpleImputer(strategy="most_frequent")),
                ("encode", OneHotEncoder(handle_unknown="ignore", min_frequency=20)),
            ]), categorical),
        ])
        return Pipeline([("prep", preprocessor), ("model", LogisticRegression(max_iter=2000, random_state=random_state))])
    preprocessor = ColumnTransformer([
        ("num", SimpleImputer(strategy="median"), numeric),
        ("cat", Pipeline([
            ("impute", SimpleImputer(strategy="most_frequent")),
            ("encode", OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1)),
        ]), categorical),
    ])
    classifier = HistGradientBoostingClassifier(
        max_iter=200,
        learning_rate=0.05,
        l2_regularization=0.05,
        random_state=random_state,
    )
    return Pipeline([("prep", preprocessor), ("model", classifier)])


@dataclass
class GoodListingModel:
    pipeline: Pipeline
    numeric: list[str]
    categorical: list[str]
    builder: object = None

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        if frame.empty:
            return np.array([], dtype=float)
        build = feature_frame if self.builder is None else self.builder
        return self.pipeline.predict_proba(build(frame, self.numeric, self.categorical))[:, 1]


def train_good_listing(
    frame: pd.DataFrame,
    random_state: int = 42,
    numeric: Iterable[str] = NUMERIC_FEATURES,
    categorical: Iterable[str] = CATEGORICAL_FEATURES,
    linear: bool = False,
) -> GoodListingModel | None:
    numeric, categorical = list(numeric), list(categorical)
    labelled = frame[labelled_rows(frame)].copy()
    good = good_listing_mask(labelled)
    if int(good.sum()) < 30 or int((~good).sum()) < 30:
        return None
    pipeline = _pipeline(random_state, numeric, categorical, linear)
    pipeline.fit(feature_frame(labelled, numeric, categorical), good.astype(int))
    return GoodListingModel(pipeline, numeric, categorical)


def precision_at_fraction(score: Iterable[float], labels: Iterable[bool], fraction: float) -> tuple[float, int]:
    values = np.asarray(list(score), dtype=float)
    truth = np.asarray(list(labels), dtype=bool)
    if len(values) == 0:
        return float("nan"), 0
    count = max(1, int(len(values) * fraction))
    order = np.argsort(-np.nan_to_num(values, nan=-1e9))[:count]
    return float(truth[order].mean()), count


def _auc(labels: pd.Series, score: Iterable[float]) -> float:
    values = np.asarray(list(score), dtype=float)
    if labels.nunique() < 2 or not np.isfinite(values).any():
        return float("nan")
    return float(roc_auc_score(labels, np.nan_to_num(values, nan=np.nanmedian(values))))


def ranking_metrics(score: Iterable[float], labels: pd.Series) -> dict[str, float]:
    values = np.asarray(list(score), dtype=float)
    filled = np.nan_to_num(values, nan=np.nanmedian(values) if np.isfinite(values).any() else 0.0)
    top10, _ = precision_at_fraction(filled, labels, 0.10)
    top5, _ = precision_at_fraction(filled, labels, 0.05)
    return {
        "auc": _auc(labels, values),
        "average_precision": float(average_precision_score(labels, filled)) if labels.nunique() > 1 else float("nan"),
        "precision_at_10": top10,
        "precision_at_5": top5,
    }


def eval_good_listing(frame: pd.DataFrame, random_state: int = 42) -> dict:
    """Time-split the labelled rows and compare the model with simpler rankings."""
    try:
        from .offline_eval import time_split
    except ImportError:
        from offline_eval import time_split

    matched = frame[frame["matched"]].copy() if "matched" in frame.columns else frame.copy()
    matched = matched.dropna(subset=["sale_date"]) if "sale_date" in matched.columns else matched
    usable = matched[labelled_rows(matched)].copy()
    usable["good"] = good_listing_mask(usable)
    usable["net_margin"] = net_margin(usable)
    result: dict = {
        "status": "skipped",
        "matched_rows": int(len(matched)),
        "labelled_rows": int(len(usable)),
        "train_rows": 0,
        "test_rows": 0,
    }
    if not SKLEARN_AVAILABLE or len(usable) < MIN_TRAIN_ROWS + MIN_TEST_ROWS:
        return result
    train, test = time_split(usable, test_ratio=0.3)
    if len(train) < MIN_TRAIN_ROWS or len(test) < MIN_TEST_ROWS or train["good"].nunique() < 2 or test["good"].nunique() < 2:
        return result
    model = train_good_listing(train, random_state)
    if model is None:
        return result
    labels = test["good"].astype(bool)
    sold = test["sold"].fillna(False).astype(bool)
    probability = model.predict(test)

    # Each variant answers one question: does the tree model beat a line, do the rights inputs matter,
    # and how much would the (possibly post-sale) view counts add.
    variants = {
        "logistic": {"linear": True},
        "model_without_rights": {"numeric": PRICE_FEATURES, "categorical": [name for name in CATEGORICAL_FEATURES if name != "risk_grade"]},
        "model_plus_views": {"numeric": NUMERIC_FEATURES + ATTENTION_FEATURES},
    }
    rankings = {"model": ranking_metrics(probability, labels)}
    for name, options in variants.items():
        variant = train_good_listing(train, random_state, **options)
        if variant is not None:
            rankings[name] = ranking_metrics(variant.predict(test), labels)
    rankings["cheapness"] = ranking_metrics(-(_number(test, "min_bid_price") / conservative_value(test)), labels)
    rankings["current_score"] = ranking_metrics(_number(test, "total_score"), labels)

    # A listing whose minimum bid already leaves less than the margin can never be good, and any ranking
    # gets that half right for free. Rankings are compared again on the rows where the label is open.
    open_rows = (floor_margin(test) >= GOOD_MARGIN).to_numpy()
    open_labels = labels[open_rows]
    open_rankings = {
        "model": _auc(open_labels, probability[open_rows]),
        "cheapness": _auc(open_labels, -(_number(test, "min_bid_price") / conservative_value(test))[open_rows]),
        "current_score": _auc(open_labels, _number(test, "total_score")[open_rows]),
    }

    passed = test["passed_filter"].fillna(False).astype(bool) if "passed_filter" in test.columns else pd.Series(False, index=test.index)
    # Inputs read from the latest row may carry values written after the sale. Rows scored from a
    # pre-sale snapshot cannot, so their AUC is the one to trust once enough of them exist.
    source = test["feature_source"] if "feature_source" in test.columns else pd.Series("latest", index=test.index)
    test = test.assign(input_source=source.where(source.isin(POINT_IN_TIME_SOURCES), "latest"))
    # The label and the cheapness inputs share the market value, so its error could fake a signal.
    # Rows valued from the same building have the smallest error; the ranking should hold there too.
    def breakdown(column: str) -> list[dict]:
        rows_out = []
        for group, rows in test.groupby(column):
            if len(rows) < MIN_TEST_ROWS:
                continue
            group_labels = rows["good"].astype(bool)
            rows_out.append({
                column: group,
                "rows": int(len(rows)),
                "good_rate": float(group_labels.mean()),
                "auc": _auc(group_labels, probability[test.index.get_indexer(rows.index)]),
            })
        return rows_out

    by_type = breakdown("property_type")
    sold_margin = usable.loc[usable["sold"].fillna(False).astype(bool), "net_margin"]
    result.update({
        "status": "ok",
        "train_rows": int(len(train)),
        "test_rows": int(len(test)),
        "test_from": test["sale_date"].min().strftime("%Y-%m-%d"),
        "test_to": test["sale_date"].max().strftime("%Y-%m-%d"),
        "test_good_rate": float(labels.mean()),
        "test_sold_rate": float(sold.mean()),
        "label_sold_correlation": float(np.corrcoef(labels.astype(float), sold.astype(float))[0, 1]) if sold.nunique() > 1 else float("nan"),
        "good_share_of_sold": float(labels[sold].mean()) if int(sold.sum()) else float("nan"),
        "sold_only_auc": _auc(labels[sold], probability[sold.to_numpy()]),
        "sold_net_margin_median": float(sold_margin.median()) if len(sold_margin) else float("nan"),
        "rankings": rankings,
        "open_rows": int(open_rows.sum()),
        "open_good_rate": float(open_labels.mean()) if int(open_rows.sum()) else float("nan"),
        "open_auc": open_rankings,
        "by_type": by_type,
        "by_basis": breakdown("avm_basis") if "avm_basis" in test.columns else [],
        "by_source": breakdown("input_source"),
        "point_in_time_rows": int(test["input_source"].isin(POINT_IN_TIME_SOURCES).sum()),
        "passed_precision": float(labels[passed].mean()) if int(passed.sum()) else float("nan"),
        "passed_rows": int(passed.sum()),
        "rights_features": RIGHTS_FEATURES + ["risk_grade"],
    })
    return result


def eval_shadow_tracking(frame: pd.DataFrame) -> dict:
    """Stored pre-sale probabilities against the label that arrived later."""
    if "shadow_good_probability" not in frame.columns or "shadow_good_version" not in frame.columns:
        return {"rows": 0}
    probability = pd.to_numeric(frame["shadow_good_probability"], errors="coerce")
    tracked = frame[probability.notna() & (frame["shadow_good_version"] == LABEL_VERSION) & labelled_rows(frame)].copy()
    if "matched" in tracked.columns:
        tracked = tracked[tracked["matched"]]
    result: dict = {"rows": int(len(tracked))}
    if tracked.empty:
        return result
    labels = good_listing_mask(tracked)
    scores = pd.to_numeric(tracked["shadow_good_probability"], errors="coerce")
    result.update({
        "from": tracked["sale_date"].min().strftime("%Y-%m-%d"),
        "to": tracked["sale_date"].max().strftime("%Y-%m-%d"),
        "days": int((tracked["sale_date"].max() - tracked["sale_date"].min()).days) + 1,
        "good_rate": float(labels.mean()),
    })
    if SKLEARN_AVAILABLE and labels.nunique() > 1:
        result["model"] = ranking_metrics(scores, labels)
        result["current_score"] = ranking_metrics(_number(tracked, "total_score"), labels)
    return result


def score_upcoming(train_frame: pd.DataFrame, predict_frame: pd.DataFrame, random_state: int = 42) -> np.ndarray | None:
    """Fit on past outcomes and score listings that have not sold yet. NaN where no market value exists."""
    if not SKLEARN_AVAILABLE or predict_frame.empty:
        return None
    model = train_good_listing(train_frame, random_state)
    if model is None:
        return None
    probability = model.predict(predict_frame)
    return np.where(labelled_rows(predict_frame).to_numpy(), probability, np.nan)


# --- post-sale-margin-v3 ----------------------------------------------------
# The exploratory net-margin label above is not this decision. A hit is a frozen
# recommended bid that strictly cleared the sold amount, stayed inside the frozen
# floor and hard cap, and still left the frozen target margin after tax at that
# bid against the post-sale market value. A 유찰 (result code 002, no sale) is a
# separate outcome: the bid was never tested against a clearing price, so it is
# not a loss. Ties are indeterminate. Missing, withdrawn, changed and unknown
# results are not losses. A missing assumed amount is unknown, not zero, and the
# label abstains.

_CODE_KIND = {"001": "sold", "002": "failed_auction"}


def _won(series: pd.Series) -> pd.Series:
    """Half-up to the nearest won. Matches Math.round for non-negative amounts."""
    values = pd.to_numeric(series, errors="coerce").to_numpy(dtype=float)
    return pd.Series(np.floor(values + 0.5), index=series.index)


def _round5(series: pd.Series) -> pd.Series:
    """Five-decimal half-up, matching the operational round5 margin gate."""
    values = pd.to_numeric(series, errors="coerce").to_numpy(dtype=float)
    return pd.Series(np.floor(values * 1e5 + 0.5) / 1e5, index=series.index)


def _tri_bool(frame: pd.DataFrame, name: str) -> pd.Series:
    if name not in frame.columns:
        return pd.Series(pd.NA, index=frame.index, dtype="boolean")
    series = frame[name]
    if series.dtype == bool or str(series.dtype) == "boolean":
        return series.astype("boolean")
    result = pd.Series(pd.NA, index=frame.index, dtype="boolean")
    numeric = pd.to_numeric(series, errors="coerce")
    result = result.mask(numeric.eq(1), True)
    result = result.mask(numeric.eq(0), False)
    text = series.astype(str).str.strip().str.lower()
    result = result.mask(text.isin(["true", "t", "yes", "y"]), True)
    result = result.mask(text.isin(["false", "f", "no", "n"]), False)
    return result


def _result_code(frame: pd.DataFrame) -> pd.Series:
    if "result_cd" not in frame.columns:
        return pd.Series(pd.NA, index=frame.index, dtype=object)
    raw = frame["result_cd"]
    text = raw.astype(str).str.strip()
    numeric = pd.to_numeric(raw, errors="coerce")
    padded = numeric.map(lambda value: f"{int(value):03d}" if pd.notna(value) and float(value).is_integer() else pd.NA)
    code = padded.where(padded.notna(), text.str.lower())
    return code.mask(text.str.lower().isin(["", "nan", "none", "<na>", "nat"]), pd.NA)


def _auction_kind(frame: pd.DataFrame) -> pd.Series:
    """Sale or confirmed 유찰 from ``result_cd`` only. Not a win/loss label.

    Codes other than 001 and 002 are unresolved. Korean court text and
    ``auction_outcome`` / ``outcome_kind`` / ``outcome_status`` are not read.
    """
    code = _result_code(frame)
    kind = code.map(_CODE_KIND)
    sold = _tri_bool(frame, "sold")
    amount = _won(_number(frame, "sold_amount"))
    kind = kind.mask(kind.eq("sold") & (sold.eq(False) | ~amount.gt(0)), "unknown")
    kind = kind.mask(kind.eq("failed_auction") & sold.eq(True), "unknown")
    matched = _tri_bool(frame, "matched")
    kind = kind.mask(matched.eq(False) & kind.notna(), "unknown")
    unresolved = kind.isna()
    kind = kind.mask(unresolved & sold.eq(True) & amount.gt(0), "sold")
    kind = kind.mask(unresolved & matched.eq(False), "missing")
    kind = kind.mask(unresolved & matched.isna() & sold.isna() & code.isna(), "missing")
    kind = kind.mask(unresolved & matched.eq(True) & sold.eq(False) & code.isna(), "unknown")
    return kind.fillna("unknown")


def _price_floor(frame: pd.DataFrame) -> pd.Series:
    """Frozen observation floor. ``result_min_price`` is a later audit, never this."""
    floor = _number(frame, "price_floor")
    return floor.where(floor.notna(), _number(frame, "min_bid_price"))


def _decision_assumed(frame: pd.DataFrame) -> pd.Series:
    """Assumed amount the buyer takes over. Missing stays missing; it is not zero."""
    assumed = _number(frame, "assumed_amount")
    ceiling = pd.concat([_number(frame, "appraisal_value"), _number(frame, "conservative_value")], axis=1).max(axis=1)
    return assumed.where(~(assumed > ceiling * ASSUMED_PARSE_ERROR_MULTIPLE))


def _nontax(frame: pd.DataFrame) -> pd.Series:
    """Move-out, bond and other costs, excluding acquisition tax and the bid.

    Component columns win. A frozen ``fixed_costs`` bundle is used only when a
    component is missing, and only after subtracting the acquisition tax that
    was computed at the cost-assumption bid. ``etc_cost`` defaults to zero when
    the column is absent because the operational formula does the same; move-out
    and bond do not.
    """
    move = _number(frame, "move_out_cost")
    bond = _number(frame, "bond_cost")
    etc = _number(frame, "etc_cost").fillna(0.0) if "etc_cost" in frame.columns else pd.Series(0.0, index=frame.index)
    from_parts = (move + bond + etc).where(move.notna() & bond.notna())
    fixed = _number(frame, "fixed_costs")
    tax = _number(frame, "acq_tax")
    recovered = (fixed - tax).where(fixed.notna() & tax.notna() & fixed.ge(tax))
    return from_parts.where(from_parts.notna(), recovered)


def tax_at_bid(frame: pd.DataFrame) -> pd.Series:
    """Acquisition tax at the frozen recommended bid, not at the cost-assumption bid.

    ``acq_tax_rate_pct`` is a percentage point (1.1 means 1.1%). The frozen won
    amount is used only when that amount was already computed at this bid.
    A frozen rate is moved to this bid when it matches the first-home base case
    at the cost-assumption price, or when it is a flat rate of 4% or more.
    A housing-bracket mismatch abstains rather than inventing a rate.
    """
    if frame.empty:
        return pd.Series(dtype=float)
    bid = _won(_number(frame, "recommended_bid"))
    cost_bid = _won(_number(frame, "cost_bid_price"))
    frozen_tax = _number(frame, "acq_tax")
    frozen_pct = _number(frame, "acq_tax_rate_pct")
    area = _number(frame, "area_m2").fillna(0.0)
    property_type = frame["property_type"].fillna("").astype(str) if "property_type" in frame.columns else pd.Series("", index=frame.index)
    type_known = property_type.str.strip().ne("") & property_type.ne("nan")
    tax = pd.Series(np.nan, index=frame.index, dtype=float)
    same_price = bid.notna() & cost_bid.notna() & bid.eq(cost_bid) & frozen_tax.notna()
    tax = frozen_tax.where(same_price, tax)
    open_rows = tax.isna() & bid.notna() & type_known
    base_at_bid = acquisition_tax_rate(property_type, bid.fillna(0.0), area)
    base_at_cost = acquisition_tax_rate(property_type, cost_bid.fillna(0.0), area)
    matches_cost = cost_bid.notna() & frozen_pct.notna() & (frozen_pct - base_at_cost * 100).abs().le(TAX_RATE_MATCH_PP)
    matches_bid = frozen_pct.notna() & (frozen_pct - base_at_bid * 100).abs().le(TAX_RATE_MATCH_PP)
    flat = frozen_pct.notna() & frozen_pct.ge(FLAT_TAX_RATE_PCT)
    recomputed = _won(bid * base_at_bid)
    flat_tax = _won(bid * frozen_pct / 100.0)
    tax = tax.mask(open_rows & matches_cost, recomputed)
    tax = tax.mask(open_rows & tax.isna() & flat, flat_tax)
    tax = tax.mask(open_rows & tax.isna() & matches_bid, recomputed)
    return tax.rename("tax_at_bid")


def _margin_at_bid(frame: pd.DataFrame, value_column: str) -> pd.Series:
    """``(V - bid - tax(bid) - nontax - assumed) / V``; NaN when any input is missing."""
    value = _won(_number(frame, value_column))
    bid = _won(_number(frame, "recommended_bid"))
    assumed = _won(_decision_assumed(frame))
    nontax = _won(_nontax(frame))
    tax = tax_at_bid(frame)
    margin = (value - bid - tax - nontax - assumed) / value
    ok = value.gt(0) & bid.notna() & tax.notna() & nontax.notna() & assumed.notna()
    return margin.where(ok)


def bid_margin(frame: pd.DataFrame) -> pd.Series:
    """Expected margin of the frozen recommended bid against the frozen conservative value.

    Ex ante: a ranking score, never the label. Tax is recomputed at that bid.
    Stored acquisition tax from another bid is not added again. NaN when the
    assumed amount, tax, a required cost, the bid, or the value is missing.
    Missing assumed amount is not treated as zero.
    """
    if frame.empty:
        return pd.Series(dtype=float, name="bid_margin")
    return _margin_at_bid(frame, "conservative_value").rename("bid_margin")


def post_sale_margin(frame: pd.DataFrame) -> pd.Series:
    """Realized margin of the frozen recommended bid against the post-sale market value. Label only."""
    if frame.empty:
        return pd.Series(dtype=float, name="post_sale_margin")
    return _margin_at_bid(frame, "post_sale_value").rename("post_sale_margin")


def decision_outcomes(frame: pd.DataFrame) -> pd.Series:
    """One label per row. Unresolved rows are kept; they are not dropped or called losses.

    Losses are only ``outbid``, ``below_target`` and ``invalid_bid``. A confirmed
    유찰 is ``failed_auction``. An equal rounded bid is ``tie``. A missing assumed
    amount is ``abstain``, including when the bid is below the sold amount, so
    unresolved rights are not a negative training row. A winning in-range bid
    without a recorded post-sale window is ``pending``; a closed window without
    a positive value is ``no_post_sale``.
    """
    if frame.empty:
        return pd.Series(dtype=object, name="decision_outcome")
    kind = _auction_kind(frame)
    sold_amount = _won(_number(frame, "sold_amount"))
    bid = _won(_number(frame, "recommended_bid"))
    floor = _won(_price_floor(frame))
    cap = _won(_number(frame, "hard_cap_bid"))
    outcome = pd.Series(DECISION_MISSING, index=frame.index, dtype=object)
    outcome = outcome.mask(kind.eq("failed_auction"), DECISION_FAILED_AUCTION)
    outcome = outcome.mask(kind.eq("withdrawn"), DECISION_WITHDRAWN)
    outcome = outcome.mask(kind.eq("changed"), DECISION_CHANGED)
    outcome = outcome.mask(kind.eq("unknown"), DECISION_UNKNOWN)
    outcome = outcome.mask(kind.eq("sold") & ~sold_amount.gt(0), DECISION_UNKNOWN)
    confirmed = kind.eq("sold") & sold_amount.gt(0)
    rights_known = _decision_assumed(frame).notna()
    outcome = outcome.mask(confirmed & ~rights_known, DECISION_ABSTAIN)
    scored_sale = confirmed & rights_known
    outcome = outcome.mask(scored_sale & bid.isna(), DECISION_ABSTAIN)
    outcome = outcome.mask(scored_sale & bid.notna() & bid.eq(sold_amount), DECISION_TIE)
    above = scored_sale & bid.notna() & bid.gt(sold_amount)
    outcome = outcome.mask(scored_sale & bid.notna() & bid.lt(sold_amount), DECISION_OUTBID)
    bounds_known = floor.gt(0) & cap.gt(0)
    bounds_ok = bounds_known & bid.ge(floor) & bid.le(cap)
    outcome = outcome.mask(above & bounds_known & ~bounds_ok, DECISION_INVALID_BID)
    outcome = outcome.mask(above & ~bounds_known, DECISION_ABSTAIN)
    can_score = above & bounds_ok
    window = _number(frame, "post_sale_window_days")
    post_value = _number(frame, "post_sale_value")
    outcome = outcome.mask(can_score & window.isna(), DECISION_PENDING)
    outcome = outcome.mask(can_score & window.notna() & ~post_value.gt(0), DECISION_NO_POST_SALE)
    valued = can_score & window.notna() & post_value.gt(0)
    margin = post_sale_margin(frame)
    target = _number(frame, "target_margin_pct")
    target_ok = target.notna() & target.ge(0) & target.lt(1)
    rounded = _round5(margin)
    outcome = outcome.mask(valued & margin.notna() & target_ok & rounded.ge(target), DECISION_HIT)
    outcome = outcome.mask(valued & margin.notna() & target_ok & rounded.lt(target), DECISION_BELOW_TARGET)
    outcome = outcome.mask(valued & ~(margin.notna() & target_ok), DECISION_ABSTAIN)
    return outcome.rename("decision_outcome")


def decision_feature_frame(
    frame: pd.DataFrame,
    numeric: Iterable[str] | None = None,
    categorical: Iterable[str] | None = None,
) -> pd.DataFrame:
    """Ex ante frozen inputs only. The label, the sold amount and the floor audit stay out."""
    numeric = list(DECISION_NUMERIC if numeric is None else numeric)
    categorical = list(DECISION_CATEGORICAL if categorical is None else categorical)
    allowed = allowed_features(numeric, categorical)
    value = _number(frame, "conservative_value").where(lambda series: series > 0)
    floor = _price_floor(frame)
    assumed = _decision_assumed(frame)
    derived = {
        "price_floor": floor,
        "bid_to_value": _number(frame, "recommended_bid") / value,
        "floor_to_value": floor / value,
        "assumed_to_value": assumed / value,
        "avm_band_width": (_number(frame, "avm_high") - _number(frame, "avm_low")) / _number(frame, "avm_value").where(lambda series: series > 0),
        "precision_confidence_rank": _confidence_rank(frame),
    }
    columns: dict[str, pd.Series] = {}
    for name in numeric:
        if name in derived:
            columns[name] = derived[name]
        elif name in FLAG_FEATURES and name in frame.columns:
            columns[name] = _numeric_flag(frame[name])
        else:
            columns[name] = _number(frame, name)
    for name in categorical:
        if name == "region":
            columns[name] = _region(frame)
        elif name not in frame.columns:
            columns[name] = pd.Series("unknown", index=frame.index, dtype=object)
        else:
            columns[name] = frame[name].fillna("unknown").astype(str).replace({"": "unknown", "nan": "unknown"})
    return pd.DataFrame(columns, index=frame.index)[allowed]


def _region(frame: pd.DataFrame) -> pd.Series:
    if "region" in frame.columns:
        region = frame["region"]
    elif "address" in frame.columns:
        region = frame["address"].map(_region_from_address)
    else:
        region = pd.Series("unknown", index=frame.index)
    return region.fillna("unknown").astype(str).replace({"": "unknown", "nan": "unknown"})


def _region_from_address(address: object) -> str:
    if not isinstance(address, str) or not address.strip():
        return "unknown"
    parts = address.split()
    if not parts:
        return "unknown"
    if parts[0] in {"서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시", "울산광역시", "세종특별자치시"} and len(parts) > 1:
        return f"{parts[0]} {parts[1]}"
    if parts[0].endswith("도") and len(parts) > 1:
        return f"{parts[0]} {parts[1]}"
    return parts[0]


def _utc_timestamp(frame: pd.DataFrame, name: str) -> pd.Series:
    if name not in frame.columns:
        return pd.Series(pd.NaT, index=frame.index, dtype="datetime64[ns, UTC]")
    return pd.to_datetime(frame[name], errors="coerce", utc=True)


def _seoul_day(series: pd.Series) -> pd.Series:
    parsed = pd.to_datetime(series, errors="coerce", utc=True)
    return parsed.dt.tz_convert("Asia/Seoul").dt.normalize()


def _observation_date(frame: pd.DataFrame) -> pd.Series:
    observed = _seoul_day(frame["observed_on"]) if "observed_on" in frame.columns else pd.Series(pd.NaT, index=frame.index)
    if "snapped_at" not in frame.columns:
        return observed
    return observed.where(observed.notna(), _seoul_day(frame["snapped_at"]))


def observation_freeze_at(frame: pd.DataFrame) -> pd.Series:
    """snapped_at, otherwise the start of observed_on in Asia/Seoul."""
    snapped = _utc_timestamp(frame, "snapped_at")
    if "observed_on" not in frame.columns:
        return snapped
    raw = pd.to_datetime(frame["observed_on"], errors="coerce")
    if getattr(raw.dt, "tz", None) is not None:
        start = raw.dt.tz_convert("Asia/Seoul").dt.tz_localize(None)
    else:
        start = raw
    start = start.dt.normalize().dt.tz_localize("Asia/Seoul").dt.tz_convert("UTC")
    return snapped.where(snapped.notna(), start)


def result_known_at(frame: pd.DataFrame) -> pd.Series:
    """Later of result capture and trust evaluation. NaT unless both exist."""
    captured = _utc_timestamp(frame, "result_captured_at")
    trusted = _utc_timestamp(frame, "trust_evaluated_at")
    later = captured.where(captured.ge(trusted), trusted)
    return later.where(captured.notna() & trusted.notna())


def label_known_at(frame: pd.DataFrame) -> pd.Series:
    """When the label could be known: the later of the result and the post-sale window close.

    The window closes at the start of sale day + 180 + 30 days in Asia/Seoul,
    for every outcome, so a recent outbid is not trained before the hits sold
    the same week could be graded. A later ``computed_at`` is a job delay, not
    new information.
    """
    known = result_known_at(frame)
    if "sale_date" not in frame.columns:
        return known.where(pd.Series(False, index=frame.index))
    sale = pd.to_datetime(frame["sale_date"], errors="coerce")
    if getattr(sale.dt, "tz", None) is not None:
        sale = sale.dt.tz_convert("Asia/Seoul").dt.tz_localize(None)
    closes = (sale.dt.normalize() + pd.Timedelta(days=POST_SALE_WINDOW_DAYS + POST_SALE_REPORT_GAP_DAYS)).dt.tz_localize("Asia/Seoul").dt.tz_convert("UTC")
    later = known.where(known.ge(closes), closes)
    return later.where(known.notna() & closes.notna())


def _horizon(frame: pd.DataFrame) -> pd.Series:
    days = _number(frame, "horizon_days")
    if "feature_source" in frame.columns:
        source = frame["feature_source"].astype(str).str.strip().str.lower()
        days = days.where(days.notna(), source.map({"d7": 7, "d1": 1, "7": 7, "1": 1}))
    return days


def _item_no(series: pd.Series) -> pd.Series:
    def one(value: object) -> str:
        if pd.isna(value):
            return "1"
        text = str(value).strip()
        if text.lower() in {"", "nan", "none", "<na>"}:
            return "1"
        if text.endswith(".0") and text[:-2].isdigit():
            return text[:-2]
        return text
    return series.map(one)


def _case_key(frame: pd.DataFrame) -> pd.Series:
    court = frame["court"].astype(str) if "court" in frame.columns else pd.Series("", index=frame.index)
    case_no = frame["case_no"].astype(str) if "case_no" in frame.columns else pd.Series("", index=frame.index)
    item = _item_no(frame["item_no"]) if "item_no" in frame.columns else pd.Series("1", index=frame.index)
    return court.str.strip() + "|" + case_no.str.strip() + "|" + item


def _purge_overlap(train: pd.DataFrame, other: pd.DataFrame) -> pd.DataFrame:
    if train.empty or other.empty:
        return train
    blocked = set(_case_key(other))
    return train.loc[~_case_key(train).isin(blocked)].copy()


def _trusted(frame: pd.DataFrame) -> pd.Series:
    """Canonical ``label_trusted`` only. ``outcome_trust_status`` does not widen it."""
    if "label_trusted" not in frame.columns:
        return pd.Series(False, index=frame.index)
    return _tri_bool(frame, "label_trusted").eq(True)


def _fully_frozen(frame: pd.DataFrame) -> pd.Series:
    if "fully_frozen" not in frame.columns:
        return pd.Series(False, index=frame.index)
    return _tri_bool(frame, "fully_frozen").eq(True)


def _snapshot_ok(frame: pd.DataFrame) -> pd.Series:
    if "snapshot_version" not in frame.columns:
        return pd.Series(False, index=frame.index)
    return frame["snapshot_version"].astype(str).str.strip().eq(SNAPSHOT_VERSION)


def _frozen_source(frame: pd.DataFrame) -> pd.Series:
    """d7 or d1 only when ``horizon_days`` matches. A blank source is not frozen."""
    if "feature_source" not in frame.columns or "horizon_days" not in frame.columns:
        return pd.Series(False, index=frame.index)
    source = frame["feature_source"].astype(str).str.strip().str.lower()
    expected = source.map({"d7": 7.0, "d1": 1.0})
    return expected.notna() & _number(frame, "horizon_days").eq(expected)


def _confidence_rank(frame: pd.DataFrame) -> pd.Series:
    """high/medium/low map to 3/2/1. Anything else stays missing and is imputed, not zero."""
    if "precision_confidence" not in frame.columns:
        return pd.Series(np.nan, index=frame.index, dtype=float)
    text = frame["precision_confidence"].astype(str).str.strip().str.lower()
    return text.map(CONFIDENCE_RANK).astype(float)


def training_eligible(frame: pd.DataFrame) -> pd.Series:
    """Hit or loss on an exactly trusted, fully frozen feature-v2 row in the comparison pool.

    Missing assumed amount is abstain, so it is not eligible and cannot train as outbid.
    """
    if frame.empty:
        return pd.Series(dtype=bool)
    return (
        _trusted(frame)
        & _fully_frozen(frame)
        & _snapshot_ok(frame)
        & _frozen_source(frame)
        & _tri_bool(frame, "comparison_eligible").eq(True)
        & decision_outcomes(frame).isin([DECISION_HIT, *DECISION_LOSSES])
    )


def score_eligible(frame: pd.DataFrame) -> pd.Series:
    """Upcoming rows that may receive a hit probability.

    Frozen comparison-pool membership and a known assumed amount are mandatory;
    neither missing rights nor missing provenance can be imputed.
    """
    if frame.empty:
        return pd.Series(dtype=bool)
    return (_frozen_source(frame) & _snapshot_ok(frame) & _fully_frozen(frame)
            & _decision_assumed(frame).notna() & _tri_bool(frame, "comparison_eligible").eq(True))


def training_rows(train: pd.DataFrame, predict: pd.DataFrame) -> pd.DataFrame:
    """Past rows that pass ``training_eligible`` and whose label was known before the predict freeze.

    Known means ``label_known_at``: the result and the closed post-sale window.
    There is no sale-date-only or row-order fallback, and ``outcome_trust_status``
    does not widen ``label_trusted``. The same court, case and item as a predict row is purged.
    """
    if train.empty or predict.empty:
        return train.iloc[0:0].copy()
    freeze = observation_freeze_at(predict)
    observed = _observation_date(predict)
    if not freeze.notna().any() or not observed.notna().any():
        return train.iloc[0:0].copy()
    earliest_freeze = freeze.min()
    earliest_observed = observed.min()
    known = label_known_at(train)
    sale = _seoul_day(train["sale_date"]) if "sale_date" in train.columns else pd.Series(pd.NaT, index=train.index)
    own_observed = _observation_date(train)
    mask = (
        known.notna() & known.lt(earliest_freeze)
        & sale.notna() & sale.lt(earliest_observed)
        & own_observed.notna() & own_observed.lt(sale)
        & training_eligible(train)
    )
    return _purge_overlap(train.loc[mask].copy(), predict)


def decision_split(frame: pd.DataFrame, test_ratio: float = 0.3) -> tuple[pd.DataFrame, pd.DataFrame, str]:
    """As-of split on freeze dates. Never falls back to row order."""
    empty = frame.iloc[0:0].copy()
    if "result_captured_at" not in frame.columns or "trust_evaluated_at" not in frame.columns:
        return empty, empty, "result_known_at_missing"
    usable = frame.loc[training_eligible(frame) & label_known_at(frame).notna() & observation_freeze_at(frame).notna()].copy()
    if usable.empty:
        return empty, empty, "no_earlier_known_result"
    freeze_dates = _observation_date(usable).dropna().drop_duplicates().sort_values()
    if len(freeze_dates) < 2:
        return empty, empty, "single_freeze_day"
    cutoff_index = max(1, min(len(freeze_dates) - 1, int(len(freeze_dates) * (1 - test_ratio))))
    cutoff = freeze_dates.iloc[cutoff_index]
    observed = _observation_date(usable)
    test = usable.loc[observed.ge(cutoff)].copy()
    if test.empty:
        return empty, empty, "empty_test"
    train = training_rows(usable, test)
    if train.empty:
        return empty, empty, "no_earlier_known_result"
    return train, test, "ok"


def train_bid_decision(frame: pd.DataFrame, random_state: int = 42) -> GoodListingModel | None:
    """Fit hit-versus-loss on already filtered frozen rows. None when the sample is too small."""
    if not SKLEARN_AVAILABLE or frame is None or frame.empty:
        return None
    labels = decision_outcomes(frame)
    usable = frame.loc[labels.isin([DECISION_HIT, *DECISION_LOSSES])].copy()
    positive = labels.loc[usable.index].eq(DECISION_HIT)
    if len(usable) < MIN_TRAIN_ROWS or int(positive.sum()) < MIN_CLASS_ROWS or int((~positive).sum()) < MIN_CLASS_ROWS:
        return None
    numeric, categorical = list(DECISION_NUMERIC), list(DECISION_CATEGORICAL)
    pipeline = _pipeline(random_state, numeric, categorical, linear=False)
    pipeline.fit(decision_feature_frame(usable, numeric, categorical), positive.astype(int))
    return GoodListingModel(pipeline, numeric, categorical, decision_feature_frame)


def _score_frame(frame: pd.DataFrame, probability: np.ndarray) -> pd.DataFrame:
    court = frame["court"].astype(str) if "court" in frame.columns else pd.Series("", index=frame.index)
    case_no = frame["case_no"].astype(str) if "case_no" in frame.columns else pd.Series("", index=frame.index)
    sale = pd.to_datetime(frame["sale_date"], errors="coerce", utc=True).dt.strftime("%Y-%m-%d")
    return pd.DataFrame({
        "court": court.to_numpy(),
        "case_no": case_no.to_numpy(),
        "item_no": _item_no(frame["item_no"]).to_numpy() if "item_no" in frame.columns else np.repeat("1", len(frame)),
        "sale_date": sale.fillna("").to_numpy(),
        "horizon_days": _horizon(frame).astype(int).to_numpy(),
        "probability": np.clip(probability, 0.0, 1.0),
    })


def score_frozen_decisions(
    train_frame: pd.DataFrame,
    predict_frame: pd.DataFrame,
    random_state: int = 42,
) -> pd.DataFrame | None:
    """Score frozen upcoming rows. Horizons are fit separately. None means abstain.

    Columns: court, case_no, item_no, sale_date, horizon_days, probability.
    Probability is the hit-class score, not ``precision_confidence``. Rows that
    fail ``score_eligible`` are omitted. This does not write shadow scores.
    """
    if not SKLEARN_AVAILABLE or train_frame is None or predict_frame is None or predict_frame.empty:
        return None
    pieces: list[pd.DataFrame] = []
    for horizon in (7, 1):
        predict = predict_frame.loc[_horizon(predict_frame).eq(horizon) & score_eligible(predict_frame)].copy()
        if predict.empty or not _observation_date(predict).notna().any():
            continue
        past = train_frame.loc[_horizon(train_frame).eq(horizon)].copy()
        model = train_bid_decision(training_rows(past, predict), random_state)
        if model is None:
            continue
        pieces.append(_score_frame(predict, model.predict(predict)))
    if not pieces:
        return None
    return pd.concat(pieces, ignore_index=True)


def reportable_outcomes(frame: pd.DataFrame) -> pd.Series:
    """Keep unresolved outcomes for coverage; never report an unverified hit, loss or winnable bid."""
    outcomes = decision_outcomes(frame)
    if outcomes.empty:
        return outcomes
    resolved = outcomes.isin([DECISION_HIT, DECISION_TIE, *DECISION_LOSSES, DECISION_PENDING, DECISION_NO_POST_SALE])
    return outcomes.mask(resolved & ~(score_eligible(frame) & _trusted(frame)), DECISION_ABSTAIN)


def eval_bid_decision(frame: pd.DataFrame, random_state: int = 42) -> dict:
    """Count every frozen row, then score each horizon on its own as-of split."""
    outcomes = reportable_outcomes(frame)
    counts = outcomes.value_counts() if not outcomes.empty else pd.Series(dtype=int)
    result: dict = {
        "status": "skipped",
        "label_version": DECISION_LABEL_VERSION,
        "model_version": MODEL_VERSION,
        "rows": int(len(frame)),
        "counts": {name: int(counts.get(name, 0)) for name in DECISION_OUTCOMES},
        "losses": list(DECISION_LOSSES),
        "note": "유찰(result 002)은 실패 표본이 아니다. 동가·사후 확인 대기·사후 시세 없음은 미확정이다. 최신 행과 바닥가 감사는 입력으로 쓰지 않는다.",
        "horizons": {},
    }
    if frame.empty:
        result["reason"] = "empty"
        return result
    any_ok = False
    for horizon in (7, 1):
        slice_ = frame.loc[_horizon(frame).eq(horizon)].copy()
        horizon_result = _eval_horizon(slice_, random_state)
        result["horizons"][str(horizon)] = horizon_result
        any_ok = any_ok or horizon_result["status"] == "ok"
    result["status"] = "ok" if any_ok else "skipped"
    return result


def _eval_horizon(frame: pd.DataFrame, random_state: int) -> dict:
    outcomes = reportable_outcomes(frame)
    counts = outcomes.value_counts() if not outcomes.empty else pd.Series(dtype=int)
    report: dict = {
        "status": "skipped",
        "rows": int(len(frame)),
        "counts": {name: int(counts.get(name, 0)) for name in DECISION_OUTCOMES},
        "abstain_rows": int(counts.get(DECISION_ABSTAIN, 0)),
        "failed_auction_rows": int(counts.get(DECISION_FAILED_AUCTION, 0)),
    }
    if frame.empty:
        report["reason"] = "empty"
        return report
    if not SKLEARN_AVAILABLE:
        report["reason"] = "no_sklearn"
        return report
    train, test, reason = decision_split(frame)
    report["reason"] = reason
    if reason != "ok":
        return report
    model = train_bid_decision(train, random_state)
    if model is None:
        report["reason"] = "too_few"
        return report
    labels = decision_outcomes(test).eq(DECISION_HIT)
    if int(labels.sum()) == 0 or int((~labels).sum()) == 0 or len(test) < MIN_TEST_ROWS:
        report["reason"] = "too_few"
        report["train_rows"] = int(len(train))
        report["test_rows"] = int(len(test))
        return report
    score = model.predict(test)
    cheapness = (_number(test, "conservative_value") / _price_floor(test)).replace([np.inf, -np.inf], np.nan)
    report.update({
        "status": "ok",
        "reason": "ok",
        "train_rows": int(len(train)),
        "test_rows": int(len(test)),
        "test_hit_rate": float(labels.mean()),
        "model": ranking_metrics(score, labels),
        "cheapness": ranking_metrics(cheapness, labels),
    })
    return report


def decision_lines(result: dict) -> list[str]:
    """Korean report section. Exploratory; not an operational bid change."""
    lines = [
        "## Post-sale Margin Decision",
        f"- 라벨(`{result.get('label_version', DECISION_LABEL_VERSION)}`): 동결된 권장가가 낙찰가보다 높고, "
        "동결된 최저가와 상한 안이며, 매각 후 시세(매각일 다음 날부터 "
        f"{POST_SALE_WINDOW_DAYS}일 안의 같은 건물·같은 평형 실거래 중앙값)에서 그 권장가 기준 취득세와 "
        "동결된 비용·인수금액을 뺀 마진이 동결된 목표 마진 이상. 동결 목표 마진이 없으면 0.15로 채우지 않고 기권한다.",
        "- 권장가를 만든 동결 보수시세로 채점하지 않는다(자기참조). 창이 닫히지 않았으면 사후 확인 대기(pending), "
        "창 안에 같은 건물·같은 평형 거래가 없으면 사후 시세 없음(no_post_sale)이며 둘 다 손실이 아니다.",
        "- 유찰(결과코드 002, 매수인 없음)은 실패가 아니다. 권장가가 낙찰가와 시험되지 않았다. "
        "동가·미매칭·미확인도 실패로 세지 않는다. 법원 결과 문구로는 취하·변경을 만들지 않는다. "
        "손실은 미낙찰, 목표 미달, 권장가 범위 이탈뿐이다.",
        "- 인수금액이 비어 있으면 0이 아니라 기권이다. 권장가가 낙찰가보다 낮아도 미낙찰로 세지 않는다. "
        "취득세는 권장가에서 다시 계산하며, 다른 가정가의 세금과 더하지 않는다. "
        "결과 최저가와 매각 후 값은 입력으로 쓰지 않는다(라벨에만 쓴다).",
        "- 학습 행은 label_trusted 가 정확히 참이고 fully_frozen 이며 snapshot_version 이 feature-v2 이고 "
        "당시 비교 후보군(신뢰·권리·입찰 범위 게이트 통과, 추천·조건부)에 들고 feature_source 가 기간과 일치하는 행만이다. "
        "outcome_trust_status 만으로 넓히지 않는다. "
        "조회수·관심수·시세 신뢰도가 비어 있으면 제외하지 않고 보간한다.",
        f"- D-7과 D-1은 따로 학습하고 따로 검증한다. 라벨은 매각일+{POST_SALE_WINDOW_DAYS}일+신고 지연 "
        f"{POST_SALE_REPORT_GAP_DAYS}일 뒤에야 알려진 것으로 보고, 그보다 나중인 동결 시각에서만 학습한다. "
        "날짜가 하루뿐이면 행 순서로 나누지 않고 건너뛴다.",
        f"- 동결 행 {result.get('rows', 0)}건. 운영 추천·입찰가·상태에는 반영하지 않는다.",
    ]
    counts = result.get("counts") or {}
    if counts:
        lines.append("- 판정: " + ", ".join(f"{name} {counts.get(name, 0)}" for name in DECISION_OUTCOMES if counts.get(name, 0)))
    for horizon, horizon_result in (result.get("horizons") or {}).items():
        if horizon_result.get("status") != "ok":
            lines.append(f"- D-{horizon}: 건너뜀 ({horizon_result.get('reason', 'skipped')}).")
            continue
        model = horizon_result["model"]
        cheap = horizon_result["cheapness"]
        lines.append(
            f"- D-{horizon}: 학습 {horizon_result['train_rows']}건 / 검증 {horizon_result['test_rows']}건, "
            f"목표 충족 {horizon_result['test_hit_rate']:.1%}, "
            f"모델 AUC {model['auc']:.3f}, 최저가/보수시세 AUC {cheap['auc']:.3f}."
        )
    return lines + [""]

