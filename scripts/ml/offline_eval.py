#!/usr/bin/env python3
"""Phase2 offline ML evaluation.

This is deliberately read-only and report-only: it never writes predictions back to DB.
It compares simple statistical baselines against sklearn/XGBoost models when available.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

try:
    from sklearn.compose import ColumnTransformer
    from sklearn.dummy import DummyClassifier, DummyRegressor
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor, RandomForestClassifier
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, balanced_accuracy_score, mean_absolute_error, mean_squared_error, roc_auc_score
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler
    SKLEARN_AVAILABLE = True
except Exception:
    SKLEARN_AVAILABLE = False

try:
    from xgboost import XGBClassifier, XGBRegressor
    XGBOOST_AVAILABLE = True
except Exception:
    XGBOOST_AVAILABLE = False

try:
    from .ensemble import (
        blend_predictions,
        current_expected_bid_predict,
        fit_nonnegative_blend_weights,
        group_median_predict,
    )
except ImportError:
    from ensemble import (
        blend_predictions,
        current_expected_bid_predict,
        fit_nonnegative_blend_weights,
        group_median_predict,
    )

NUMERIC_FEATURES = [
    "appraisal_value",
    "expected_bid",
    "market_price",
    "min_bid_price",
    "total_score",
    "true_margin",
    "max_safe_bid",
    "inq_cnt",
    "interest_cnt",
    "fail_count",
    "area_m2",
    "building_area_m2",
    "is_collective_building",
    "assumed_amount",
    "has_opposition_tenant",
    "min_bid_ratio",
    "expected_to_appraisal",
    "min_to_appraisal",
    "expected_to_min",
    "market_to_appraisal",
]
CATEGORICAL_FEATURES = ["property_type", "court", "recommendation", "region", "risk_grade", "market_confidence"]


def boolish(series: pd.Series) -> pd.Series:
    return series.astype(str).str.lower().isin(["true", "t", "1", "yes", "y"])


def safe_div(num: pd.Series, den: pd.Series) -> pd.Series:
    den = den.replace(0, np.nan)
    return num / den


def region_from_address(address: str) -> str:
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


def load_dataset(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    for col in ["sale_date"]:
        df[col] = pd.to_datetime(df[col], errors="coerce")
    if "item_no" in df.columns:
        df["item_no"] = df["item_no"].map(lambda x: "1" if pd.isna(x) or str(x).strip() in {"", "nan"} else str(x).replace(".0", ""))
    for col in ["matched", "sold", "passed_filter", "would_have_won_under_max_safe_bid", "has_opposition_tenant", "is_collective_building"]:
        if col in df.columns:
            df[col] = boolish(df[col])
    numeric_cols = [c for c in NUMERIC_FEATURES + ["sold_amount", "sale_ratio", "realized_bid_margin", "assumed_amount"] if c in df.columns]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["region"] = df["address"].map(region_from_address)
    df["min_bid_ratio"] = safe_div(df["min_bid_price"], df["appraisal_value"])
    df["expected_to_appraisal"] = safe_div(df["expected_bid"], df["appraisal_value"])
    df["min_to_appraisal"] = safe_div(df["min_bid_price"], df["appraisal_value"])
    df["expected_to_min"] = safe_div(df["expected_bid"], df["min_bid_price"])
    df["market_to_appraisal"] = safe_div(df["market_price"], df["appraisal_value"])
    return df.sort_values(listing_sort_columns(df))


def listing_sort_columns(frame: pd.DataFrame) -> list[str]:
    return [column for column in ("sale_date", "court", "case_no", "item_no") if column in frame.columns]


def purge_overlapping_listings(train: pd.DataFrame, test: pd.DataFrame) -> pd.DataFrame:
    columns = [column for column in ("court", "case_no", "item_no") if column in train.columns and column in test.columns]
    if "case_no" not in columns or "item_no" not in columns or train.empty or test.empty:
        return train
    test_keys = set(zip(*(test[column].astype(str) for column in columns)))
    train_keys = list(zip(*(train[column].astype(str) for column in columns)))
    return train[[key not in test_keys for key in train_keys]].copy()


def time_split(df: pd.DataFrame, test_ratio: float = 0.3) -> tuple[pd.DataFrame, pd.DataFrame]:
    if len(df) < 2:
        return df.copy(), df.iloc[0:0].copy()
    ordered = df.sort_values(listing_sort_columns(df)).copy()
    dates = ordered["sale_date"].dropna().drop_duplicates().sort_values().tolist()
    if len(dates) < 2:
        cut = max(1, min(len(ordered) - 1, int(math.floor(len(ordered) * (1 - test_ratio)))))
        return ordered.iloc[:cut].copy(), ordered.iloc[cut:].copy()
    cutoff_index = max(1, min(len(dates) - 1, int(math.floor(len(dates) * (1 - test_ratio)))))
    cutoff = dates[cutoff_index]
    train = ordered[ordered["sale_date"] < cutoff].copy()
    test = ordered[ordered["sale_date"] >= cutoff].copy()
    if {"case_no", "item_no"}.issubset(ordered.columns):
        train = purge_overlapping_listings(train, test)
    if train.empty or test.empty:
        cut = max(1, min(len(ordered) - 1, int(math.floor(len(ordered) * (1 - test_ratio)))))
        return ordered.iloc[:cut].copy(), ordered.iloc[cut:].copy()
    return train, test


def rolling_time_splits(
    df: pd.DataFrame,
    n_splits: int = 3,
    test_ratio: float = 0.2,
    min_train_rows: int = 30,
) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    """Return chronological, case/item-purged validation windows."""
    ordered = df.sort_values(listing_sort_columns(df)).copy()
    dates = ordered["sale_date"].dropna().drop_duplicates().sort_values().tolist()
    if len(dates) < 2:
        return []
    test_date_count = max(1, int(math.floor(len(dates) * test_ratio)))
    first_start = max(1, len(dates) - n_splits * test_date_count)
    splits: list[tuple[pd.DataFrame, pd.DataFrame]] = []
    for split_index in range(n_splits):
        start = first_start + split_index * test_date_count
        end = min(len(dates), start + test_date_count)
        if start >= end:
            continue
        train = ordered[ordered["sale_date"] < dates[start]].copy()
        test_mask = ordered["sale_date"] >= dates[start]
        if end < len(dates):
            test_mask &= ordered["sale_date"] < dates[end]
        test = ordered[test_mask].copy()
        if {"case_no", "item_no"}.issubset(ordered.columns):
            train = purge_overlapping_listings(train, test)
        if len(train) >= min_train_rows and not test.empty:
            splits.append((train, test))
    return splits


def pct(value: float | None) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{value * 100:.1f}%"


def money(value: float | None) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{value / 100_000_000:.2f}억"


def make_preprocessor(df: pd.DataFrame):
    numeric = [c for c in NUMERIC_FEATURES if c in df.columns and df[c].notna().any()]
    categorical = [c for c in CATEGORICAL_FEATURES if c in df.columns and df[c].notna().any()]
    return ColumnTransformer([
        ("num", Pipeline([("impute", SimpleImputer(strategy="median", add_indicator=True))]), numeric),
        ("cat", Pipeline([("impute", SimpleImputer(strategy="most_frequent")), ("onehot", OneHotEncoder(handle_unknown="ignore", min_frequency=5, sparse_output=False))]), categorical),
    ]), numeric + categorical


def regression_models(random_state: int):
    models = {
        "dummy_median": DummyRegressor(strategy="median"),
        "hist_gbr": HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, l2_regularization=0.05, random_state=random_state),
        "hist_absolute": HistGradientBoostingRegressor(loss="absolute_error", max_iter=220, learning_rate=0.04, l2_regularization=0.05, random_state=random_state),
    }
    if XGBOOST_AVAILABLE:
        models["xgboost"] = XGBRegressor(n_estimators=250, max_depth=3, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9, objective="reg:squarederror", random_state=random_state)
    return models


def fit_regression_predictions(
    train: pd.DataFrame,
    target: pd.DataFrame,
    random_state: int,
    model_names: list[str] | None = None,
) -> dict[str, np.ndarray]:
    """Fit each requested regressor on train only and predict target."""
    models = regression_models(random_state)
    selected_names = model_names or list(models)
    predictions: dict[str, np.ndarray] = {}
    for name in selected_names:
        preprocessor, features = make_preprocessor(train)
        pipe = Pipeline([("prep", preprocessor), ("model", models[name])])
        pipe.fit(train[features], train["sale_ratio"])
        predictions[name] = np.clip(pipe.predict(target[features]), 0, 2.5)
    return predictions


def ensemble_components(
    train: pd.DataFrame,
    target: pd.DataFrame,
    random_state: int,
) -> dict[str, np.ndarray]:
    """Build all report-only ensemble components from a train window."""
    model_names = [name for name in regression_models(random_state) if name != "dummy_median"]
    components = fit_regression_predictions(train, target, random_state, model_names)
    components["group_median"] = group_median_predict(train, target)
    current = current_expected_bid_predict(target)
    if np.isfinite(current).mean() >= 0.5:
        components["current_expected_bid"] = current
    return components


def fit_ensemble_weights(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    random_state: int,
) -> dict[str, float]:
    """Fit weights on an older validation window, never on the outer holdout."""
    weights, _ = fit_ensemble_validation(train, validation, random_state)
    return weights


def fit_ensemble_validation(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    random_state: int,
) -> tuple[dict[str, float], float]:
    """Fit blend weights and a validation-derived downside buffer."""
    components = ensemble_components(train, validation, random_state)
    target = validation["sale_ratio"].to_numpy(dtype=float)
    valid_rows = np.isfinite(target)
    for values in components.values():
        valid_rows &= np.isfinite(values)
    if int(valid_rows.sum()) < max(20, len(components) * 5):
        weights = {name: 1.0 / len(components) for name in components}
    else:
        weights = fit_nonnegative_blend_weights(
            target[valid_rows],
            {name: values[valid_rows] for name, values in components.items()},
        )
    if int(valid_rows.sum()) < 10:
        return weights, 0.02
    validation_prediction = blend_predictions(
        {name: values[valid_rows] for name, values in components.items()}, weights,
    )
    downside_error = np.maximum(validation_prediction - target[valid_rows], 0.0)
    buffer = float(np.clip(np.quantile(downside_error, 0.75), 0.02, 0.3))
    return weights, buffer


def classifier_models(random_state: int):
    models = {
        "dummy_prior": DummyClassifier(strategy="prior"),
        "logistic": Pipeline([("scale", StandardScaler(with_mean=False)), ("clf", LogisticRegression(max_iter=1000, class_weight="balanced"))]),
        "hist_gbc": HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, l2_regularization=0.05, random_state=random_state),
        "random_forest": RandomForestClassifier(n_estimators=250, min_samples_leaf=8, class_weight="balanced", random_state=random_state),
    }
    if XGBOOST_AVAILABLE:
        models["xgboost"] = XGBClassifier(n_estimators=250, max_depth=3, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9, eval_metric="logloss", random_state=random_state)
    return models


def eval_regression(df: pd.DataFrame, random_state: int) -> tuple[list[dict], pd.DataFrame | None]:
    sold = df[df["sold"] & df["sale_ratio"].notna()].copy()
    train, test = time_split(sold)
    if len(train) < 30 or len(test) < 10 or not SKLEARN_AVAILABLE:
        return [], None
    results = []
    identity = [column for column in ("court", "case_no", "item_no", "sale_date") if column in test.columns]
    predictions = test[identity + ["address", "sale_ratio", "expected_bid", "sold_amount"]].copy()
    current = test[test["expected_bid"].notna() & test["appraisal_value"].notna() & (test["appraisal_value"] > 0)].copy()
    if len(current) >= 10:
        current_pred = np.clip(current["expected_bid"] / current["appraisal_value"], 0, 2.5)
        results.append({
            "model": "current_expected_bid",
            "train_rows": len(train),
            "test_rows": len(current),
            "mae_sale_ratio": mean_absolute_error(current["sale_ratio"], current_pred),
            "rmse_sale_ratio": mean_squared_error(current["sale_ratio"], current_pred) ** 0.5,
        })
    outer_model_predictions = fit_regression_predictions(train, test, random_state)
    for name, pred in outer_model_predictions.items():
        results.append({
            "model": name,
            "train_rows": len(train),
            "test_rows": len(test),
            "mae_sale_ratio": mean_absolute_error(test["sale_ratio"], pred),
            "rmse_sale_ratio": mean_squared_error(test["sale_ratio"], pred) ** 0.5,
        })
        if name != "dummy_median":
            predictions[f"pred_{name}"] = pred

    inner_train, inner_validation = time_split(train, test_ratio=0.25)
    if len(inner_train) >= 30 and len(inner_validation) >= 10:
        weights, downside_buffer = fit_ensemble_validation(inner_train, inner_validation, random_state)
        outer_components = {
            name: values
            for name, values in outer_model_predictions.items()
            if name in weights
        }
        outer_components["group_median"] = group_median_predict(train, test)
        if "current_expected_bid" in weights:
            outer_components["current_expected_bid"] = current_expected_bid_predict(test)
        ensemble_pred = blend_predictions(outer_components, weights)
        conservative_pred = np.clip(ensemble_pred - downside_buffer, 0.001, 2.5)
        ensemble_rows = np.isfinite(ensemble_pred) & test["sale_ratio"].notna().to_numpy()
        if int(ensemble_rows.sum()) >= 10:
            results.append({
                "model": "ensemble_blend",
                "train_rows": len(train),
                "test_rows": int(ensemble_rows.sum()),
                "mae_sale_ratio": mean_absolute_error(test.loc[ensemble_rows, "sale_ratio"], ensemble_pred[ensemble_rows]),
                "rmse_sale_ratio": mean_squared_error(test.loc[ensemble_rows, "sale_ratio"], ensemble_pred[ensemble_rows]) ** 0.5,
                "blend_weights": weights,
                "downside_buffer": downside_buffer,
            })
            conservative_rows = np.isfinite(conservative_pred) & test["sale_ratio"].notna().to_numpy()
            results.append({
                "model": "ensemble_conservative",
                "train_rows": len(train),
                "test_rows": int(conservative_rows.sum()),
                "mae_sale_ratio": mean_absolute_error(test.loc[conservative_rows, "sale_ratio"], conservative_pred[conservative_rows]),
                "rmse_sale_ratio": mean_squared_error(test.loc[conservative_rows, "sale_ratio"], conservative_pred[conservative_rows]) ** 0.5,
                "blend_weights": weights,
                "downside_buffer": downside_buffer,
            })
            predictions["pred_group_median"] = outer_components["group_median"]
            predictions["pred_ensemble_blend"] = ensemble_pred
            predictions["pred_conservative_ensemble"] = conservative_pred
    return sorted(results, key=lambda r: r["mae_sale_ratio"]), predictions


def eval_rolling_ensemble(df: pd.DataFrame, random_state: int, n_splits: int = 3) -> list[dict]:
    """Evaluate the ensemble across several forward-only, purged time windows."""
    sold = df[df["sold"] & df["sale_ratio"].notna()].copy()
    results: list[dict] = []
    for fold_index, (train, test) in enumerate(rolling_time_splits(sold, n_splits=n_splits, test_ratio=0.2), start=1):
        inner_train, inner_validation = time_split(train, test_ratio=0.25)
        if len(inner_train) < 30 or len(inner_validation) < 10:
            continue
        weights, downside_buffer = fit_ensemble_validation(inner_train, inner_validation, random_state)
        model_predictions = fit_regression_predictions(train, test, random_state)
        components = {name: values for name, values in model_predictions.items() if name in weights}
        components["group_median"] = group_median_predict(train, test)
        if "current_expected_bid" in weights:
            components["current_expected_bid"] = current_expected_bid_predict(test)
        prediction = blend_predictions(components, weights)
        valid = np.isfinite(prediction) & test["sale_ratio"].notna().to_numpy()
        current = current_expected_bid_predict(test)
        current_valid = valid & np.isfinite(current)
        if int(valid.sum()) < 10:
            continue
        results.append({
            "fold": fold_index,
            "train_rows": len(train),
            "test_rows": int(valid.sum()),
            "ensemble_mae": mean_absolute_error(test.loc[valid, "sale_ratio"], prediction[valid]),
            "current_mae": mean_absolute_error(test.loc[current_valid, "sale_ratio"], current[current_valid]) if current_valid.any() else np.nan,
            "downside_buffer": downside_buffer,
        })
    return results


def eval_classifier(df: pd.DataFrame, random_state: int) -> list[dict]:
    sold = df[df["sold"] & df["realized_bid_margin"].notna()].copy()
    sold["positive_margin"] = sold["realized_bid_margin"] > 0
    train, test = time_split(sold)
    if len(train) < 30 or len(test) < 10 or train["positive_margin"].nunique() < 2 or test["positive_margin"].nunique() < 2 or not SKLEARN_AVAILABLE:
        return []
    preprocessor, features = make_preprocessor(train)
    results = []
    for name, model in classifier_models(random_state).items():
        pipe = Pipeline([("prep", preprocessor), ("model", model)])
        pipe.fit(train[features], train["positive_margin"])
        pred = pipe.predict(test[features])
        proba = pipe.predict_proba(test[features])[:, 1] if hasattr(pipe, "predict_proba") else pred.astype(float)
        results.append({
            "model": name,
            "train_rows": len(train),
            "test_rows": len(test),
            "accuracy": accuracy_score(test["positive_margin"], pred),
            "balanced_accuracy": balanced_accuracy_score(test["positive_margin"], pred),
            "roc_auc": roc_auc_score(test["positive_margin"], proba),
        })
    return sorted(results, key=lambda r: r["roc_auc"], reverse=True)


def eval_sale_outcome(df: pd.DataFrame, random_state: int) -> list[dict]:
    """Evaluate sold versus unsold only when trusted matched outcomes provide both classes."""
    labelled = df[df["matched"] & df["sold"].notna()].copy()
    if labelled.empty:
        return []
    labelled["sale_outcome"] = labelled["sold"].astype(bool)
    train, test = time_split(labelled)
    if (
        len(train) < 30
        or len(test) < 10
        or train["sale_outcome"].nunique() < 2
        or test["sale_outcome"].nunique() < 2
        or not SKLEARN_AVAILABLE
    ):
        return []
    preprocessor, features = make_preprocessor(train)
    results = []
    for name, model in classifier_models(random_state).items():
        pipe = Pipeline([("prep", preprocessor), ("model", model)])
        pipe.fit(train[features], train["sale_outcome"])
        pred = pipe.predict(test[features])
        proba = pipe.predict_proba(test[features])[:, 1] if hasattr(pipe, "predict_proba") else pred.astype(float)
        results.append({
            "model": name,
            "train_rows": len(train),
            "test_rows": len(test),
            "accuracy": accuracy_score(test["sale_outcome"], pred),
            "balanced_accuracy": balanced_accuracy_score(test["sale_outcome"], pred),
            "roc_auc": roc_auc_score(test["sale_outcome"], proba),
        })
    return sorted(results, key=lambda r: r["roc_auc"], reverse=True)


def feature_coverage(df: pd.DataFrame) -> pd.DataFrame:
    cols = [c for c in NUMERIC_FEATURES + CATEGORICAL_FEATURES if c in df.columns]
    rows = []
    for col in cols:
        rows.append({"feature": col, "non_null_rows": int(df[col].notna().sum()), "coverage": float(df[col].notna().mean()) if len(df) else 0.0})
    return pd.DataFrame(rows).sort_values(["coverage", "non_null_rows"], ascending=[True, False]).head(12)


def reference_price_performance(df: pd.DataFrame) -> dict:
    sold = df[df["sold"] & df["sale_ratio"].notna() & df["appraisal_value"].notna() & (df["appraisal_value"] > 0)].copy()
    groups = group_baseline(df).rename(columns={"rows": "sample_size"})
    if sold.empty or groups.empty:
        return {"rows": 0, "reference_mae": np.nan, "current_mae": np.nan, "reference_win_rate": np.nan}
    merged = sold.merge(groups[["property_type", "region", "median_sale_ratio"]], on=["property_type", "region"], how="inner")
    if merged.empty:
        return {"rows": 0, "reference_mae": np.nan, "current_mae": np.nan, "reference_win_rate": np.nan}
    merged["reference_abs_error"] = (merged["sale_ratio"] - merged["median_sale_ratio"]).abs()
    merged["current_abs_error"] = (merged["sale_ratio"] - merged["expected_bid"] / merged["appraisal_value"]).abs()
    comparable = merged[merged["current_abs_error"].notna()]
    return {
        "rows": int(len(merged)),
        "reference_mae": float(merged["reference_abs_error"].mean()),
        "current_mae": float(comparable["current_abs_error"].mean()) if len(comparable) else np.nan,
        "reference_win_rate": float((comparable["reference_abs_error"] < comparable["current_abs_error"]).mean()) if len(comparable) else np.nan,
    }


def rights_risk_review(df: pd.DataFrame) -> pd.DataFrame:
    if "risk_grade" not in df.columns:
        return pd.DataFrame()
    matched = df[df["matched"]].copy()
    if matched.empty:
        return pd.DataFrame()
    out = matched.groupby(matched["risk_grade"].fillna("unknown"), dropna=False).agg(
        rows=("case_no", "size"),
        sold=("sold", "sum"),
        sold_rate=("sold", "mean"),
        median_realized_margin=("realized_bid_margin", "median"),
        avg_assumed_amount=("assumed_amount", "mean"),
        opposition_rows=("has_opposition_tenant", "sum"),
    ).reset_index().sort_values("rows", ascending=False)
    return out


def surprise_cases(df: pd.DataFrame, top_n: int = 30) -> pd.DataFrame:
    rows = []
    sold = df[df["sold"]].copy()
    specs = [
        ("overpriced", sold[sold["residual_pct"] > 0].sort_values("residual_pct", ascending=False).head(top_n)),
        ("avoid_but_sold", sold[(sold["passed_filter"] == False) | (sold["recommendation"] == "avoid")].sort_values("sale_ratio", ascending=False).head(top_n)),
        ("passed_but_unsold", df[(df["matched"] == True) & (df["sold"] == False) & (df["passed_filter"] == True)].sort_values("total_score", ascending=False).head(top_n)),
    ]
    for kind, part in specs:
        for _, row in part.iterrows():
            rows.append({
                "surprise_kind": kind,
                "court": row.get("court"),
                "case_no": row.get("case_no"),
                "item_no": row.get("item_no"),
                "sale_date": row.get("sale_date"),
                "property_type": row.get("property_type"),
                "region": row.get("region"),
                "address": row.get("address"),
                "expected_bid": row.get("expected_bid"),
                "sold_amount": row.get("sold_amount"),
                "sale_ratio": row.get("sale_ratio"),
                "residual_pct": row.get("residual_pct"),
                "total_score": row.get("total_score"),
                "recommendation": row.get("recommendation"),
                "true_margin": row.get("true_margin"),
                "realized_bid_margin": row.get("realized_bid_margin"),
                "inq_cnt": row.get("inq_cnt"),
                "interest_cnt": row.get("interest_cnt"),
            })
    return pd.DataFrame(rows)


def group_baseline(df: pd.DataFrame) -> pd.DataFrame:
    sold = df[df["sold"] & df["sale_ratio"].notna()].copy()
    if sold.empty:
        return pd.DataFrame()
    grouped = sold.groupby(["property_type", "region"], dropna=False).agg(
        rows=("sale_ratio", "size"),
        median_sale_ratio=("sale_ratio", "median"),
        median_realized_margin=("realized_bid_margin", "median"),
    ).reset_index()
    return grouped[grouped["rows"] >= 5].sort_values(["rows", "median_sale_ratio"], ascending=[False, False]).head(20)


def table(rows: Iterable[dict], headers: list[str], formatters: dict[str, callable] | None = None) -> list[str]:
    rows = list(rows)
    if not rows:
        return ["_집계 가능한 행이 아직 부족합니다._"]
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    formatters = formatters or {}
    for row in rows:
        vals = []
        for h in headers:
            value = row.get(h)
            vals.append(str(formatters.get(h, lambda x: x)(value)))
        out.append("| " + " | ".join(vals) + " |")
    return out



AVM_BASIS_LABEL = {
    "building_area": "같은 건물·같은 면적",
    "building": "같은 건물",
    "dong_area": "같은 동·비슷한 면적",
    "dong": "같은 동",
    "sgg_area": "같은 시군구·비슷한 면적",
    "sgg": "같은 시군구",
    "no_area": "면적 없음",
    "no_comps": "거래 없음",
}
INPUT_SOURCE_LABEL = {"d7": "D-7 스냅샷", "d1": "D-1 스냅샷", "latest": "최신 행"}
RANKING_LABEL = {
    "model": "모델",
    "logistic": "로지스틱 회귀(같은 입력)",
    "model_without_rights": "모델 − 권리 입력",
    "model_plus_views": "모델 + 조회·관심 수",
    "cheapness": "최저가/보수 시세가 낮은 순",
    "current_score": "현재 점수(total_score)",
}


def ratio(value: float | None) -> str:
    return "-" if value is None or pd.isna(value) else f"{value:.3f}"


def avm_lines() -> list[str]:
    """Holdout accuracy written by ``npm run ml:avm``.

    Formatting lives in ``avm.avm_report_lines`` so this report cannot keep a
    second description of what the model was allowed to see.
    """
    path = Path("artifacts/ml/avm_metrics.json")
    if not path.exists():
        return [
            "## Market Value Model (AVM)",
            "_`npm run ml:avm` 결과(`artifacts/ml/avm_metrics.json`)가 없어 건너뛰었습니다._",
            "",
        ]
    metrics = json.loads(path.read_text(encoding="utf-8"))
    try:
        from .avm import avm_report_lines
    except ImportError:
        from avm import avm_report_lines
    return avm_report_lines(metrics)



def good_listing_lines(result: dict, tracking: dict) -> list[str]:
    try:
        from .good_listing import GOOD_MARGIN, LABEL_VERSION, MIN_TEST_ROWS
    except ImportError:
        from good_listing import GOOD_MARGIN, LABEL_VERSION, MIN_TEST_ROWS
    lines = [
        "## Good Listing Classification",
        f"- 라벨(`{LABEL_VERSION}`): 낙찰됐고, 보수 시세(AVM 80% 구간 하한과 감정가 중 낮은 값) 기준으로 "
        f"낙찰가·인수금액·취득세·명도비·채권비용을 뺀 순마진이 {GOOD_MARGIN:.0%} 이상.",
        "- 이 절은 탐색용 순마진 라벨이다. 주간 판정은 Bid Margin Decision 절이며, 여기 점수로 입찰·추천·상태를 바꾸지 않는다.",
        "- 입력: 감정가, 그 기일의 최저가, 면적, AVM 시세·구간·근거, 인수금액·대항력·권리등급, 법원·지역·종류.",
        "- 제외: 현재 점수·추천·예상낙찰가·`true_margin`(과거 스냅샷이 매각 뒤 다시 쓰였다), `fail_count`(최신 행이 이후 유찰을 센다), 조회·관심 수(스냅샷 없는 행은 매각 뒤 값), 낙찰가와 그 파생값.",
        "- 시간순 holdout만 기록한다. 운영 추천·입찰가·필터에는 반영하지 않는다.",
        f"- 매칭 {result.get('matched_rows', 0)}건 중 라벨 가능 {result.get('labelled_rows', 0)}건(AVM 시세가 있고, 인수금액이 시세의 10배를 넘는 파싱 오류가 아닌 행).",
    ]
    if result.get("status") != "ok":
        return lines + ["- 표본 또는 scikit-learn이 부족해 건너뛰었습니다.", ""]
    ranking_rows = [
        {"순위 기준": RANKING_LABEL.get(name, name), "AUC": row["auc"], "AP": row["average_precision"], "상위 10% 정밀도": row["precision_at_10"], "상위 5% 정밀도": row["precision_at_5"]}
        for name, row in result["rankings"].items()
    ]
    lines += [
        f"- 학습 {result['train_rows']}건 / 검증 {result['test_rows']}건({result['test_from']}~{result['test_to']}). "
        f"검증 낙찰률 {pct(result['test_sold_rate'])}, 좋은 매물 비율 {pct(result['test_good_rate'])}(낙찰 건의 {pct(result['good_share_of_sold'])}).",
        f"- 라벨과 낙찰 여부의 상관 {result['label_sold_correlation']:.3f}. 낙찰 건만 놓고 본 모델 AUC {result['sold_only_auc']:.3f} — 팔릴지가 아니라 남는지를 가르는 정도.",
        *table(ranking_rows, ["순위 기준", "AUC", "AP", "상위 10% 정밀도", "상위 5% 정밀도"], {
            "AUC": ratio, "AP": ratio, "상위 10% 정밀도": pct, "상위 5% 정밀도": pct,
        }),
        "",
        f"- 최저가에 사도 순마진이 {GOOD_MARGIN:.0%}에 못 미치는 행은 좋은 매물이 될 수 없어, 위 AUC의 상당 부분은 그 행을 걸러낸 값이다. "
        f"최저가 기준으로 가능성이 열린 {result['open_rows']}건(좋은 매물 {pct(result['open_good_rate'])})만 보면 "
        f"모델 AUC {ratio(result['open_auc']['model'])}, 최저가/보수 시세 {ratio(result['open_auc']['cheapness'])}, 현재 점수 {ratio(result['open_auc']['current_score'])}.",
        f"- 통과 필터 {result['passed_rows']}건의 정밀도 {pct(result['passed_precision'])}.",
        "- 라벨과 `최저가/시세` 입력이 같은 AVM 값을 쓰므로 시세 오차가 신호처럼 보일 수 있다. 오차가 가장 작은 '같은 건물' 근거 행의 AUC를 보수적인 값으로 본다.",
        *table(
            [{"구분": row["property_type"], "건수": row["rows"], "좋은 매물 비율": row["good_rate"], "AUC": row["auc"]} for row in result["by_type"]]
            + [{"구분": AVM_BASIS_LABEL.get(row["avm_basis"], row["avm_basis"]), "건수": row["rows"], "좋은 매물 비율": row["good_rate"], "AUC": row["auc"]} for row in result["by_basis"]],
            ["구분", "건수", "좋은 매물 비율", "AUC"], {"좋은 매물 비율": pct, "AUC": ratio},
        ),
        "",
        f"- 입력 시점별: 검증 {result['test_rows']}건 중 기일 전 스냅샷(D-7/D-1) 입력은 {result['point_in_time_rows']}건. "
        f"나머지는 최신 매물·분석 행이라 매각 뒤 값이 섞일 수 있다. 스냅샷 입력 행이 쌓이면 그 AUC를 기준으로 삼는다({MIN_TEST_ROWS}건 미만 구분은 표에서 뺀다).",
        *table(
            [{"입력": INPUT_SOURCE_LABEL.get(row["input_source"], row["input_source"]), "건수": row["rows"], "좋은 매물 비율": row["good_rate"], "AUC": row["auc"]} for row in result["by_source"]],
            ["입력", "건수", "좋은 매물 비율", "AUC"], {"좋은 매물 비율": pct, "AUC": ratio},
        ),
        "",
        "### Shadow 추적",
        "매각일 0시(KST) 전에 저장된 확률을 나중에 확정된 라벨과 맞춘다. 4주 이상 쌓인 뒤에 판단한다.",
    ]
    if not tracking.get("rows"):
        return lines + ["- 아직 결과가 확정된 저장 확률이 없습니다.", ""]
    lines.append(f"- {tracking['from']}~{tracking['to']}({tracking['days']}일) {tracking['rows']}건, 좋은 매물 비율 {pct(tracking['good_rate'])}.")
    if "model" in tracking:
        lines += table(
            [{"순위 기준": RANKING_LABEL[name], "AUC": tracking[name]["auc"], "AP": tracking[name]["average_precision"], "상위 10% 정밀도": tracking[name]["precision_at_10"]} for name in ("model", "current_score")],
            ["순위 기준", "AUC", "AP", "상위 10% 정밀도"], {"AUC": ratio, "AP": ratio, "상위 10% 정밀도": pct},
        )
    else:
        lines.append("- 좋은 매물과 아닌 매물이 모두 쌓이기 전이라 순위 지표는 아직 없습니다.")
    return lines + [""]


def frozen_decision_lines(random_state: int) -> list[str]:
    """Post-sale margin decision report. Missing frozen export is a skip, not a latest-row fallback."""
    path = Path("artifacts/ml/frozen_decisions.csv")
    try:
        from .good_listing import decision_lines, eval_bid_decision
    except ImportError:
        from good_listing import decision_lines, eval_bid_decision
    if not path.exists() or path.stat().st_size == 0:
        return [
            "## Post-sale Margin Decision",
            "- 동결 수출(`artifacts/ml/frozen_decisions.csv`)이 없어 건너뛰었습니다. 최신 매물 행으로 대체하지 않습니다.",
            "",
        ]
    return decision_lines(eval_bid_decision(pd.read_csv(path, dtype={"case_no": str, "item_no": str, "result_cd": str}), random_state))


def write_report(df: pd.DataFrame, output: Path, random_state: int) -> None:
    matched = df[df["matched"]]
    sold = matched[matched["sold"]]
    regression, predictions = eval_regression(df, random_state)
    rolling = eval_rolling_ensemble(df, random_state) if SKLEARN_AVAILABLE else []
    sale_outcome = eval_sale_outcome(df, random_state)
    classification = eval_classifier(df, random_state)
    try:
        from .good_listing import eval_good_listing, eval_shadow_tracking
    except ImportError:
        from good_listing import eval_good_listing, eval_shadow_tracking
    good_listing = eval_good_listing(df, random_state)
    shadow_tracking = eval_shadow_tracking(df)
    baseline = group_baseline(df)
    coverage = feature_coverage(df)
    ref_perf = reference_price_performance(df)
    rights_review = rights_risk_review(df)
    surprises = surprise_cases(df)

    lines = [
        "# Phase2 Offline ML Review",
        "",
        "이 리포트는 DB를 수정하지 않는 오프라인 복기입니다. 모델 결과는 운영 추천/입찰가에 자동 반영하지 않습니다.",
        "",
        "## Dataset",
        f"- Past snapshots: {len(df)}",
        f"- Matched outcomes: {len(matched)}",
        f"- Sold outcomes: {len(sold)}",
        f"- Sale-ratio labels: {int((sold['sale_ratio'].notna()).sum()) if len(sold) else 0}",
        f"- Positive realized margin rate: {pct(float((sold['realized_bid_margin'] > 0).mean())) if len(sold) else '-'}",
        f"- Point-in-time inputs (D-7/D-1): {int(df['feature_source'].isin(['d7', 'd1']).sum()) if 'feature_source' in df.columns else 0} / {len(df)}"
        " — 나머지는 최신 매물·분석 행에서 읽어 매각 뒤 값이 섞일 수 있음",
        "",
    ]
    if not SKLEARN_AVAILABLE:
        lines += [
            "## ML Models",
            "_scikit-learn이 설치되어 있지 않아 ML 모델은 건너뛰었습니다._",
            "",
            "설치 후 실행:",
            "",
            "```bash",
            "python3 -m pip install -r requirements-ml.txt",
            "npm run ml:eval",
            "```",
            "",
        ]
    else:
        lines += [
            "## Sale Ratio Regression",
            *table(regression, ["model", "train_rows", "test_rows", "mae_sale_ratio", "rmse_sale_ratio"], {
                "mae_sale_ratio": lambda x: f"{x:.4f}",
                "rmse_sale_ratio": lambda x: f"{x:.4f}",
            }),
            "",
            "## Sale Outcome Classification",
            *table(sale_outcome, ["model", "train_rows", "test_rows", "roc_auc", "balanced_accuracy", "accuracy"], {
                "roc_auc": lambda x: f"{x:.4f}",
                "balanced_accuracy": lambda x: f"{x:.4f}",
                "accuracy": lambda x: f"{x:.4f}",
            }),
            "",
            "## Positive Margin Classification",
            "이 절의 입력에는 `true_margin`이 남아 있다. 현재 결과 파일에서 `true_margin`과 실현 마진의 상관은 0.978이라, 여기 AUC는 의사결정 지표로 쓰지 않는다.",
            *table(classification, ["model", "train_rows", "test_rows", "roc_auc", "balanced_accuracy", "accuracy"], {
                "roc_auc": lambda x: f"{x:.4f}",
                "balanced_accuracy": lambda x: f"{x:.4f}",
                "accuracy": lambda x: f"{x:.4f}",
            }),
            "",
            *good_listing_lines(good_listing, shadow_tracking),
        ]
        ensemble_row = next((row for row in regression if row.get("model") == "ensemble_blend"), None)
        if ensemble_row:
            weights = ensemble_row.get("blend_weights", {})
            weight_text = ", ".join(f"{name}={value:.3f}" for name, value in weights.items())
            lines += [
                "## Ensemble Blend",
                f"- 내부 시간순 검증창에서 학습한 비음수 가중치: `{weight_text}`",
                f"- 과대예측 방지 하방 버퍼: `{ensemble_row.get('downside_buffer', 0.0):.4f}`",
                "- 외부 holdout에서만 성능을 기록했으며, 운영 추천·입찰가에는 아직 반영하지 않습니다.",
                "",
            ]
        lines += [
            "## Rolling Time Validation",
            *table(rolling, ["fold", "train_rows", "test_rows", "ensemble_mae", "current_mae", "downside_buffer"], {
                "ensemble_mae": lambda x: f"{x:.4f}",
                "current_mae": lambda x: f"{x:.4f}" if pd.notna(x) else "-",
                "downside_buffer": lambda x: f"{x:.4f}",
            }),
            "",
        ]
    lines += avm_lines()
    lines += frozen_decision_lines(random_state)

    lines += [
        "## Reference Price Performance",
        *table([ref_perf], ["rows", "reference_mae", "current_mae", "reference_win_rate"], {
            "reference_mae": lambda x: f"{x:.4f}" if pd.notna(x) else "-",
            "current_mae": lambda x: f"{x:.4f}" if pd.notna(x) else "-",
            "reference_win_rate": lambda x: f"{x:.3f}" if pd.notna(x) else "-",
        }),
        "",
        "## Rights Risk Review",
        *table(rights_review.to_dict("records"), ["risk_grade", "rows", "sold", "sold_rate", "median_realized_margin", "avg_assumed_amount", "opposition_rows"], {
            "sold_rate": lambda x: f"{x:.3f}" if pd.notna(x) else "-",
            "median_realized_margin": lambda x: f"{x:.3f}" if pd.notna(x) else "-",
            "avg_assumed_amount": lambda x: money(x) if pd.notna(x) else "-",
        }),
        "",
        "## Feature Coverage Watchlist",
        *table(coverage.to_dict("records"), ["feature", "non_null_rows", "coverage"], {
            "coverage": lambda x: f"{x * 100:.1f}%" if pd.notna(x) else "-",
        }),
        "",
        "## Surprise Review Cases",
        *table(surprises.head(15).to_dict("records"), ["surprise_kind", "case_no", "item_no", "region", "sale_ratio", "residual_pct", "total_score", "recommendation", "realized_bid_margin"], {
            "sale_ratio": lambda x: f"{x:.3f}" if pd.notna(x) else "-",
            "residual_pct": lambda x: f"{x:.3f}" if pd.notna(x) else "-",
            "realized_bid_margin": lambda x: f"{x:.3f}" if pd.notna(x) else "-",
        }),
        "",
        "## Group Median Baseline",
        *table(baseline.to_dict("records"), ["property_type", "region", "rows", "median_sale_ratio", "median_realized_margin"], {
            "median_sale_ratio": lambda x: f"{x:.3f}" if pd.notna(x) else "-",
            "median_realized_margin": lambda x: f"{x:.3f}" if pd.notna(x) else "-",
        }),
        "",
        "## Adoption Gate",
        "- 결과 미매칭률이 30% 미만으로 내려가기 전까지 운영 점수에 반영하지 않습니다.",
        "- 낙찰가율 라벨 150건 이상, 시간순 holdout에서 현재 `expected_bid`보다 MAE가 낮을 때만 후보로 봅니다.",
        "- `max_safe_bid` 기반 승률은 새 스냅샷부터 쌓이므로 최소 2주 관찰 후 판단합니다.",
        "",
    ]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines), encoding="utf-8")
    if predictions is not None:
        pred_path = Path("artifacts/ml/ml-regression-predictions.csv")
        pred_path.parent.mkdir(parents=True, exist_ok=True)
        predictions.to_csv(pred_path, index=False)
    surprise_path = Path("artifacts/ml/ml-surprises.csv")
    surprise_path.parent.mkdir(parents=True, exist_ok=True)
    surprises.to_csv(surprise_path, index=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=Path("artifacts/ml/outcome_eval.csv"))
    parser.add_argument("--output", type=Path, default=Path("docs/phase2/ml-offline-report.md"))
    parser.add_argument("--random-state", type=int, default=42)
    args = parser.parse_args()
    df = load_dataset(args.input)
    write_report(df, args.output, args.random_state)
    print(f"[ml:eval] report -> {args.output}")
    if not SKLEARN_AVAILABLE:
        print("[ml:eval] scikit-learn missing; wrote baseline report only")
    elif not XGBOOST_AVAILABLE:
        print("[ml:eval] xgboost missing; sklearn models completed")


if __name__ == "__main__":
    main()
