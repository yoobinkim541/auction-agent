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
MIN_TRAIN_ROWS = 80
MIN_TEST_ROWS = 20
DEFAULT_MOVE_OUT_COST = 1_500_000
ASSUMED_PARSE_ERROR_MULTIPLE = 10
POINT_IN_TIME_SOURCES = ("d7", "d1")   # inputs frozen before the sale; anything else is the latest row

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

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        if frame.empty:
            return np.array([], dtype=float)
        return self.pipeline.predict_proba(feature_frame(frame, self.numeric, self.categorical))[:, 1]


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
