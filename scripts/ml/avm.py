#!/usr/bin/env python3
"""Report-only market value model (AVM) trained on MOLIT sale trades.

Every estimate is point-in-time. A target valued on day ``t`` only sees
trades contracted in ``(t - GAP_DAYS - WINDOW_DAYS, t - GAP_DAYS]``: sale
contracts may be reported up to 30 days late, so anything newer is not
reliably known on day ``t``. Training rows are trades valued on their own
contract day, which excludes the trade itself the same way.

The model predicts log(price per m2) relative to the tightest available
comparable median (the anchor), so it transfers across price levels and
months without needing a time index.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import xgboost as xgb

    XGBOOST_AVAILABLE = True
except Exception:
    XGBOOST_AVAILABLE = False

GAP_DAYS = 30
WINDOW_DAYS = 365
TREND_DAYS = 90
SAME_UNIT_TOLERANCE = 0.05   # same floor plan inside one building
AREA_BAND_TOLERANCE = 0.15   # comparable size across buildings
MIN_AREA_COMPS = 3           # dong/sgg medians need this many trades
WARMUP_DAYS = 120            # training rows need this much history before them
CALIBRATION_DAYS = 60
EVAL_TEST_DAYS = 90
FORWARD_DAYS = 180           # how far ahead later trades of the same unit are looked up
BAND_COVERAGE = 0.80
QUANTILES = (0.10, 0.50, 0.90)
KIND_CODE = {"apt": 0, "rh": 1, "offi": 2}
EPOCH = pd.Timestamp("2000-01-01")

# Anchor order: tightest comparable set first.
ANCHORS = [
    ("building_area", "b_area_med"),
    ("building", "b_med"),
    ("dong_area", "d_area_med"),
    ("dong", "d_med"),
    ("sgg_area", "s_area_med"),
    ("sgg", "s_med"),
]
FEATURES = [
    "kind_code", "log_area", "floor", "direct", "anchor_level", "anchor",
    "b_n", "b_area_n", "b_last_age", "b_last_rel", "b_med_rel", "b_area_med_rel", "building_age",
    "d_n", "d_area_n", "d_med_rel", "d_area_med_rel",
    "s_n", "s_area_n", "s_med_rel", "s_area_med_rel", "s_trend",
]


@dataclass
class Group:
    day: np.ndarray        # ascending
    log_ppm2: np.ndarray
    area: np.ndarray
    price: np.ndarray
    build_year: np.ndarray


def day_number(dates: pd.Series) -> pd.Series:
    return (pd.to_datetime(dates, errors="coerce") - EPOCH).dt.days


def building_key(frame: pd.DataFrame) -> pd.Series:
    """Lot number identifies a building; trades without one fall back to the name."""
    jibun = frame["jibun"].astype("string").str.strip() if "jibun" in frame.columns else pd.Series(pd.NA, index=frame.index, dtype="string")
    name = frame["name"].astype("string").str.replace(r"\s+", "", regex=True) if "name" in frame.columns else pd.Series(pd.NA, index=frame.index, dtype="string")
    return jibun.where(jibun.notna() & (jibun != ""), "n:" + name)


def prepare_trades(frame: pd.DataFrame) -> pd.DataFrame:
    trades = frame.copy()
    trades["area_m2"] = pd.to_numeric(trades["area_m2"], errors="coerce")
    trades["price"] = pd.to_numeric(trades["price"], errors="coerce")
    trades["day"] = day_number(trades["deal_date"])
    trades["sgg"] = trades["sgg"].astype(str)
    trades["dong"] = trades["dong"].astype("string").str.strip()
    trades["bkey"] = building_key(trades)
    trades["direct"] = trades["direct"].astype(str).str.lower().isin(["true", "t", "1"]).astype(float)
    for column in ("floor", "build_year"):
        trades[column] = pd.to_numeric(trades[column], errors="coerce") if column in trades.columns else np.nan
    trades = trades[
        trades["kind"].isin(list(KIND_CODE))
        & trades["day"].notna()
        & trades["dong"].notna()
        & trades["area_m2"].between(10, 400)
        & trades["price"].between(10_000_000, 100_000_000_000)
    ].copy()
    trades["day"] = trades["day"].astype(int)
    trades["log_ppm2"] = np.log(trades["price"] / trades["area_m2"])
    return trades.sort_values("day", kind="stable").reset_index(drop=True)


def resolve_building_keys(targets: pd.DataFrame, index: dict[str, dict[tuple, Group]]) -> pd.Series:
    """Match targets to buildings whose trades only carry a name.

    Court listings have a lot number, but officetel trades come without one. Where
    the lot number matches nothing, use the building name, letting one name be a
    prefix of the other ('센트라움주건축물' against '센트라움').
    """
    names: dict[tuple, list[str]] = {}
    for kind, sgg, dong, key in index["building"]:
        if isinstance(key, str) and key.startswith("n:"):
            names.setdefault((kind, sgg, dong), []).append(key[2:])
    keys = targets["bkey"].astype(object).to_numpy().copy()
    if not names or "name" not in targets.columns:
        return pd.Series(keys, index=targets.index, dtype="string")
    target_names = targets["name"].astype("string").str.replace(r"\s+", "", regex=True).astype(object).to_numpy()
    places = zip(targets["kind"].astype(object), targets["sgg"].astype(object), targets["dong"].astype(object))
    for row, place in enumerate(places):
        candidates = names.get(place)
        name = target_names[row]
        if not candidates or not isinstance(name, str) or (*place, keys[row]) in index["building"]:
            continue
        matches = [
            candidate for candidate in candidates
            if min(len(candidate), len(name)) >= 3 and (name.startswith(candidate) or candidate.startswith(name))
        ]
        if matches:
            keys[row] = "n:" + max(matches, key=len)
    return pd.Series(keys, index=targets.index, dtype="string")


def prepare_targets(frame: pd.DataFrame, index: dict[str, dict[tuple, Group]] | None = None) -> pd.DataFrame:
    targets = frame.copy()
    targets["area_m2"] = pd.to_numeric(targets["area_m2"], errors="coerce")
    targets["floor"] = pd.to_numeric(targets["floor"], errors="coerce") if "floor" in targets.columns else np.nan
    targets["day"] = day_number(targets["as_of"])
    targets["sgg"] = targets["sgg"].astype("string").str.replace(r"\.0$", "", regex=True)
    targets["dong"] = targets["dong"].astype("string").str.strip()
    targets["bkey"] = building_key(targets)
    if index is not None:
        targets["bkey"] = resolve_building_keys(targets, index)
    targets["direct"] = 0.0
    return targets


def build_index(trades: pd.DataFrame) -> dict[str, dict[tuple, Group]]:
    """Trades must already be sorted by day."""
    levels = {"building": ["kind", "sgg", "dong", "bkey"], "dong": ["kind", "sgg", "dong"], "sgg": ["kind", "sgg"]}
    arrays = {name: trades[name].to_numpy() for name in ("day", "log_ppm2", "area_m2", "price", "build_year")}
    index: dict[str, dict[tuple, Group]] = {}
    for level, keys in levels.items():
        index[level] = {
            (key if isinstance(key, tuple) else (key,)): Group(
                arrays["day"][rows], arrays["log_ppm2"][rows], arrays["area_m2"][rows], arrays["price"][rows], arrays["build_year"][rows],
            )
            for key, rows in trades.groupby(keys, sort=False, dropna=True).indices.items()
        }
    return index


def _median(values: np.ndarray) -> float:
    return float(np.median(values)) if len(values) else np.nan


def comp_features(index: dict[str, dict[tuple, Group]], targets: pd.DataFrame) -> pd.DataFrame:
    """Comparable statistics for each target, from trades known on its valuation day.

    Also returns ``tier_price``: the current rule in pipeline/location/comps.ts
    (same building, then dong, then district; median of the 20 latest prices),
    given the same information.
    """
    count = len(targets)
    names = [
        "b_n", "b_med", "b_area_n", "b_area_med", "b_last", "b_last_age", "b_build_year",
        "d_n", "d_med", "d_area_n", "d_area_med",
        "s_n", "s_med", "s_area_n", "s_area_med", "s_trend",
        "tier_price", "tier_level",
    ]
    out = {name: np.full(count, np.nan) for name in names}
    for name in ("b_n", "b_area_n", "d_n", "d_area_n", "s_n", "s_area_n"):
        out[name][:] = 0.0
    day = targets["day"].to_numpy(dtype=float)
    area = targets["area_m2"].to_numpy(dtype=float)
    tier: list[list[np.ndarray | None]] = [[None] * 4 for _ in range(count)]

    def latest(prices: np.ndarray) -> np.ndarray:
        return prices[-20:]

    level_keys = {"building": ["kind", "sgg", "dong", "bkey"], "dong": ["kind", "sgg", "dong"], "sgg": ["kind", "sgg"]}
    for level, keys in level_keys.items():
        prefix = level[0]
        for key, rows in targets.groupby(keys, sort=False, dropna=True).indices.items():
            group = index[level].get(key if isinstance(key, tuple) else (key,))
            if group is None:
                continue
            high = np.searchsorted(group.day, day[rows] - GAP_DAYS, side="right")
            low = np.searchsorted(group.day, day[rows] - GAP_DAYS - WINDOW_DAYS, side="right")
            for row, start, stop in zip(rows, low, high):
                if stop <= start:
                    continue
                values = group.log_ppm2[start:stop]
                areas = group.area[start:stop]
                prices = group.price[start:stop]
                out[f"{prefix}_n"][row] = stop - start
                out[f"{prefix}_med"][row] = _median(values)
                target_area = area[row]
                has_area = np.isfinite(target_area) and target_area > 0
                band = np.abs(areas - target_area) <= target_area * AREA_BAND_TOLERANCE if has_area else np.zeros(stop - start, dtype=bool)
                if level == "building":
                    same = np.abs(areas - target_area) <= target_area * SAME_UNIT_TOLERANCE if has_area else band
                    out["b_area_n"][row] = int(same.sum())
                    out["b_area_med"][row] = _median(values[same])
                    out["b_last"][row] = values[-1]
                    out["b_last_age"][row] = day[row] - group.day[stop - 1]
                    years = group.build_year[start:stop]
                    years = years[np.isfinite(years)]
                    out["b_build_year"][row] = _median(years)
                    if band.sum() >= 2:
                        tier[row][0] = latest(prices[band])
                else:
                    out[f"{prefix}_area_n"][row] = int(band.sum())
                    if band.sum() >= MIN_AREA_COMPS:
                        out[f"{prefix}_area_med"][row] = _median(values[band])
                    if level == "dong":
                        if band.sum() >= 3:
                            tier[row][1] = latest(prices[band])
                        if stop - start >= 3:
                            tier[row][2] = latest(prices)
                    else:
                        if band.sum() >= 3:
                            tier[row][3] = latest(prices[band])
                        recent = group.day[start:stop] > day[row] - GAP_DAYS - TREND_DAYS
                        if recent.sum() >= MIN_AREA_COMPS:
                            out["s_trend"][row] = _median(values[recent]) - out["s_med"][row]
    for row in range(count):
        for level, prices in enumerate(tier[row]):
            if prices is not None:
                out["tier_price"][row] = _median(prices)
                out["tier_level"][row] = level
                break
    for name in ("d_med", "s_med"):
        prefix = name[0]
        out[name] = np.where(out[f"{prefix}_n"] >= MIN_AREA_COMPS, out[name], np.nan)
    return pd.DataFrame(out, index=targets.index)


def design_matrix(targets: pd.DataFrame, comps: pd.DataFrame) -> pd.DataFrame:
    """Model inputs. ``anchor`` is NaN when no comparable set exists at any level."""
    frame = pd.DataFrame(index=targets.index)
    anchor = pd.Series(np.nan, index=targets.index)
    level = pd.Series(np.nan, index=targets.index)
    basis = pd.Series("no_comps", index=targets.index, dtype=object)
    for position, (label, column) in enumerate(ANCHORS):
        take = anchor.isna() & comps[column].notna()
        anchor = anchor.where(~take, comps[column])
        level = level.where(~take, float(position))
        basis = basis.where(~take, label)
    area = pd.to_numeric(targets["area_m2"], errors="coerce")
    frame["kind_code"] = targets["kind"].map(KIND_CODE).astype(float)
    frame["log_area"] = np.log(area.where(area > 0))
    frame["floor"] = pd.to_numeric(targets["floor"], errors="coerce")
    frame["direct"] = pd.to_numeric(targets["direct"], errors="coerce")
    frame["anchor_level"] = level
    frame["anchor"] = anchor
    for column in ("b_n", "b_area_n", "b_last_age", "d_n", "d_area_n", "s_n", "s_area_n", "s_trend"):
        frame[column] = comps[column]
    for column in ("b_last", "b_med", "b_area_med", "d_med", "d_area_med", "s_med", "s_area_med"):
        frame[f"{column}_rel"] = comps[column] - anchor
    year = EPOCH.year + targets["day"] / 365.25
    frame["building_age"] = year - comps["b_build_year"]
    frame["basis"] = basis
    return frame


def fit(features: pd.DataFrame, target: pd.Series, random_state: int = 42):
    if not XGBOOST_AVAILABLE:
        raise RuntimeError("xgboost가 설치되어 있지 않습니다")
    model = xgb.XGBRegressor(
        objective="reg:quantileerror",
        quantile_alpha=np.array(QUANTILES),
        tree_method="hist",
        n_estimators=400,
        learning_rate=0.05,
        max_depth=6,
        min_child_weight=20,
        subsample=0.8,
        colsample_bytree=0.8,
        n_jobs=4,
        random_state=random_state,
    )
    model.fit(features[FEATURES], target)
    return model


def predict_quantiles(model, features: pd.DataFrame) -> np.ndarray:
    """Residual quantiles (low, mid, high) relative to the anchor, never crossing."""
    if features.empty:
        return np.empty((0, len(QUANTILES)))
    return np.sort(np.asarray(model.predict(features[FEATURES])).reshape(len(features), len(QUANTILES)), axis=1)


def conformal_offset(quantiles: np.ndarray, actual: np.ndarray, coverage: float = BAND_COVERAGE) -> float:
    """Widen (or narrow) the band so it covers ``coverage`` of held-out trades."""
    if len(actual) == 0:
        return 0.0
    scores = np.maximum(quantiles[:, 0] - actual, actual - quantiles[:, -1])
    rank = min(1.0, coverage * (1 + 1 / len(scores)))
    return float(np.quantile(scores, rank))


def fit_calibrated(trades: pd.DataFrame, design: pd.DataFrame, usable: pd.Series, before_day: float, random_state: int = 42):
    """Model on every usable trade before ``before_day``, with a band offset it did not help set.

    The offset comes from a first model that stops CALIBRATION_DAYS earlier and is scored on
    that window. The returned model is fitted again with the window included: a model left
    60 days stale covered 77-80% of later trades over three periods, the refitted one 80-82%.
    Returns (model, offset, first model); the first model has not seen the calibration window.
    """
    residual = trades["log_ppm2"] - design["anchor"]
    known = usable & (trades["day"] < before_day)
    calibration = known & (trades["day"] >= before_day - CALIBRATION_DAYS)
    held_out = fit(design[known & ~calibration], residual[known & ~calibration], random_state)
    offset = conformal_offset(predict_quantiles(held_out, design[calibration]), residual[calibration].to_numpy())
    return fit(design[known], residual[known], random_state), offset, held_out


def error_metrics(predicted: np.ndarray, actual: np.ndarray, total: int) -> dict[str, float | int]:
    """Errors in price terms. ``coverage`` is the share of rows that got an estimate."""
    valid = np.isfinite(predicted) & np.isfinite(actual) & (actual > 0)
    if not valid.any():
        return {"rows": int(total), "coverage": 0.0, "mdape": float("nan"), "within_10": float("nan"), "within_20": float("nan"), "bias": float("nan")}
    signed = predicted[valid] / actual[valid] - 1
    return {
        "rows": int(total),
        "coverage": float(valid.sum() / total) if total else 0.0,
        "mdape": float(np.median(np.abs(signed))),
        "within_10": float((np.abs(signed) <= 0.10).mean()),
        "within_20": float((np.abs(signed) <= 0.20).mean()),
        "bias": float(np.median(signed)),
    }


def evaluate(trades: pd.DataFrame, design: pd.DataFrame, comps: pd.DataFrame, random_state: int = 42) -> dict:
    """Score the latest complete months with a model built the way ``train_final`` builds it."""
    usable = design["anchor"].notna() & (trades["day"] >= trades["day"].min() + WARMUP_DAYS)
    last_complete = trades["day"].max() - GAP_DAYS   # the newest month is still being reported
    test_start = last_complete - EVAL_TEST_DAYS
    calibration_start = test_start - CALIBRATION_DAYS
    train = usable & (trades["day"] < calibration_start)
    calibration = usable & (trades["day"] >= calibration_start) & (trades["day"] < test_start)
    in_test = (trades["day"] >= test_start) & (trades["day"] <= last_complete) & (trades["direct"] == 0)
    test = in_test & design["anchor"].notna()
    if train.sum() < 1000 or calibration.sum() < 200 or test.sum() < 200:
        return {"status": "skipped", "reason": "not enough trades for a time split"}
    model, offset, _ = fit_calibrated(trades, design, usable, test_start, random_state)
    quantiles = predict_quantiles(model, design[test])
    actual_price = trades.loc[in_test, "price"].to_numpy()
    scale = (np.exp(design.loc[test, "anchor"]) * trades.loc[test, "area_m2"]).to_numpy()
    model_price = pd.Series(np.nan, index=trades.index[in_test])
    model_price.loc[trades.index[test]] = scale * np.exp(quantiles[:, 1])
    anchor_price = pd.Series(np.nan, index=trades.index[in_test])
    anchor_price.loc[trades.index[test]] = scale
    tier_price = comps.loc[in_test, "tier_price"]
    kinds = trades.loc[in_test, "kind"]
    low = scale * np.exp(quantiles[:, 0] - offset)
    high = scale * np.exp(quantiles[:, 2] + offset)
    test_actual = trades.loc[test, "price"].to_numpy()

    def by_kind(prices: pd.Series) -> dict:
        rows = {"all": error_metrics(prices.to_numpy(), actual_price, int(in_test.sum()))}
        for kind in sorted(kinds.unique()):
            mask = (kinds == kind).to_numpy()
            rows[kind] = error_metrics(prices.to_numpy()[mask], actual_price[mask], int(mask.sum()))
        return rows

    basis_rows = {}
    test_basis = design.loc[test, "basis"].to_numpy()
    for label, _ in ANCHORS:
        mask = test_basis == label
        if mask.any():
            basis_rows[label] = error_metrics((scale * np.exp(quantiles[:, 1]))[mask], test_actual[mask], int(mask.sum()))
    return {
        "status": "ok",
        "train_rows": int(train.sum() + calibration.sum()),
        "calibration_rows": int(calibration.sum()),
        "test_rows": int(in_test.sum()),
        "test_from": (EPOCH + pd.Timedelta(days=int(test_start))).strftime("%Y-%m-%d"),
        "test_to": (EPOCH + pd.Timedelta(days=int(last_complete))).strftime("%Y-%m-%d"),
        "model": by_kind(model_price),
        "anchor_only": by_kind(anchor_price),
        "current_rule": by_kind(tier_price),
        "model_by_basis": basis_rows,
        "band_coverage": float(((test_actual >= low) & (test_actual <= high)).mean()),
        "band_median_width": float(np.median((high - low) / (scale * np.exp(quantiles[:, 1])))),
        "conformal_offset": offset,
    }


def json_safe(value):
    """NaN is not JSON; write it as null."""
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


def score_targets(model, offset: float, targets: pd.DataFrame, design: pd.DataFrame, comps: pd.DataFrame) -> pd.DataFrame:
    area = pd.to_numeric(targets["area_m2"], errors="coerce")
    has_area = area.notna() & (area > 0)
    ready = has_area & design["anchor"].notna() & design["kind_code"].notna()
    quantiles = predict_quantiles(model, design[ready])
    scale = (np.exp(design.loc[ready, "anchor"]) * area[ready]).to_numpy()
    identity = [column for column in ("court", "case_no", "item_no", "sale_date", "as_of", "kind") if column in targets.columns]
    out = targets[identity].copy()
    for column in ("value", "value_low", "value_high"):
        out[column] = np.nan
    out.loc[ready, "value"] = scale * np.exp(quantiles[:, 1])
    out.loc[ready, "value_low"] = scale * np.exp(quantiles[:, 0] - offset)
    out.loc[ready, "value_high"] = scale * np.exp(quantiles[:, 2] + offset)
    out["basis"] = design["basis"].where(has_area, "no_area")
    out["building_comps"] = comps["b_n"].fillna(0).astype(int)
    out["dong_comps"] = comps["d_n"].fillna(0).astype(int)
    return out


def forward_check(index: dict[str, dict[tuple, Group]], targets: pd.DataFrame, estimates: pd.DataFrame, after_day: float | None = None) -> dict:
    """Estimates against later trades of the same floor plan in the same building.

    Those trades were contracted after the target's information cut-off, so its
    comparables never included them. ``after_day`` keeps only targets valued late
    enough that the model weights have not seen those trades either.
    """
    days = targets["day"].to_numpy(dtype=float)
    areas = pd.to_numeric(targets["area_m2"], errors="coerce").to_numpy(dtype=float)
    values = estimates["value"].to_numpy(dtype=float)
    kinds = targets["kind"].astype(object).to_numpy()
    keys = zip(kinds, targets["sgg"].astype(object), targets["dong"].astype(object), targets["bkey"].astype(object))
    found: dict[str, tuple[list[float], list[float]]] = {}
    for row, key in enumerate(keys):
        if not np.isfinite(values[row]) or (after_day is not None and days[row] < after_day):
            continue
        group = index["building"].get(key)
        if group is None:
            continue
        start = np.searchsorted(group.day, days[row] - GAP_DAYS, side="right")
        stop = np.searchsorted(group.day, days[row] + FORWARD_DAYS, side="right")
        same = np.abs(group.area[start:stop] - areas[row]) <= areas[row] * SAME_UNIT_TOLERANCE
        if not same.any():
            continue
        predicted, actual = found.setdefault(kinds[row], ([], []))
        predicted.append(values[row])
        actual.append(float(np.median(group.price[start:stop][same])))
    return {
        kind: error_metrics(np.array(predicted), np.array(actual), len(actual))
        for kind, (predicted, actual) in sorted(found.items())
    }


def train_final(trades: pd.DataFrame, design: pd.DataFrame, random_state: int = 42):
    """Fit on every trade; the latest window sets the band width first."""
    usable = design["anchor"].notna() & (trades["day"] >= trades["day"].min() + WARMUP_DAYS)
    return fit_calibrated(trades, design, usable, np.inf, random_state)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trades", type=Path, required=True)
    parser.add_argument("--targets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metrics", type=Path, required=True)
    parser.add_argument("--random-state", type=int, default=42)
    args = parser.parse_args()

    trades = prepare_trades(pd.read_csv(args.trades, dtype={"sgg": str, "jibun": str, "name": str, "dong": str}))
    index = build_index(trades)
    trade_comps = comp_features(index, trades)
    trade_design = design_matrix(trades, trade_comps)
    metrics = evaluate(trades, trade_design, trade_comps, args.random_state)
    metrics["trades"] = int(len(trades))
    metrics["trades_by_kind"] = {kind: int(count) for kind, count in trades["kind"].value_counts().items()}
    metrics["gap_days"] = GAP_DAYS
    metrics["window_days"] = WINDOW_DAYS

    model, offset, held_out = train_final(trades, trade_design, args.random_state)
    raw_targets = pd.read_csv(args.targets, dtype={"court": str, "case_no": str, "item_no": str, "sgg": str, "jibun": str, "name": str, "dong": str})
    targets = prepare_targets(raw_targets, index)
    valued = targets[targets["kind"].isin(list(KIND_CODE)) & targets["day"].notna()].copy().reset_index(drop=True)
    target_comps = comp_features(index, valued)
    target_design = design_matrix(valued, target_comps)
    estimates = score_targets(model, offset, valued, target_design, target_comps)
    metrics["targets"] = int(len(estimates))
    metrics["targets_valued"] = int(estimates["value"].notna().sum())
    metrics["targets_by_basis"] = {basis: int(count) for basis, count in estimates["basis"].value_counts().items()}
    unseen_from = trades["day"].max() - CALIBRATION_DAYS + GAP_DAYS
    metrics["forward_check"] = {
        "days": FORWARD_DAYS,
        "all": forward_check(index, valued, estimates),
        # the stored estimates come from a model that has seen every trade; this row uses the one that has not
        "after_training": forward_check(index, valued, score_targets(held_out, offset, valued, target_design, target_comps), after_day=unseen_from),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    estimates.to_csv(args.output, index=False)
    args.metrics.parent.mkdir(parents=True, exist_ok=True)
    args.metrics.write_text(json.dumps(json_safe(metrics), ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    if metrics.get("status") == "ok":
        headline = metrics["model"]["all"]
        rule = metrics["current_rule"]["all"]
        print(f"[ml:avm] holdout {metrics['test_from']}~{metrics['test_to']} {metrics['test_rows']}건: "
              f"model MdAPE {headline['mdape']:.3f} (±10% {headline['within_10']:.3f}), "
              f"current rule MdAPE {rule['mdape']:.3f} (±10% {rule['within_10']:.3f})")
    print(f"[ml:avm] {metrics['targets_valued']}/{metrics['targets']} targets valued -> {args.output}")


if __name__ == "__main__":
    main()
