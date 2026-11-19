#!/usr/bin/env python3
"""Train the report-only ensemble and emit predictions for active listings.

Price shadows stay on gm_shadow_scores. The good-listing decision model is a separate call
(`--good-only`) and is never written into the price-shadow feature JSON.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

try:
    from .ensemble import blend_predictions, ensemble_confidence
    from .good_listing import MODEL_VERSION as DECISION_MODEL_VERSION
    from .offline_eval import (
        CATEGORICAL_FEATURES,
        NUMERIC_FEATURES,
        SKLEARN_AVAILABLE,
        ensemble_components,
        fit_ensemble_validation,
        load_dataset,
        time_split,
    )
except ImportError:
    from ensemble import blend_predictions, ensemble_confidence
    from good_listing import MODEL_VERSION as DECISION_MODEL_VERSION
    from offline_eval import (
        CATEGORICAL_FEATURES,
        NUMERIC_FEATURES,
        SKLEARN_AVAILABLE,
        ensemble_components,
        fit_ensemble_validation,
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
) -> tuple[pd.DataFrame, dict[str, float], float]:
    if not SKLEARN_AVAILABLE:
        raise RuntimeError("scikit-learn이 설치되어 있지 않습니다")
    labelled = train_frame[train_frame["sold"] & train_frame["sale_ratio"].notna()].copy()
    if len(labelled) < 30:
        raise RuntimeError(f"신뢰 가능한 낙찰가율 라벨이 부족합니다: {len(labelled)}건")

    inner_train, inner_validation = time_split(labelled, test_ratio=0.25)
    if len(inner_train) < 30 or len(inner_validation) < 10:
        raise RuntimeError("앙상블 가중치를 학습할 내부 시간순 검증창이 부족합니다")
    weights, downside_buffer = fit_ensemble_validation(inner_train, inner_validation, random_state)
    components = ensemble_components(labelled, predict_frame, random_state)
    selected_components = {name: components[name] for name in weights if name in components}
    prediction = np.clip(blend_predictions(selected_components, weights), 0.001, 2.5)
    conservative_prediction = np.clip(prediction - downside_buffer, 0.001, 2.5)
    confidence = ensemble_confidence(selected_components, weights)

    output_rows: list[dict[str, object]] = []
    try:
        from .good_listing import GOOD_MARGIN, LABEL_VERSION, conservative_value, score_upcoming
    except ImportError:
        from good_listing import GOOD_MARGIN, LABEL_VERSION, conservative_value, score_upcoming
    good_probability = score_upcoming(train_frame, predict_frame, random_state)
    good_value = conservative_value(predict_frame).to_numpy()
    for row_index, (_, row) in enumerate(predict_frame.iterrows()):
        snapshot = feature_snapshot(row)
        features = {
            "model_features": snapshot,
            "component_predictions": {
                name: json_value(values[row_index]) for name, values in selected_components.items()
            },
            "blend_weights": weights,
            "downside_buffer": downside_buffer,
        }
        # Exploratory net-margin attachment only. Decision probabilities go to gm_decision_probabilities.
        if good_probability is not None and np.isfinite(good_probability[row_index]):
            features["good_listing"] = {
                "probability": float(good_probability[row_index]),
                "version": LABEL_VERSION,
                "margin": GOOD_MARGIN,
                "conservative_value": float(good_value[row_index]),
                "decision": "report-only",
            }
        output_rows.append({
            "court": str(row.get("court", "")),
            "case_no": str(row.get("case_no", "")),
            "item_no": str(row.get("item_no", "1")),
            "sale_date": row["sale_date"].strftime("%Y-%m-%d") if isinstance(row.get("sale_date"), pd.Timestamp) else str(row.get("sale_date", "")),
            "predicted_sale_ratio": float(prediction[row_index]),
            "conservative_sale_ratio": float(conservative_prediction[row_index]),
            "confidence": float(confidence[row_index]),
            "feature_snapshot_hash": snapshot_hash(snapshot),
            "features_json": json.dumps(features, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False),
        })
    return pd.DataFrame(output_rows), weights, downside_buffer


GOOD_LISTING_DECISION_COLUMNS = ["court", "case_no", "item_no", "sale_date", "horizon_days", "probability"]


def load_frozen_frame(path: Path) -> pd.DataFrame:
    if not path.exists() or path.stat().st_size == 0:
        return pd.DataFrame(columns=GOOD_LISTING_DECISION_COLUMNS)
    return pd.read_csv(path)


def empty_good_listing_frame() -> pd.DataFrame:
    return pd.DataFrame(columns=GOOD_LISTING_DECISION_COLUMNS)


def _import_score_frozen_decisions():
    try:
        from .good_listing import score_frozen_decisions
    except ImportError:
        from good_listing import score_frozen_decisions
    return score_frozen_decisions


def score_good_listing_decisions(
    train_frame: pd.DataFrame,
    predict_frame: pd.DataFrame,
    random_state: int = 42,
) -> pd.DataFrame:
    """Call Label's scorer. An empty predict frame or an abstain (None) returns an empty frame.

    A missing function or any other error propagates. This does not recompute labels
    and does not fall back to the latest listing.
    """
    if predict_frame.empty:
        return empty_good_listing_frame()
    scored = _import_score_frozen_decisions()(train_frame, predict_frame, random_state)
    if scored is None or getattr(scored, "empty", True):
        print(f"[ml:shadow] {DECISION_MODEL_VERSION} 기권")
        return empty_good_listing_frame()
    return scored


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", type=Path)
    parser.add_argument("--predict", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--random-state", type=int, default=42)
    parser.add_argument("--good-only", action="store_true")
    parser.add_argument("--frozen-train", type=Path)
    parser.add_argument("--frozen-predict", type=Path)
    parser.add_argument("--good-output", type=Path)
    args = parser.parse_args()

    if args.good_only:
        if not args.frozen_train or not args.frozen_predict or not args.good_output:
            parser.error("good-only requires --frozen-train --frozen-predict --good-output")
        scored = score_good_listing_decisions(
            load_frozen_frame(args.frozen_train),
            load_frozen_frame(args.frozen_predict),
            args.random_state,
        )
        args.good_output.parent.mkdir(parents=True, exist_ok=True)
        scored.to_csv(args.good_output, index=False)
        print(f"[ml:shadow] {DECISION_MODEL_VERSION} {len(scored)} rows -> {args.good_output}")
        return

    if not args.train or not args.predict or not args.output:
        parser.error("price shadow requires --train --predict --output")

    train_frame = load_dataset(args.train)
    predict_frame = load_dataset(args.predict)
    if predict_frame.empty:
        pd.DataFrame(columns=[
            "court", "case_no", "item_no", "sale_date", "predicted_sale_ratio", "confidence",
            "conservative_sale_ratio", "feature_snapshot_hash", "features_json",
        ]).to_csv(args.output, index=False)
        print("[ml:shadow] 예측 대상이 없습니다")
        return

    predictions, weights, downside_buffer = train_and_predict(train_frame, predict_frame, args.random_state)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    predictions.to_csv(args.output, index=False)
    weight_text = ", ".join(f"{name}={value:.3f}" for name, value in weights.items())
    print(f"[ml:shadow] {len(predictions)} rows -> {args.output}")
    print(f"[ml:shadow] weights: {weight_text}")
    print(f"[ml:shadow] downside buffer: {downside_buffer:.4f}")


if __name__ == "__main__":
    main()
