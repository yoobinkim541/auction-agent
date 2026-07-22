#!/usr/bin/env python3
"""Phase2 offline ML evaluation.

This is deliberately read-only and report-only: it never writes predictions back to DB.
It compares simple statistical baselines against sklearn/XGBoost models when available.
"""
from __future__ import annotations

import argparse
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
    "min_bid_ratio",
    "expected_to_appraisal",
    "min_to_appraisal",
    "expected_to_min",
    "market_to_appraisal",
]
CATEGORICAL_FEATURES = ["property_type", "court", "recommendation", "region"]


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
    for col in ["matched", "sold", "passed_filter", "would_have_won_under_max_safe_bid", "has_opposition_tenant"]:
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
    return df.sort_values(["sale_date", "case_no", "item_no"])


def time_split(df: pd.DataFrame, test_ratio: float = 0.3) -> tuple[pd.DataFrame, pd.DataFrame]:
    if len(df) < 2:
        return df.copy(), df.iloc[0:0].copy()
    cut = max(1, min(len(df) - 1, int(math.floor(len(df) * (1 - test_ratio)))))
    return df.iloc[:cut].copy(), df.iloc[cut:].copy()


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
        ("num", Pipeline([("impute", SimpleImputer(strategy="median"))]), numeric),
        ("cat", Pipeline([("impute", SimpleImputer(strategy="most_frequent")), ("onehot", OneHotEncoder(handle_unknown="ignore", min_frequency=5, sparse_output=False))]), categorical),
    ]), numeric + categorical


def regression_models(random_state: int):
    models = {
        "dummy_median": DummyRegressor(strategy="median"),
        "hist_gbr": HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, l2_regularization=0.05, random_state=random_state),
    }
    if XGBOOST_AVAILABLE:
        models["xgboost"] = XGBRegressor(n_estimators=250, max_depth=3, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9, objective="reg:squarederror", random_state=random_state)
    return models


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
    preprocessor, features = make_preprocessor(train)
    results = []
    predictions = test[["case_no", "item_no", "sale_date", "address", "sale_ratio", "expected_bid", "sold_amount"]].copy()
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
    for name, model in regression_models(random_state).items():
        pipe = Pipeline([("prep", preprocessor), ("model", model)])
        pipe.fit(train[features], train["sale_ratio"])
        pred = np.clip(pipe.predict(test[features]), 0, 2.5)
        results.append({
            "model": name,
            "train_rows": len(train),
            "test_rows": len(test),
            "mae_sale_ratio": mean_absolute_error(test["sale_ratio"], pred),
            "rmse_sale_ratio": mean_squared_error(test["sale_ratio"], pred) ** 0.5,
        })
        if name != "dummy_median":
            predictions[f"pred_{name}"] = pred
    return sorted(results, key=lambda r: r["mae_sale_ratio"]), predictions


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


def write_report(df: pd.DataFrame, output: Path, random_state: int) -> None:
    matched = df[df["matched"]]
    sold = matched[matched["sold"]]
    regression, predictions = eval_regression(df, random_state)
    classification = eval_classifier(df, random_state)
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
            "## Positive Margin Classification",
            *table(classification, ["model", "train_rows", "test_rows", "roc_auc", "balanced_accuracy", "accuracy"], {
                "roc_auc": lambda x: f"{x:.4f}",
                "balanced_accuracy": lambda x: f"{x:.4f}",
                "accuracy": lambda x: f"{x:.4f}",
            }),
            "",
        ]
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
