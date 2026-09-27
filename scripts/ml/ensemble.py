"""Small, dependency-light helpers shared by offline and shadow ensembles."""
from __future__ import annotations

from collections.abc import Mapping

import numpy as np
import pandas as pd


def normalize_weights(weights: Mapping[str, float]) -> dict[str, float]:
    """Return non-negative simplex weights without silently accepting bad values."""
    normalized: dict[str, float] = {}
    for name, value in weights.items():
        numeric_value = float(value)
        if not np.isfinite(numeric_value) or numeric_value < 0:
            raise ValueError(f"invalid ensemble weight for {name}: {value}")
        normalized[name] = numeric_value
    total = sum(normalized.values())
    if not normalized or total <= 0:
        raise ValueError("ensemble weights must contain positive mass")
    return {name: value / total for name, value in normalized.items()}


def blend_predictions(
    predictions: Mapping[str, np.ndarray],
    weights: Mapping[str, float],
    clip: tuple[float, float] | None = (0.0, 2.5),
) -> np.ndarray:
    """Blend available components row-wise and renormalize around missing values."""
    normalized = normalize_weights(weights)
    if not predictions:
        raise ValueError("at least one prediction component is required")

    arrays = {name: np.asarray(values, dtype=float).reshape(-1) for name, values in predictions.items()}
    row_count = len(next(iter(arrays.values())))
    if any(len(values) != row_count for values in arrays.values()):
        raise ValueError("prediction components must have the same row count")

    numerator = np.zeros(row_count, dtype=float)
    denominator = np.zeros(row_count, dtype=float)
    for name, weight in normalized.items():
        if name not in arrays:
            continue
        values = arrays[name]
        available = np.isfinite(values)
        numerator[available] += values[available] * weight
        denominator[available] += weight

    result = np.full(row_count, np.nan, dtype=float)
    available_rows = denominator > 0
    result[available_rows] = numerator[available_rows] / denominator[available_rows]
    if clip is not None:
        result[available_rows] = np.clip(result[available_rows], clip[0], clip[1])
    return result


def _project_simplex(values: np.ndarray) -> np.ndarray:
    """Project a vector onto non-negative values summing to one."""
    sorted_values = np.sort(values)[::-1]
    cumulative = np.cumsum(sorted_values)
    indexes = np.arange(1, len(values) + 1)
    valid = sorted_values - (cumulative - 1.0) / indexes > 0
    if not np.any(valid):
        return np.full(len(values), 1.0 / len(values))
    threshold_index = indexes[valid][-1] - 1
    threshold = (cumulative[threshold_index] - 1.0) / (threshold_index + 1)
    return np.maximum(values - threshold, 0.0)


def fit_nonnegative_blend_weights(
    target: np.ndarray,
    predictions: Mapping[str, np.ndarray],
    l2_penalty: float = 0.001,
    max_steps: int = 2000,
) -> dict[str, float]:
    """Fit a deterministic non-negative simplex blend on a validation window."""
    if not predictions:
        raise ValueError("at least one prediction component is required")
    target_values = np.asarray(target, dtype=float).reshape(-1)
    component_names = list(predictions)
    component_matrix = np.column_stack([
        np.asarray(predictions[name], dtype=float).reshape(-1)
        for name in component_names
    ])
    if component_matrix.shape[0] != len(target_values):
        raise ValueError("target and prediction row counts must match")
    valid_rows = np.isfinite(target_values) & np.isfinite(component_matrix).all(axis=1)
    if not np.any(valid_rows):
        return normalize_weights({name: 1.0 for name in component_names})
    target_values = target_values[valid_rows]
    component_matrix = component_matrix[valid_rows]

    weight_vector = np.full(len(component_names), 1.0 / len(component_names))
    spectral_norm = np.linalg.norm(component_matrix, ord=2)
    lipschitz = max(2.0 * spectral_norm * spectral_norm / len(target_values) + 2.0 * l2_penalty, 1e-8)
    learning_rate = 1.0 / lipschitz
    for _ in range(max_steps):
        residual = component_matrix @ weight_vector - target_values
        gradient = 2.0 * (component_matrix.T @ residual) / len(target_values) + 2.0 * l2_penalty * weight_vector
        next_weights = _project_simplex(weight_vector - learning_rate * gradient)
        if np.max(np.abs(next_weights - weight_vector)) < 1e-10:
            weight_vector = next_weights
            break
        weight_vector = next_weights
    return normalize_weights(dict(zip(component_names, weight_vector)))


def group_median_predict(
    train_df: pd.DataFrame,
    target_df: pd.DataFrame,
    min_group_rows: int = 5,
) -> np.ndarray:
    """Predict sale ratio from train-only property-type × region medians."""
    required = {"property_type", "region", "sale_ratio"}
    if not required.issubset(train_df.columns):
        return np.full(len(target_df), np.nan, dtype=float)
    labelled = train_df[train_df["sale_ratio"].notna()].copy()
    if labelled.empty:
        return np.full(len(target_df), np.nan, dtype=float)
    target_keys = target_df[["property_type", "region"]].copy()
    labelled["_ensemble_property_type"] = labelled["property_type"].fillna("unknown").astype(str)
    labelled["_ensemble_region"] = labelled["region"].fillna("unknown").astype(str)
    target_keys["_ensemble_property_type"] = target_keys["property_type"].fillna("unknown").astype(str)
    target_keys["_ensemble_region"] = target_keys["region"].fillna("unknown").astype(str)
    grouped = labelled.groupby(["_ensemble_property_type", "_ensemble_region"], dropna=False)["sale_ratio"].agg(["count", "median"])
    grouped = grouped[grouped["count"] >= min_group_rows]
    global_median = float(labelled["sale_ratio"].median())
    keys = pd.MultiIndex.from_frame(target_keys[["_ensemble_property_type", "_ensemble_region"]])
    group_values = grouped["median"].reindex(keys).to_numpy(dtype=float)
    return np.where(np.isfinite(group_values), group_values, global_median)


def current_expected_bid_predict(frame: pd.DataFrame) -> np.ndarray:
    """Return the existing expected-bid ratio as a baseline component."""
    if not {"expected_bid", "appraisal_value"}.issubset(frame.columns):
        return np.full(len(frame), np.nan, dtype=float)
    appraisal = pd.to_numeric(frame["appraisal_value"], errors="coerce").to_numpy(dtype=float)
    expected = pd.to_numeric(frame["expected_bid"], errors="coerce").to_numpy(dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        result = expected / appraisal
    result[~np.isfinite(result)] = np.nan
    return np.clip(result, 0.0, 2.5)


def ensemble_confidence(predictions: Mapping[str, np.ndarray], weights: Mapping[str, float]) -> np.ndarray:
    """Produce an auditable confidence proxy from component coverage and agreement."""
    normalized = normalize_weights(weights)
    arrays = {name: np.asarray(values, dtype=float).reshape(-1) for name, values in predictions.items()}
    row_count = len(next(iter(arrays.values())))
    confidence = np.zeros(row_count, dtype=float)
    for row_index in range(row_count):
        available = [
            (name, arrays[name][row_index], normalized[name])
            for name in normalized
            if name in arrays and np.isfinite(arrays[name][row_index])
        ]
        if not available:
            continue
        available_weights = np.array([item[2] for item in available], dtype=float)
        available_weights /= available_weights.sum()
        available_values = np.array([item[1] for item in available], dtype=float)
        weighted_mean = float(np.dot(available_values, available_weights))
        weighted_variance = float(np.dot((available_values - weighted_mean) ** 2, available_weights))
        agreement = max(0.0, 1.0 - np.sqrt(weighted_variance) / 0.5)
        coverage = float(sum(item[2] for item in available))
        confidence[row_index] = np.clip(agreement * coverage, 0.0, 1.0)
    return confidence
