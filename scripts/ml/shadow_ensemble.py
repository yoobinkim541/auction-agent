#!/usr/bin/env python3
"""Train the report-only ensemble and emit predictions for active listings."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

try:
    from .ensemble import blend_predictions, ensemble_confidence
    from .offline_eval import (
        CATEGORICAL_FEATURES,
        NUMERIC_FEATURES,
        SKLEARN_AVAILABLE,
        ensemble_components,
        fit_ensemble_weights,
        load_dataset,
        time_split,
    )
except ImportError:
    from ensemble import blend_predictions, ensemble_confidence
    from offline_eval import (
        CATEGORICAL_FEATURES,
        NUMERIC_FEATURES,
        SKLEARN_AVAILABLE,
        ensemble_components,
        fit_ensemble_weights,
        load_dataset,
        time_split,
    )


def json_value(value: object) -> object:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, (np.integer, np.floating, np.bool_)):
        return value.item()
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    return value


def feature_snapshot(row: pd.Series) -> dict[str, object]:
    return {
        name: json_value(row.get(name))
        for name in NUMERIC_FEATURES + CATEGORICAL_FEATURES
        if name in row
    }


def snapshot_hash(snapshot: dict[str, object]) -> str:
    encoded = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def train_and_predict(
    train_frame: pd.DataFrame,
    predict_frame: pd.DataFrame,
    random_state: int,
) -> tuple[pd.DataFrame, dict[str, float]]:
    if not SKLEARN_AVAILABLE:
        raise RuntimeError("scikit-learn이 설치되어 있지 않습니다")
    labelled = train_frame[train_frame["sold"] & train_frame["sale_ratio"].notna()].copy()
    if len(labelled) < 30:
        raise RuntimeError(f"신뢰 가능한 낙찰가율 라벨이 부족합니다: {len(labelled)}건")

    inner_train, inner_validation = time_split(labelled, test_ratio=0.25)
    if len(inner_train) < 30 or len(inner_validation) < 10:
        raise RuntimeError("앙상블 가중치를 학습할 내부 시간순 검증창이 부족합니다")
    weights = fit_ensemble_weights(inner_train, inner_validation, random_state)
    components = ensemble_components(labelled, predict_frame, random_state)
    selected_components = {name: components[name] for name in weights if name in components}
    prediction = np.clip(blend_predictions(selected_components, weights), 0.001, 2.5)
    confidence = ensemble_confidence(selected_components, weights)

    output_rows: list[dict[str, object]] = []
    for row_index, (_, row) in enumerate(predict_frame.iterrows()):
        snapshot = feature_snapshot(row)
        output_rows.append({
            "case_no": str(row.get("case_no", "")),
            "item_no": str(row.get("item_no", "1")),
            "sale_date": row["sale_date"].strftime("%Y-%m-%d") if isinstance(row.get("sale_date"), pd.Timestamp) else str(row.get("sale_date", "")),
            "predicted_sale_ratio": float(prediction[row_index]),
            "confidence": float(confidence[row_index]),
            "feature_snapshot_hash": snapshot_hash(snapshot),
            "features_json": json.dumps({
                "model_features": snapshot,
                "component_predictions": {
                    name: json_value(values[row_index]) for name, values in selected_components.items()
                },
                "blend_weights": weights,
            }, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False),
        })
    return pd.DataFrame(output_rows), weights


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", type=Path, required=True)
    parser.add_argument("--predict", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--random-state", type=int, default=42)
    args = parser.parse_args()

    train_frame = load_dataset(args.train)
    predict_frame = load_dataset(args.predict)
    if predict_frame.empty:
        pd.DataFrame(columns=[
            "case_no", "item_no", "sale_date", "predicted_sale_ratio", "confidence",
            "feature_snapshot_hash", "features_json",
        ]).to_csv(args.output, index=False)
        print("[ml:shadow] 예측 대상이 없습니다")
        return

    predictions, weights = train_and_predict(train_frame, predict_frame, args.random_state)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    predictions.to_csv(args.output, index=False)
    weight_text = ", ".join(f"{name}={value:.3f}" for name, value in weights.items())
    print(f"[ml:shadow] {len(predictions)} rows -> {args.output}")
    print(f"[ml:shadow] weights: {weight_text}")


if __name__ == "__main__":
    main()
