#!/usr/bin/env python3
"""Report-only market value model (AVM) trained on MOLIT sale trades.

Every estimate is point-in-time. A target valued on day ``t`` only sees
trades known on ``t``: sale contracts may be reported up to ``GAP_DAYS``
late, so a trade is known on ``reported_at`` or ``observed_at`` when that
timestamp is present, otherwise on ``deal_date + GAP_DAYS``.

``gm_molit_cache.fetched_at`` is the last time that district-month cell was
downloaded and is overwritten on refresh. It is not when a trade became
known, and it is not used as a knowledge timestamp.

Historical targets are not scored by a model fit on every trade. Each
calendar month of ``as_of`` has its own model. Training and calibration for
that model use only trades with ``known_day <= month_start``. Building-name
mappings likewise ignore names whose first known trade is after ``as_of``.

The model predicts log(price per m2) relative to the tightest available
comparable median (the anchor). The stored lower bound is a one-sided 10%
tail (the q=0.10 side of the central 80% band, not ``1 - 0.80``) per property
type × comparable basis, with fallback to the type and then the global offset
when a cell is sparse. That flag is a report-only review signal. It does not
change bids, recommendations, or status.
"""
from __future__ import annotations

import argparse
import hashlib
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
FORWARD_DAYS = 180           # how far ahead later trades of the same building are looked up
POST_SALE_DAYS = FORWARD_DAYS   # label window after the auction date (post-sale-margin-v3)
POST_SALE_METHOD = "post-sale-v1"
BAND_COVERAGE = 0.80         # two-sided central band, q=0.10 to q=0.90
LOWER_TAIL = 0.10            # one-sided lower tail of that band; not 1 - 0.80
LOWER_COVERAGE = 0.90        # adjust q_low so about LOWER_TAIL of calibration actuals fall below it
LOWER_EXCEEDANCE = LOWER_TAIL
QUANTILES = (0.10, 0.50, 0.90)
KIND_CODE = {"apt": 0, "rh": 1, "offi": 2}
FIT_SETTINGS = {
    "objective": "reg:quantileerror",
    "tree_method": "hist",
    "n_estimators": 400,
    "learning_rate": 0.05,
    "max_depth": 6,
    "min_child_weight": 20,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "n_jobs": 4,
}
EPOCH = pd.Timestamp("2000-01-01")
AVM_MODEL_VERSION = "avm-v3"
MIN_TRAIN_ROWS = 1000
MIN_CALIBRATION_ROWS = 200
MIN_CELL_ROWS = 40           # kind × basis lower-bound cell; below this, fall back
MIN_KIND_ROWS = 80           # kind-level fallback; below this, use the global offset
MIN_EVIDENCE = 20            # mature forward confirms before a cohort breach rate is evidence
UPCOMING_DISPLAY_CAP = 30
REVIEW_LABEL = "추가 실거래 확인"
CACHE_DIR = Path("artifacts/ml/avm_month_cache")

# MOLIT items have no per-trade report time. Do not treat the cache cell's
# fetched_at as one: it is the last download and is overwritten.
KNOWLEDGE_ASSUMPTION = (
    "MOLIT sale items have no per-trade report timestamp. "
    "gm_molit_cache.fetched_at is the last download of that district-month and is overwritten, "
    "so it is not when the trade became known. "
    "known_day is reported_at or observed_at when that column is present, otherwise deal_date + GAP_DAYS. "
    "A monthly model trains and calibrates only on trades with known_day <= month_start(as_of)."
)
KNOWLEDGE_ASSUMPTION_KO = (
    "국토부 매매 원자료에는 건별 신고 시각이 없다. gm_molit_cache.fetched_at은 그 시군구·월을 "
    "마지막으로 받은 시각이고 갱신 때 덮이므로, 거래를 알게 된 날이 아니다. "
    "reported_at 또는 observed_at이 있으면 그 날짜를 쓰고, 없으면 계약일+30일을 알게 된 날로 둔다. "
    "월별 모델의 학습·보정은 그 달 1일까지 알려진 거래만 쓴다."
)

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
KIND_LABEL = {"all": "전체", "apt": "아파트", "rh": "연립다세대", "offi": "오피스텔"}
BASIS_LABEL = {
    "building_area": "같은 건물·같은 면적",
    "building": "같은 건물",
    "dong_area": "같은 동·비슷한 면적",
    "dong": "같은 동",
    "sgg_area": "같은 시군구·비슷한 면적",
    "sgg": "같은 시군구",
    "no_area": "면적 없음",
    "no_comps": "거래 없음",
    "cold_start": "이력 부족",
}
REASON_LABEL = {"lower_breach": "하한 이탈", "insufficient_evidence": "근거 부족"}


@dataclass
class Group:
    day: np.ndarray          # deal day, same order as known
    log_ppm2: np.ndarray
    area: np.ndarray
    price: np.ndarray
    build_year: np.ndarray
    known: np.ndarray        # ascending knowledge day




@dataclass
class LowerCalibration:
    """One-sided lower offset in residual (log price per m2) space."""

    cell: dict[tuple[str, str], float]
    kind: dict[str, float]
    global_offset: float
    cell_n: dict[tuple[str, str], int]
    kind_n: dict[str, int]
    global_n: int
    upper_offset: float = 0.0
    min_cell: int = MIN_CELL_ROWS
    min_kind: int = MIN_KIND_ROWS

    def resolve(self, kind: str, basis: str) -> tuple[float, str]:
        key = (str(kind), str(basis))
        if self.cell_n.get(key, 0) >= self.min_cell and key in self.cell:
            return float(self.cell[key]), "cell"
        if self.kind_n.get(str(kind), 0) >= self.min_kind and str(kind) in self.kind:
            return float(self.kind[str(kind)]), "kind"
        return float(self.global_offset), "global"

    def to_dict(self) -> dict:
        return {
            "cell": {f"{kind}|{basis}": value for (kind, basis), value in self.cell.items()},
            "kind": self.kind,
            "global_offset": self.global_offset,
            "cell_n": {f"{kind}|{basis}": value for (kind, basis), value in self.cell_n.items()},
            "kind_n": self.kind_n,
            "global_n": self.global_n,
            "upper_offset": self.upper_offset,
            "min_cell": self.min_cell,
            "min_kind": self.min_kind,
        }

    @classmethod
    def from_dict(cls, raw: dict) -> LowerCalibration:
        def pairs(mapping: dict) -> dict[tuple[str, str], float | int]:
            out = {}
            for key, value in mapping.items():
                kind, basis = str(key).split("|", 1)
                out[(kind, basis)] = value
            return out

        return cls(
            cell={key: float(value) for key, value in pairs(raw.get("cell", {})).items()},
            kind={str(key): float(value) for key, value in raw.get("kind", {}).items()},
            global_offset=float(raw["global_offset"]),
            cell_n={key: int(value) for key, value in pairs(raw.get("cell_n", {})).items()},
            kind_n={str(key): int(value) for key, value in raw.get("kind_n", {}).items()},
            global_n=int(raw.get("global_n", 0)),
            upper_offset=float(raw.get("upper_offset", 0.0)),
            min_cell=int(raw.get("min_cell", MIN_CELL_ROWS)),
            min_kind=int(raw.get("min_kind", MIN_KIND_ROWS)),
        )

    @classmethod
    def uniform(cls, offset: float, upper: float | None = None, n: int = 10**9) -> LowerCalibration:
        return cls(
            cell={},
            kind={},
            global_offset=float(offset),
            cell_n={},
            kind_n={},
            global_n=n,
            upper_offset=float(offset if upper is None else upper),
        )


def day_number(dates: pd.Series) -> pd.Series:
    return (pd.to_datetime(dates, errors="coerce") - EPOCH).dt.days


def format_day(day: float | int) -> str:
    return (EPOCH + pd.Timedelta(days=int(day))).strftime("%Y-%m-%d")


def month_start_day(day: float | int) -> int:
    ts = EPOCH + pd.Timedelta(days=int(day))
    start = pd.Timestamp(year=int(ts.year), month=int(ts.month), day=1)
    return int((start - EPOCH).days)


def month_start_series(days: pd.Series) -> pd.Series:
    numbers = pd.to_numeric(days, errors="coerce")
    starts = pd.Series(np.nan, index=days.index, dtype=float)
    known = numbers.notna()
    if known.any():
        ts = EPOCH + pd.to_timedelta(numbers[known].astype(int), unit="D")
        period_start = ts.dt.to_period("M").dt.to_timestamp()
        starts.loc[known] = (period_start - EPOCH).dt.days.astype(float)
    return starts


def observed_source(frame: pd.DataFrame) -> str | None:
    """Per-trade report column, if any value is present. Cell fetched_at is not accepted."""
    for column in ("reported_at", "observed_at"):
        if column in frame.columns and day_number(frame[column]).notna().any():
            return column
    return None


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
    observed = None
    for column in ("reported_at", "observed_at"):
        if column in frame.columns:
            parsed = day_number(frame[column])
            if parsed.notna().any():
                observed = parsed
                break
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
    trades["known_day"] = trades["day"] + GAP_DAYS
    if observed is not None:
        aligned = observed.reindex(trades.index)
        use = aligned.notna()
        trades.loc[use, "known_day"] = aligned.loc[use].astype(int)
    trades["known_day"] = trades["known_day"].astype(int)
    trades["log_ppm2"] = np.log(trades["price"] / trades["area_m2"])
    return trades.sort_values("day", kind="stable").reset_index(drop=True)


def resolve_building_keys(targets: pd.DataFrame, index: dict[str, dict[tuple, Group]]) -> pd.Series:
    """Match targets to buildings whose trades only carry a name.

    Court listings have a lot number, but officetel trades come without one. Where
    the lot number matches nothing, use the building name, letting one name be a
    prefix of the other ('센트라움주건축물' against '센트라움').

    A name is usable only when that building already had a trade known on or
    before the target's valuation day. Names that first appear later are not
    mapped.
    """
    names: dict[tuple, list[tuple[str, int]]] = {}
    for key, group in index["building"].items():
        if len(key) != 4 or len(group.known) == 0:
            continue
        kind, sgg, dong, bkey = key
        if isinstance(bkey, str) and bkey.startswith("n:"):
            names.setdefault((kind, sgg, dong), []).append((bkey[2:], int(group.known[0])))
    keys = targets["bkey"].astype(object).to_numpy().copy()
    if not names or "name" not in targets.columns:
        return pd.Series(keys, index=targets.index, dtype="string")
    target_names = targets["name"].astype("string").str.replace(r"\s+", "", regex=True).astype(object).to_numpy()
    target_days = pd.to_numeric(targets["day"], errors="coerce").to_numpy(dtype=float)
    places = zip(targets["kind"].astype(object), targets["sgg"].astype(object), targets["dong"].astype(object))
    for row, place in enumerate(places):
        candidates = names.get(place)
        name = target_names[row]
        as_of = target_days[row]
        if not candidates or not isinstance(name, str) or not np.isfinite(as_of) or (*place, keys[row]) in index["building"]:
            continue
        matches = [
            candidate for candidate, first_known in candidates
            if first_known <= as_of and min(len(candidate), len(name)) >= 3
            and (name.startswith(candidate) or candidate.startswith(name))
        ]
        if matches:
            keys[row] = "n:" + max(matches, key=len)
    return pd.Series(keys, index=targets.index, dtype="string")


def prepare_targets(frame: pd.DataFrame, index: dict[str, dict[tuple, Group]] | None = None) -> pd.DataFrame:
    targets = frame.copy()
    targets["area_m2"] = pd.to_numeric(targets["area_m2"], errors="coerce")
    targets["floor"] = pd.to_numeric(targets["floor"], errors="coerce") if "floor" in targets.columns else np.nan
    targets["day"] = day_number(targets["as_of"])
    targets["sale_day"] = day_number(targets["sale_date"]) if "sale_date" in targets.columns else np.nan
    targets["sgg"] = targets["sgg"].astype("string").str.replace(r"\.0$", "", regex=True)
    targets["dong"] = targets["dong"].astype("string").str.strip()
    targets["bkey"] = building_key(targets)
    if index is not None:
        targets["bkey"] = resolve_building_keys(targets, index)
    targets["direct"] = 0.0
    return targets


def build_index(trades: pd.DataFrame) -> dict[str, dict[tuple, Group]]:
    """Trades must already be sorted by deal day. Groups are reordered by knowledge day."""
    levels = {"building": ["kind", "sgg", "dong", "bkey"], "dong": ["kind", "sgg", "dong"], "sgg": ["kind", "sgg"]}
    frame = trades
    if "known_day" not in frame.columns:
        frame = frame.copy()
        frame["known_day"] = frame["day"] + GAP_DAYS
    arrays = {name: frame[name].to_numpy() for name in ("day", "log_ppm2", "area_m2", "price", "build_year", "known_day")}
    index: dict[str, dict[tuple, Group]] = {}
    for level, keys in levels.items():
        grouped: dict[tuple, Group] = {}
        for key, rows in frame.groupby(keys, sort=False, dropna=True).indices.items():
            order = np.argsort(arrays["known_day"][rows], kind="stable")
            chosen = rows[order]
            grouped[key if isinstance(key, tuple) else (key,)] = Group(
                arrays["day"][chosen],
                arrays["log_ppm2"][chosen],
                arrays["area_m2"][chosen],
                arrays["price"][chosen],
                arrays["build_year"][chosen],
                arrays["known_day"][chosen].astype(int, copy=False),
            )
        index[level] = grouped
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
            # known_day <= as_of and known_day > as_of - WINDOW. When known_day is
            # deal_date + GAP_DAYS this is the old (as_of - GAP - WINDOW, as_of - GAP] deal window.
            high = np.searchsorted(group.known, day[rows], side="right")
            low = np.searchsorted(group.known, day[rows] - WINDOW_DAYS, side="right")
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
                        recent = group.known[start:stop] > day[row] - TREND_DAYS
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
        objective=FIT_SETTINGS["objective"],
        quantile_alpha=np.array(QUANTILES),
        tree_method=FIT_SETTINGS["tree_method"],
        n_estimators=FIT_SETTINGS["n_estimators"],
        learning_rate=FIT_SETTINGS["learning_rate"],
        max_depth=FIT_SETTINGS["max_depth"],
        min_child_weight=FIT_SETTINGS["min_child_weight"],
        subsample=FIT_SETTINGS["subsample"],
        colsample_bytree=FIT_SETTINGS["colsample_bytree"],
        n_jobs=FIT_SETTINGS["n_jobs"],
        random_state=random_state,
    )
    model.fit(features[FEATURES], target)
    return model


def predict_quantiles(model, features: pd.DataFrame) -> np.ndarray:
    """Residual quantiles (low, mid, high) relative to the anchor, never crossing."""
    if features.empty:
        return np.empty((0, len(QUANTILES)))
    return np.sort(np.asarray(model.predict(features[FEATURES])).reshape(len(features), len(QUANTILES)), axis=1)


def order_statistic(scores: np.ndarray, coverage: float) -> float:
    """``ceil((n+1)*coverage)``-th finite order statistic. Not an interpolated quantile."""
    finite = np.asarray(scores, dtype=float)
    finite = finite[np.isfinite(finite)]
    n = int(finite.size)
    if n == 0:
        return 0.0
    rank = int(np.ceil((n + 1) * coverage))
    rank = min(max(rank, 1), n)
    return float(np.sort(finite)[rank - 1])


def conformal_offset(quantiles: np.ndarray, actual: np.ndarray, coverage: float = BAND_COVERAGE) -> float:
    """Two-sided widening for the stored high side of the central band."""
    if len(actual) == 0:
        return 0.0
    scores = np.maximum(quantiles[:, 0] - actual, actual - quantiles[:, -1])
    return order_statistic(scores, coverage)


def conservative_lower_offset(scores: np.ndarray, coverage: float = LOWER_COVERAGE) -> float:
    """Offset subtracted from q_low. Targets the 10% lower tail, not ``1 - 0.80``."""
    return order_statistic(scores, coverage)


def apply_stored_band(quantiles: np.ndarray, low_off: np.ndarray, high_off: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Stored residuals. A negative offset cannot raise low above the median or drop high below it."""
    quantiles = np.asarray(quantiles, dtype=float)
    mid = quantiles[:, 1]
    low = np.minimum(quantiles[:, 0] - np.asarray(low_off, dtype=float), mid)
    high = np.maximum(quantiles[:, 2] + np.asarray(high_off, dtype=float), mid)
    return low, mid, high


def stored_prices(scale: np.ndarray, quantiles: np.ndarray, low_off: np.ndarray, high_off: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Prices written to the estimate. Always ``value_low <= value <= value_high``."""
    low_r, mid_r, high_r = apply_stored_band(quantiles, low_off, high_off)
    scale = np.asarray(scale, dtype=float)
    value = scale * np.exp(mid_r)
    value_low = np.minimum(scale * np.exp(low_r), value)
    value_high = np.maximum(scale * np.exp(high_r), value)
    return value_low, value, value_high


def calibrate_lower(kinds: np.ndarray, bases: np.ndarray, q_low: np.ndarray, actual: np.ndarray, coverage: float = LOWER_COVERAGE) -> LowerCalibration:
    """Lower offsets for kind × basis, with kind then global fallback counts recorded on the object."""
    kinds = np.asarray(kinds).astype(str)
    bases = np.asarray(bases).astype(str)
    scores = np.asarray(q_low, dtype=float) - np.asarray(actual, dtype=float)
    cell: dict[tuple[str, str], float] = {}
    cell_n: dict[tuple[str, str], int] = {}
    kind_scores: dict[str, list[float]] = {}
    for kind, basis, score in zip(kinds, bases, scores):
        if not np.isfinite(score):
            continue
        key = (kind, basis)
        cell_n[key] = cell_n.get(key, 0) + 1
        kind_scores.setdefault(kind, []).append(float(score))
    finite_score = np.isfinite(scores)
    for key in cell_n:
        mask = (kinds == key[0]) & (bases == key[1]) & finite_score
        cell[key] = conservative_lower_offset(scores[mask], coverage)
    kind_offset = {kind: conservative_lower_offset(np.asarray(values), coverage) for kind, values in kind_scores.items()}
    kind_n = {kind: len(values) for kind, values in kind_scores.items()}
    finite = scores[np.isfinite(scores)]
    return LowerCalibration(
        cell=cell,
        kind=kind_offset,
        global_offset=conservative_lower_offset(finite, coverage),
        cell_n=cell_n,
        kind_n=kind_n,
        global_n=int(len(finite)),
    )


def _bound_offsets(offset, kinds: np.ndarray, bases: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    count = len(kinds)
    if isinstance(offset, LowerCalibration):
        low = np.empty(count)
        level = np.empty(count, dtype=object)
        for i, (kind, basis) in enumerate(zip(kinds, bases)):
            low[i], level[i] = offset.resolve(kind, basis)
        return low, np.full(count, float(offset.upper_offset)), level
    value = float(offset)
    return np.full(count, value), np.full(count, value), np.full(count, "uniform", dtype=object)


def fit_monthly(
    trades: pd.DataFrame,
    design: pd.DataFrame,
    random_state: int = 42,
    min_train: int = MIN_TRAIN_ROWS,
    min_calibration: int = MIN_CALIBRATION_ROWS,
):
    """Fit on trades already restricted to this month's knowledge cutoff.

    Returns ``(model, lower_calibration)`` or ``None`` when the slice cannot
    support a held-out calibration window (cold start). Callers must not borrow
    a later month's model for that month.
    """
    if len(trades) < min_train + min_calibration or design["anchor"].isna().all():
        return None
    last = int(trades["day"].max())
    calibration = trades["day"] >= last - CALIBRATION_DAYS
    if int(calibration.sum()) < min_calibration or int((~calibration).sum()) < min_train:
        return None
    if not XGBOOST_AVAILABLE:
        raise RuntimeError("xgboost가 설치되어 있지 않습니다")
    residual = trades["log_ppm2"] - design["anchor"]
    held_out = fit(design.loc[~calibration], residual.loc[~calibration], random_state)
    cal_q = predict_quantiles(held_out, design.loc[calibration])
    actual = residual.loc[calibration].to_numpy()
    upper = conformal_offset(cal_q, actual)
    lower = calibrate_lower(
        trades.loc[calibration, "kind"].to_numpy(),
        design.loc[calibration, "basis"].to_numpy(),
        cal_q[:, 0],
        actual,
    )
    lower.upper_offset = upper
    return fit(design, residual, random_state), lower


def fit_calibrated(trades: pd.DataFrame, design: pd.DataFrame, usable: pd.Series, known_cutoff: float, random_state: int = 42):
    """Model on usable trades known by ``known_cutoff``. ``None`` means cold start."""
    mask = usable & (trades["known_day"] <= known_cutoff)
    return fit_monthly(trades.loc[mask], design.loc[mask], random_state)


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
    """Score the latest complete months with a model that had not yet seen them.

    Training and calibration trades must be known by the first test day
    (``known_day <= test_start``), not merely contracted before it.
    """
    usable = design["anchor"].notna() & (trades["day"] >= trades["day"].min() + WARMUP_DAYS)
    last_complete = int(trades["day"].max() - GAP_DAYS)   # the newest month is still being reported
    test_start = last_complete - EVAL_TEST_DAYS
    eligible = usable & (trades["known_day"] <= test_start)
    in_test = (trades["day"] >= test_start) & (trades["day"] <= last_complete) & (trades["direct"] == 0)
    test = in_test & design["anchor"].notna()
    if int(eligible.sum()) < MIN_TRAIN_ROWS + MIN_CALIBRATION_ROWS or int(test.sum()) < 200:
        return {"status": "skipped", "reason": "not enough trades for a time split"}
    fitted = fit_monthly(trades.loc[eligible], design.loc[eligible], random_state)
    if fitted is None:
        return {"status": "skipped", "reason": "not enough trades for a time split"}
    model, lower = fitted
    last_eligible = int(trades.loc[eligible, "day"].max())
    calibration = eligible & (trades["day"] >= last_eligible - CALIBRATION_DAYS)
    quantiles = predict_quantiles(model, design[test])
    actual_price = trades.loc[in_test, "price"].to_numpy()
    scale = (np.exp(design.loc[test, "anchor"]) * trades.loc[test, "area_m2"]).to_numpy()
    model_price = pd.Series(np.nan, index=trades.index[in_test])
    anchor_price = pd.Series(np.nan, index=trades.index[in_test])
    anchor_price.loc[trades.index[test]] = scale
    tier_price = comps.loc[in_test, "tier_price"]
    kinds = trades.loc[in_test, "kind"]
    low_off, high_off, levels = _bound_offsets(lower, trades.loc[test, "kind"].to_numpy(), design.loc[test, "basis"].to_numpy())
    value_low, value, value_high = stored_prices(scale, quantiles, low_off, high_off)
    model_price.loc[trades.index[test]] = value
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
    lower_by_basis = {}
    for label, _ in ANCHORS:
        mask = test_basis == label
        if mask.any():
            lower_by_basis[label] = {
                "rows": int(mask.sum()),
                "exceedance_rate": float((test_actual[mask] < value_low[mask]).mean()),
                "calibration_level": str(pd.Series(levels[mask]).mode().iloc[0]) if len(levels[mask]) else "global",
            }
    return {
        "status": "ok",
        "train_rows": int(eligible.sum()),
        "calibration_rows": int(calibration.sum()),
        "test_rows": int(in_test.sum()),
        "test_from": format_day(test_start),
        "test_to": format_day(last_complete),
        "train_known_through": format_day(test_start),
        "model": by_kind(model_price),
        "anchor_only": by_kind(anchor_price),
        "current_rule": by_kind(tier_price),
        "model_by_basis": basis_rows,
        "band_coverage": float(((test_actual >= value_low) & (test_actual <= value_high)).mean()),
        "band_median_width": float(np.median((value_high - value_low) / value)),
        "conformal_offset": float(lower.upper_offset),
        "lower_holdout_exceedance": float((test_actual < value_low).mean()),
        "lower_holdout_by_basis": lower_by_basis,
    }


def json_safe(value):
    """NaN is not JSON; write it as null. Numpy scalars become Python numbers."""
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, (np.floating, float)):
        number = float(value)
        return number if np.isfinite(number) else None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    return value


def score_targets(model, offset, targets: pd.DataFrame, design: pd.DataFrame, comps: pd.DataFrame) -> pd.DataFrame:
    area = pd.to_numeric(targets["area_m2"], errors="coerce")
    has_area = area.notna() & (area > 0)
    ready = has_area & design["anchor"].notna() & design["kind_code"].notna()
    quantiles = predict_quantiles(model, design[ready])
    scale = (np.exp(design.loc[ready, "anchor"]) * area[ready]).to_numpy()
    identity = [column for column in ("court", "case_no", "item_no", "sale_date", "as_of", "kind") if column in targets.columns]
    out = targets[identity].copy()
    for column in ("value", "value_low", "value_high"):
        out[column] = np.nan
    low_off, high_off, level = _bound_offsets(
        offset,
        targets.loc[ready, "kind"].astype(str).to_numpy(),
        design.loc[ready, "basis"].astype(str).to_numpy(),
    )
    if ready.any():
        value_low, value, value_high = stored_prices(scale, quantiles, low_off, high_off)
        out.loc[ready, "value"] = value
        out.loc[ready, "value_low"] = value_low
        out.loc[ready, "value_high"] = value_high
    out["basis"] = design["basis"].where(has_area, "no_area")
    out["building_comps"] = comps["b_n"].fillna(0).astype(int)
    out["dong_comps"] = comps["d_n"].fillna(0).astype(int)
    out["calibration_level"] = pd.Series(pd.NA, index=out.index, dtype=object)
    if ready.any():
        out.loc[ready, "calibration_level"] = level
    out["cold_start"] = False
    return out


def _subsequent_prices(group: Group | None, as_of: float, area: float, horizon: float = FORWARD_DAYS, similar: float = SAME_UNIT_TOLERANCE) -> np.ndarray:
    """Later same-floor-plan prices, area-normalized to the subject.

    ``±5%`` is the same floor-plan band used for comparables. A raw price of a
    slightly larger unit is not a valuation miss, so the returned price is
    ``trade_price * subject_area / trade_area``. Trades contracted on or before
    ``as_of`` are not subsequent.
    """
    if group is None or not np.isfinite(as_of) or not np.isfinite(area) or area <= 0:
        return np.empty(0)
    window = (group.day > as_of) & (group.day <= as_of + horizon)
    same = window & (np.abs(group.area - area) <= area * similar) & (group.area > 0)
    return group.price[same] * (area / group.area[same])


def post_sale_values(index: dict[str, dict[tuple, Group]], targets: pd.DataFrame, today: float) -> pd.DataFrame:
    """Market value after the auction, for the decision label only.

    One row per target whose window has closed and been reported
    (``today >= sale_day + POST_SALE_DAYS + GAP_DAYS``). ``value`` is the
    median of same-building same-floor-plan (±5%) trades contracted strictly
    after the sale day and within ``POST_SALE_DAYS``, each scaled to the
    subject area. NaN with ``confirms = 0`` means the window closed with no
    such trade. Open windows get no row, so a later run can still write them.
    """
    columns = ["court", "case_no", "item_no", "sale_date", "value", "confirms", "window_days"]
    if targets.empty or "sale_day" not in targets.columns:
        return pd.DataFrame(columns=columns)
    sale_days = pd.to_numeric(targets["sale_day"], errors="coerce").to_numpy(dtype=float)
    areas = pd.to_numeric(targets["area_m2"], errors="coerce").to_numpy(dtype=float)
    keys = zip(targets["kind"].astype(object), targets["sgg"].astype(object), targets["dong"].astype(object), targets["bkey"].astype(object))
    rows = []
    for pos, key in enumerate(keys):
        sale = sale_days[pos]
        if not np.isfinite(sale) or today < sale + POST_SALE_DAYS + GAP_DAYS or key[0] not in KIND_CODE:
            continue
        prices = _subsequent_prices(index["building"].get(key), sale, areas[pos], horizon=POST_SALE_DAYS)
        source = targets.iloc[pos]
        rows.append({
            "court": source["court"],
            "case_no": source["case_no"],
            "item_no": source["item_no"],
            "sale_date": format_day(sale),
            "value": float(np.round(np.median(prices))) if len(prices) else np.nan,
            "confirms": int(len(prices)),
            "window_days": POST_SALE_DAYS,
        })
    return pd.DataFrame(rows, columns=columns)


def forward_check(index: dict[str, dict[tuple, Group]], targets: pd.DataFrame, estimates: pd.DataFrame, after_day: float | None = None) -> dict:
    """Point-estimate errors against strictly subsequent same-building similar-size trades.

    Maturity is not applied here; ``forward_exceedance`` owns the denominator
    used in the report.
    """
    days = targets["day"].to_numpy(dtype=float)
    areas = pd.to_numeric(targets["area_m2"], errors="coerce").to_numpy(dtype=float)
    values = pd.to_numeric(estimates["value"], errors="coerce").to_numpy(dtype=float)
    kinds = targets["kind"].astype(object).to_numpy()
    keys = zip(kinds, targets["sgg"].astype(object), targets["dong"].astype(object), targets["bkey"].astype(object))
    found: dict[str, tuple[list[float], list[float]]] = {}
    for row, key in enumerate(keys):
        if not np.isfinite(values[row]) or (after_day is not None and days[row] < after_day):
            continue
        prices = _subsequent_prices(index["building"].get(key), days[row], areas[row])
        if len(prices) == 0:
            continue
        predicted, actual = found.setdefault(str(kinds[row]), ([], []))
        predicted.append(float(values[row]))
        actual.append(float(np.median(prices)))
    return {
        kind: error_metrics(np.array(predicted), np.array(actual), len(actual))
        for kind, (predicted, actual) in sorted(found.items())
    }


def cohort_evidence_status(mature_valued: int, exceedance_rate: float | None, calibration_level: str) -> str:
    """``lower_breach`` beats ``insufficient_evidence``. ``ok`` needs a cell offset and enough mature confirms."""
    # 1/10 is not exact in binary, so a true 10% rate can sit a few ulps above 0.10.
    above = exceedance_rate is not None and exceedance_rate > LOWER_EXCEEDANCE + 1e-9
    if mature_valued >= MIN_EVIDENCE and above:
        return "lower_breach"
    if calibration_level == "cell" and mature_valued >= MIN_EVIDENCE and exceedance_rate is not None and not above:
        return "ok"
    return "insufficient_evidence"


def threshold_text() -> str:
    return (
        f"성숙 매물 {MIN_EVIDENCE}건 이상 · 거래 단위 하한 이탈률(매물 평균) {LOWER_EXCEEDANCE:.0%} 이하 · "
        "보정 수준 cell(종류×근거). 이탈률이 넘으면 하한 이탈, 하나라도 못 미치면 근거 부족."
    )


def evidence_text() -> str:
    return (
        f"분모는 성숙(평가일+{FORWARD_DAYS}일+{GAP_DAYS}일<=오늘)하고 value_low가 있는 매물 중, "
        f"같은 건물·같은 면적(±{SAME_UNIT_TOLERANCE:.0%})이고 계약일이 평가일보다 늦은 확인 거래가 있는 매물. "
        "후속 거래의 ㎡당 가격을 대상 면적으로 환산하고, 거래마다 하한과 비교해 매물별 하한 아래 비율을 평균한다. "
        "미성숙 확인·추정 없음·면적/거래 없음은 분모 밖."
    )


def evidence_threshold() -> dict:
    return {
        "min_mature_confirms": MIN_EVIDENCE,
        "max_lower_exceedance": LOWER_EXCEEDANCE,
        "calibration_level_required": "cell",
        "similar_size": SAME_UNIT_TOLERANCE,
        "forward_days": FORWARD_DAYS,
        "gap_days": GAP_DAYS,
        "maturity": "today >= as_of + forward_days + gap_days",
        "strictly_subsequent": "deal_date > as_of",
        "same_building": True,
        "label": REVIEW_LABEL,
        "live_gate": False,
    }


def forward_exceedance(
    index: dict[str, dict[tuple, Group]],
    targets: pd.DataFrame,
    estimates: pd.DataFrame,
    today: float | None,
) -> dict:
    """Lower-bound breaches on strictly subsequent same-building similar-size confirms.

    A row is mature when ``today >= as_of + FORWARD_DAYS + GAP_DAYS``: the
    forward window has closed and those contracts would have been reported.
    ``value_low`` is calibrated as a single-trade 10% tail, so every later
    trade is compared with it, not their median. A row's breach share is the
    fraction of its later trades below ``value_low``; ``exceedance_rate`` is
    the mean of row shares, so a liquid building does not outweigh others.
    The denominator is mature rows that have a finite lower bound and at
    least one such confirm. Immature confirms are counted and excluded from
    the rate. Missing values are counted by basis and are not in the rate.
    """
    count = len(targets)
    days = targets["day"].to_numpy(dtype=float)
    areas = pd.to_numeric(targets["area_m2"], errors="coerce").to_numpy(dtype=float)
    values = pd.to_numeric(estimates["value"], errors="coerce").to_numpy(dtype=float) if "value" in estimates.columns else np.full(count, np.nan)
    lows = pd.to_numeric(estimates["value_low"], errors="coerce").to_numpy(dtype=float) if "value_low" in estimates.columns else np.full(count, np.nan)
    kinds = targets["kind"].astype(str).to_numpy()
    bases = estimates["basis"].astype(str).to_numpy() if "basis" in estimates.columns else np.array(["unknown"] * count, dtype=object)
    levels = estimates["calibration_level"].astype(object).to_numpy() if "calibration_level" in estimates.columns else np.array([None] * count, dtype=object)
    keys = list(zip(targets["kind"].astype(object), targets["sgg"].astype(object), targets["dong"].astype(object), targets["bkey"].astype(object)))

    missing_by_basis: dict[str, int] = {}
    cohorts: dict[str, dict] = {}
    predicted: dict[str, list[float]] = {}
    actuals: dict[str, list[float]] = {}
    immature_predicted: dict[str, list[float]] = {}
    immature_actuals: dict[str, list[float]] = {}
    valued = 0
    missing_value = 0
    with_confirm = 0
    mature = 0
    immature = 0
    mature_with_confirm = 0
    mature_without_confirm = 0
    immature_with_confirm = 0
    breach_denominator = 0
    share_sum = 0.0
    confirm_trades = 0
    breach_trades = 0

    def cohort(kind: str, basis: str) -> dict:
        key = f"{kind}|{basis}"
        return cohorts.setdefault(key, {
            "kind": kind,
            "basis": basis,
            "mature_with_confirm": 0,
            "share_sum": 0.0,
            "confirm_trades": 0,
            "breach_trades": 0,
            "levels": [],
        })

    for row, key in enumerate(keys):
        has_value = np.isfinite(values[row])
        if has_value:
            valued += 1
        else:
            missing_value += 1
            basis = str(bases[row])
            missing_by_basis[basis] = missing_by_basis.get(basis, 0) + 1
        as_of = days[row]
        is_mature = today is not None and np.isfinite(as_of) and today >= as_of + FORWARD_DAYS + GAP_DAYS
        if is_mature:
            mature += 1
        else:
            immature += 1
        prices = _subsequent_prices(index["building"].get(key), as_of, areas[row])
        has_confirm = len(prices) > 0
        if has_confirm:
            with_confirm += 1
        if is_mature and has_confirm:
            mature_with_confirm += 1
        elif is_mature:
            mature_without_confirm += 1
        if not is_mature and has_confirm:
            immature_with_confirm += 1
            if has_value:
                immature_predicted.setdefault(str(kinds[row]), []).append(float(values[row]))
                immature_actuals.setdefault(str(kinds[row]), []).append(float(np.median(prices)))
        if not (is_mature and has_confirm and np.isfinite(lows[row])):
            continue
        breach_denominator += 1
        med = float(np.median(prices))
        below = int((prices < float(lows[row])).sum())
        share = below / len(prices)
        share_sum += share
        confirm_trades += len(prices)
        breach_trades += below
        bucket = cohort(str(kinds[row]), str(bases[row]))
        bucket["mature_with_confirm"] += 1
        bucket["share_sum"] += share
        bucket["confirm_trades"] += len(prices)
        bucket["breach_trades"] += below
        level = levels[row]
        bucket["levels"].append("none" if level is None or (isinstance(level, float) and not np.isfinite(level)) else str(level))
        if has_value:
            predicted.setdefault(str(kinds[row]), []).append(float(values[row]))
            actuals.setdefault(str(kinds[row]), []).append(med)

    by_cohort = {}
    for key, bucket in sorted(cohorts.items()):
        confirms = bucket["mature_with_confirm"]
        rate = float(bucket["share_sum"] / confirms) if confirms else None
        used = set(bucket["levels"])
        if used == {"cell"}:
            level = "cell"
        elif not used:
            level = "none"
        elif len(used) == 1:
            level = next(iter(used))
        else:
            level = "mixed"
        status = cohort_evidence_status(confirms, rate, level)
        by_cohort[key] = {
            "kind": bucket["kind"],
            "basis": bucket["basis"],
            "mature_with_confirm": confirms,
            "confirm_trades": bucket["confirm_trades"],
            "breach_trades": bucket["breach_trades"],
            "exceedance_rate": rate,
            "calibration_level": level,
            "status": status,
        }
    return {
        "days": FORWARD_DAYS,
        "similar_size": SAME_UNIT_TOLERANCE,
        "area_normalized_to_subject": True,
        "strictly_subsequent": "deal_date > as_of",
        "maturity": "today >= as_of + forward_days + gap_days",
        "denominator": "mature rows with a finite value_low and at least one same-building same-floor-plan trade in (as_of, as_of + forward_days]; prices area-normalized to the subject; rate = mean over rows of the share of those trades below value_low",
        "targets": count,
        "valued": valued,
        "missing_value": missing_value,
        "missing_by_basis": missing_by_basis,
        "with_subsequent_confirm": with_confirm,
        "mature": mature,
        "immature": immature,
        "mature_with_confirm": mature_with_confirm,
        "mature_without_confirm": mature_without_confirm,
        "immature_with_confirm": immature_with_confirm,
        "breach_denominator": breach_denominator,
        "confirm_trades": confirm_trades,
        "breach_trades": breach_trades,
        "exceedance_rate": float(share_sum / breach_denominator) if breach_denominator else None,
        "by_cohort": by_cohort,
        "error_by_kind": {
            kind: error_metrics(np.array(predicted[kind]), np.array(actuals[kind]), len(actuals[kind]))
            for kind in sorted(predicted)
        },
        "immature_error_by_kind": {
            kind: error_metrics(np.array(immature_predicted[kind]), np.array(immature_actuals[kind]), len(immature_actuals[kind]))
            for kind in sorted(immature_predicted)
        },
        "evidence_threshold": evidence_threshold(),
    }


def _cohort_lookup(exceedance: dict) -> dict[tuple[str, str], dict]:
    found = {}
    for stats in exceedance.get("by_cohort", {}).values():
        found[(stats["kind"], stats["basis"])] = stats
    return found


def review_cohorts(exceedance: dict) -> list[dict]:
    """Cohorts that are not cleared. Informational; not a live gate."""
    rows = []
    for key, stats in exceedance.get("by_cohort", {}).items():
        if stats.get("status") == "ok":
            continue
        rows.append({
            "cohort": key,
            "kind": stats["kind"],
            "basis": stats["basis"],
            "reason": stats["status"],
            "label": REVIEW_LABEL,
            "mature_with_confirm": stats["mature_with_confirm"],
            "confirm_trades": stats["confirm_trades"],
            "breach_trades": stats["breach_trades"],
            "exceedance_rate": stats["exceedance_rate"],
            "calibration_level": stats["calibration_level"],
            "live_gate": False,
        })
    return rows


def _item_review_reason(value: float, cold: bool, level: object, stats: dict | None) -> tuple[str, str] | None:
    if cold or not np.isfinite(value):
        return "insufficient_evidence", "추정값 없음"
    status = stats["status"] if stats else "insufficient_evidence"
    confirms = int(stats["mature_with_confirm"]) if stats else 0
    rate = stats.get("exceedance_rate") if stats else None
    if status == "lower_breach":
        shown = "-" if rate is None else f"{rate:.1%}"
        return "lower_breach", f"성숙 확인 {confirms}건, 하한 이탈 {shown}"
    if status != "ok":
        if stats is None:
            return "insufficient_evidence", f"성숙 확인 0건 (기준 {MIN_EVIDENCE}건)"
        return "insufficient_evidence", f"성숙 확인 {confirms}건, 보정 {stats.get('calibration_level')} (기준 {MIN_EVIDENCE}건·cell)"
    if str(level) != "cell":
        return "insufficient_evidence", f"이 매물 보정 수준 {level}"
    return None


def upcoming_review(targets: pd.DataFrame, estimates: pd.DataFrame, exceedance: dict, today: float, cap: int = UPCOMING_DISPLAY_CAP) -> dict:
    """Upcoming sales (sale_date > today) whose cohort failed the mature lower-breach audit, or lacks evidence.

    Informational only. Does not change recommendations, bids, or status.
    """
    lookup = _cohort_lookup(exceedance)
    sale_day = day_number(targets["sale_date"]) if "sale_date" in targets.columns else pd.Series(np.nan, index=targets.index)
    court = targets["court"] if "court" in targets.columns else pd.Series("", index=targets.index)
    case_no = targets["case_no"] if "case_no" in targets.columns else pd.Series("", index=targets.index)
    item_no = targets["item_no"] if "item_no" in targets.columns else pd.Series("", index=targets.index)
    sale_date = targets["sale_date"] if "sale_date" in targets.columns else pd.Series("", index=targets.index)
    kind = targets["kind"] if "kind" in targets.columns else pd.Series("", index=targets.index)
    basis = estimates["basis"] if "basis" in estimates.columns else pd.Series("no_comps", index=estimates.index)
    values = pd.to_numeric(estimates["value"], errors="coerce") if "value" in estimates.columns else pd.Series(np.nan, index=estimates.index)
    levels = estimates["calibration_level"] if "calibration_level" in estimates.columns else pd.Series(pd.NA, index=estimates.index)
    cold = estimates["cold_start"] if "cold_start" in estimates.columns else pd.Series(False, index=estimates.index)
    flagged = []
    for pos, idx in enumerate(targets.index):
        when = sale_day.iloc[pos]
        if not np.isfinite(when) or when <= today:
            continue
        stats = lookup.get((str(kind.iloc[pos]), str(basis.iloc[pos])))
        decision = _item_review_reason(
            float(values.iloc[pos]) if pd.notna(values.iloc[pos]) else float("nan"),
            bool(cold.iloc[pos]),
            levels.iloc[pos],
            stats,
        )
        if decision is None:
            continue
        reason, detail = decision
        flagged.append({
            "court": "" if pd.isna(court.iloc[pos]) else str(court.iloc[pos]),
            "case_no": "" if pd.isna(case_no.iloc[pos]) else str(case_no.iloc[pos]),
            "item_no": "" if pd.isna(item_no.iloc[pos]) else str(item_no.iloc[pos]),
            "sale_date": "" if pd.isna(sale_date.iloc[pos]) else str(sale_date.iloc[pos])[:10],
            "basis": "" if pd.isna(basis.iloc[pos]) else str(basis.iloc[pos]),
            "note": f"{REVIEW_LABEL} · {REASON_LABEL.get(reason, reason)}: {detail}",
            "sort_day": int(when),
        })
    flagged.sort(key=lambda row: (row["sort_day"], row["court"], row["case_no"], row["item_no"]))
    for row in flagged:
        del row["sort_day"]
    shown = flagged[:cap]
    return {
        "threshold": threshold_text(),
        "evidence": evidence_text(),
        "total": len(flagged),
        "shown": len(shown),
        "cap": cap,
        "rows": shown,
        "informational": True,
        "live_gate": False,
    }


def vintage_fingerprint(trades: pd.DataFrame, design: pd.DataFrame, cache_version: str, random_state: int = 42) -> str:
    """Hash of every fit input. A cutoff-only key is not a cache hit."""
    if trades.empty:
        return "empty"
    aligned = design.loc[trades.index]
    missing = [column for column in FEATURES if column not in aligned.columns]
    if missing or "anchor" not in aligned.columns or "log_ppm2" not in trades.columns:
        raise KeyError(f"fingerprint requires FEATURES and residual inputs, missing {missing or ['anchor', 'log_ppm2']}")
    hasher = hashlib.sha256()
    settings = {
        "fit": FIT_SETTINGS,
        "quantiles": list(QUANTILES),
        "random_state": int(random_state),
        "lower_coverage": LOWER_COVERAGE,
        "band_coverage": BAND_COVERAGE,
        "features": list(FEATURES),
    }
    hasher.update(cache_version.encode())
    hasher.update(b"|")
    hasher.update(json.dumps(settings, sort_keys=True, separators=(",", ":")).encode())
    hasher.update(np.ascontiguousarray(trades["day"].to_numpy(dtype=np.int64)).tobytes())
    hasher.update(np.ascontiguousarray(trades["known_day"].to_numpy(dtype=np.int64)).tobytes())
    hasher.update(np.ascontiguousarray(np.round(trades["price"].to_numpy(dtype=np.float64)).astype(np.int64)).tobytes())
    hasher.update(np.ascontiguousarray(np.round(trades["area_m2"].to_numpy(dtype=np.float64), 2)).tobytes())
    residual = trades["log_ppm2"].to_numpy(dtype=np.float64) - aligned["anchor"].to_numpy(dtype=np.float64)
    hasher.update(np.ascontiguousarray(np.round(residual, 6)).tobytes())
    hasher.update(np.ascontiguousarray(np.round(aligned[FEATURES].to_numpy(dtype=np.float64), 6)).tobytes())
    hasher.update("\n".join(trades["kind"].astype(str)).encode())
    hasher.update("\n".join(trades["dong"].astype(str)).encode())
    hasher.update("\n".join(trades["bkey"].astype(str)).encode())
    return hasher.hexdigest()[:24]


def _cache_stem(cache_dir: Path, version: str, cutoff: int, fingerprint: str) -> Path:
    return cache_dir / version / f"{int(cutoff)}-{fingerprint}"


def load_month_cache(stem: Path, fingerprint: str, version: str):
    """Load only the file for this fingerprint. A stale sibling is not a hit."""
    meta_path = stem.with_suffix(".json")
    if not meta_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if meta.get("version") != version or meta.get("fingerprint") != fingerprint:
        return None
    if meta.get("features") != FEATURES or list(meta.get("quantiles", [])) != list(QUANTILES):
        return None
    if int(meta.get("min_cell", -1)) != MIN_CELL_ROWS or int(meta.get("min_kind", -1)) != MIN_KIND_ROWS:
        return None
    try:
        calibration = LowerCalibration.from_dict(meta["calibration"])
    except Exception:
        return None
    if calibration.min_cell != MIN_CELL_ROWS or calibration.min_kind != MIN_KIND_ROWS:
        return None
    model_path = stem.parent / str(meta.get("model_file", ""))
    if not model_path.is_file():
        return None
    try:
        if meta.get("format") != "xgb" or not XGBOOST_AVAILABLE:
            return None
        model = xgb.XGBRegressor()
        model.load_model(model_path)
    except Exception:
        return None
    return model, calibration


def save_month_cache(stem: Path, model, calibration: LowerCalibration, fingerprint: str, version: str, cutoff: int) -> None:
    if not XGBOOST_AVAILABLE or not hasattr(model, "save_model"):
        return
    stem.parent.mkdir(parents=True, exist_ok=True)
    model_path = stem.with_suffix(".ubj")
    model.save_model(model_path)
    meta = {
        "version": version,
        "fingerprint": fingerprint,
        "features": FEATURES,
        "quantiles": list(QUANTILES),
        "min_cell": MIN_CELL_ROWS,
        "min_kind": MIN_KIND_ROWS,
        "format": "xgb",
        "model_file": model_path.name,
        "calibration": calibration.to_dict(),
    }
    stem.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")
    prefix = f"{int(cutoff)}-"
    keep = f"{int(cutoff)}-{fingerprint}"
    for path in stem.parent.glob(f"{int(cutoff)}-*"):
        if path.name.startswith(keep):
            continue
        if path.name.startswith(prefix):
            path.unlink(missing_ok=True)


def _blank_estimates(targets: pd.DataFrame, design: pd.DataFrame, comps: pd.DataFrame) -> pd.DataFrame:
    identity = [column for column in ("court", "case_no", "item_no", "sale_date", "as_of", "kind") if column in targets.columns]
    out = targets[identity].copy()
    for column in ("value", "value_low", "value_high"):
        out[column] = np.nan
    area = pd.to_numeric(targets["area_m2"], errors="coerce")
    has_area = area.notna() & (area > 0)
    out["basis"] = design["basis"].where(has_area, "no_area")
    out["building_comps"] = comps["b_n"].fillna(0).astype(int)
    out["dong_comps"] = comps["d_n"].fillna(0).astype(int)
    out["calibration_level"] = pd.Series(pd.NA, index=out.index, dtype=object)
    out["cold_start"] = True
    return out


def value_by_month(
    trades: pd.DataFrame,
    trade_design: pd.DataFrame,
    targets: pd.DataFrame,
    target_design: pd.DataFrame,
    target_comps: pd.DataFrame,
    *,
    random_state: int = 42,
    cache_dir: Path | None = None,
    cache_version: str = AVM_MODEL_VERSION,
    fitter=None,
    min_train: int = MIN_TRAIN_ROWS,
    min_calibration: int = MIN_CALIBRATION_ROWS,
) -> tuple[pd.DataFrame, list[dict]]:
    """Score each as_of month with a model that has not seen trades known after that month's start.

    Unchanged months are loaded from ``cache_dir`` only when the eligible-slice
    fingerprint matches. A later month's model is never applied to an earlier
    month, including cold start.
    """
    fitter = fitter or fit_monthly
    estimates = _blank_estimates(targets, target_design, target_comps)
    if targets.empty or trades.empty:
        return estimates, []
    origin = int(trades["day"].min())
    usable = trade_design["anchor"].notna() & (trades["day"] >= origin + WARMUP_DAYS)
    month_key = month_start_series(targets["day"])
    info = []
    for month_start, positions in targets.groupby(month_key, sort=True).indices.items():
        if not np.isfinite(month_start):
            continue
        cutoff = int(month_start)
        row_index = targets.index[positions]
        eligible = usable & (trades["known_day"] <= cutoff)
        eligible_trades = trades.loc[eligible]
        eligible_design = trade_design.loc[eligible]
        fingerprint = vintage_fingerprint(eligible_trades, eligible_design, cache_version, random_state)
        source = "cold"
        model = None
        calibration = None
        stem = _cache_stem(cache_dir, cache_version, cutoff, fingerprint) if cache_dir is not None else None
        enough = len(eligible_trades) >= min_train + min_calibration
        if enough and stem is not None:
            loaded = load_month_cache(stem, fingerprint, cache_version)
            if loaded is not None:
                model, calibration = loaded
                source = "cache"
        if model is None and enough:
            fitted = fitter(eligible_trades, eligible_design, random_state, min_train, min_calibration)
            if fitted is not None:
                model, calibration = fitted
                source = "fit"
                if stem is not None:
                    try:
                        save_month_cache(stem, model, calibration, fingerprint, cache_version, cutoff)
                    except Exception as exc:
                        print(f"[ml:avm] cache write failed for {format_day(cutoff)}: {exc}")
        if model is not None and calibration is not None:
            scored = score_targets(model, calibration, targets.loc[row_index], target_design.loc[row_index], target_comps.loc[row_index])
            estimates.loc[row_index, scored.columns] = scored
        info.append({
            "month_start": format_day(cutoff),
            "targets": int(len(positions)),
            "source": source,
            "train_rows": int(len(eligible_trades)),
            "fingerprint": fingerprint[:12],
        })
    return estimates, info


def _pct(value) -> str:
    if value is None or (isinstance(value, float) and not np.isfinite(value)):
        return "-"
    return f"{float(value) * 100:.1f}%"


def _ratio(value) -> str:
    if value is None or (isinstance(value, float) and not np.isfinite(value)):
        return "-"
    return f"{float(value):.3f}"


def _md_table(rows: list[dict], headers: list[str]) -> list[str]:
    if not rows:
        return ["_집계 가능한 행이 아직 부족합니다._"]
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(str(row.get(header, "")) for header in headers) + " |")
    return lines

def _point_error_rows(block: dict | None) -> list[dict]:
    return [
        {
            "종류": KIND_LABEL.get(kind, kind),
            "건수": row.get("rows"),
            "MdAPE": _pct(row.get("mdape")),
            "±10%": _pct(row.get("within_10")),
            "편향": _pct(row.get("bias")),
        }
        for kind, row in (block or {}).items()
    ]


def avm_report_lines(metrics: dict) -> list[str]:
    """Full AVM section for the weekly report. Informational; not a live gate.

    ``offline_eval.avm_lines`` should call this instead of formatting the JSON
    itself, so the report and the model stay on one schema.
    """
    lines = ["## Market Value Model (AVM)"]
    kinds = ", ".join(
        f"{KIND_LABEL.get(kind, kind)} {count}" for kind, count in metrics.get("trades_by_kind", {}).items()
    )
    lines += [
        f"- 매매 실거래 {metrics.get('trades', 0)}건({kinds})으로 학습한 report-only 시세. 운영 시세(`market_price`)·추천·입찰·상태는 바꾸지 않는다.",
        f"- {metrics.get('knowledge', {}).get('assumption_ko', KNOWLEDGE_ASSUMPTION_KO)}",
        f"- 모델 `{metrics.get('model_version', AVM_MODEL_VERSION)}`. 평가일이 속한 달의 1일까지 알려진 거래만으로 그 달 매물을 추정한다. "
        "그 이전 달을 전체 거래로 학습한 가중치로 다시 채우지 않는다.",
        f"- 비교 거래 창: 알게 된 날이 평가일 이전이고, 그로부터 {metrics.get('window_days', WINDOW_DAYS)}일 안. "
        f"신고 지연 가정 {metrics.get('gap_days', GAP_DAYS)}일.",
    ]
    fitted = metrics.get("months_fitted")
    cached = metrics.get("months_cached")
    cold = metrics.get("months_cold")
    if fitted is not None:
        lines.append(
            f"- 월별 모델 학습 {fitted}개, 캐시 적중 {cached}개, 이력 부족 {cold}개. "
            "캐시는 그 달 학습 슬라이스의 지문과 같을 때만 쓴다. 거래가 바뀌면 다시 학습한다."
        )
    if metrics.get("cold_start_targets"):
        lines.append(f"- 이력 부족으로 추정하지 않은 매물 {metrics['cold_start_targets']}건. 이후 달 모델로 채우지 않았다.")
    if metrics.get("status") != "ok":
        lines.append("- 시간 분할 검증을 하기에 거래가 부족했습니다.")
    else:
        rows = []
        for kind, model in metrics.get("model", {}).items():
            rule = metrics.get("current_rule", {}).get(kind, {})
            rows.append({
                "구분": KIND_LABEL.get(kind, kind),
                "건수": model["rows"],
                "모델 MdAPE": _ratio(model.get("mdape")),
                "모델 ±10%": _ratio(model.get("within_10")),
                "모델 편향": _ratio(model.get("bias")),
                "현행 규칙 MdAPE": _ratio(rule.get("mdape")),
                "현행 규칙 ±10%": _ratio(rule.get("within_10")),
            })
        basis_rows = [
            {"근거": BASIS_LABEL.get(basis, basis), "건수": row["rows"], "MdAPE": _ratio(row.get("mdape")), "±10%": _ratio(row.get("within_10"))}
            for basis, row in metrics.get("model_by_basis", {}).items()
        ]
        lines += [
            f"- 검증: {metrics.get('test_from')}~{metrics.get('test_to')} 중개거래 {metrics.get('test_rows')}건"
            f"(학습 {metrics.get('train_rows')}건은 {metrics.get('train_known_through', '검증 시작')}까지 알려진 거래). "
            "현행 규칙은 `pipeline/location/comps.ts`의 단계별 중앙값을 같은 정보로 다시 계산한 값.",
            *_md_table(rows, ["구분", "건수", "모델 MdAPE", "모델 ±10%", "모델 편향", "현행 규칙 MdAPE", "현행 규칙 ±10%"]),
            "",
            "근거별 모델 오차(근거 = 가장 가까운 비교 거래 묶음):",
            *_md_table(basis_rows, ["근거", "건수", "MdAPE", "±10%"]),
            "",
            f"- 저장 구간 적중률 {_pct(metrics.get('band_coverage'))}, 구간 폭 중앙값 {_pct(metrics.get('band_median_width'))}(시세 대비). "
            f"상한은 80% 대칭 보정, 하한은 {LOWER_TAIL:.0%} 꼬리다. "
            f"보수 하한의 검증 이탈률 {_pct(metrics.get('lower_holdout_exceedance'))}.",
            f"- 경매 매물 {metrics.get('targets', 0)}건(기일) 중 {metrics.get('targets_valued', 0)}건 추정: "
            + ", ".join(f"{BASIS_LABEL.get(basis, basis)} {count}" for basis, count in metrics.get("targets_by_basis", {}).items()),
        ]
    forward = metrics.get("forward_exceedance") or {}
    if forward:
        lines += [
            "",
            f"전방 확인: 평가일보다 늦게 계약된 같은 건물·같은 면적(±{float(forward.get('similar_size', SAME_UNIT_TOLERANCE)):.0%}) 거래. "
            "후속 거래의 ㎡당 가격을 대상 면적으로 환산한다. 신고 지연 안에 이미 계약된 거래는 넣지 않는다. "
            f"성숙 = 평가일+{forward.get('days', FORWARD_DAYS)}일+신고지연이 오늘 이전. "
            f"하한 이탈률은 거래 단위다. 매물마다 후속 거래 중 하한 아래 비율을 구해 매물 평균을 낸다. "
            f"분모는 성숙하고 하한이 있는 매물 {forward.get('breach_denominator', 0)}건, 후속 거래 {forward.get('confirm_trades', 0)}건 "
            f"(하한 아래 {forward.get('breach_trades', 0)}건, 이탈률 {_pct(forward.get('exceedance_rate'))}).",
            f"- 대상 {forward.get('targets', 0)}건, 추정 {forward.get('valued', 0)}건, 추정 없음 {forward.get('missing_value', 0)}건"
            + ("" if not forward.get("missing_by_basis") else " (" + ", ".join(f"{BASIS_LABEL.get(basis, basis)} {count}" for basis, count in forward["missing_by_basis"].items()) + ")")
            + f". 이후 확인 {forward.get('with_subsequent_confirm', 0)}건, 성숙 {forward.get('mature', 0)}건, 미성숙 {forward.get('immature', 0)}건"
            f"(미성숙 확인 {forward.get('immature_with_confirm', 0)}건은 분모 밖).",
        ]
        cohort_rows = [
            {
                "코호트": f"{KIND_LABEL.get(row['kind'], row['kind'])}·{BASIS_LABEL.get(row['basis'], row['basis'])}",
                "성숙 매물": row["mature_with_confirm"],
                "후속 거래": row["confirm_trades"],
                "하한 아래": row["breach_trades"],
                "이탈률": _pct(row.get("exceedance_rate")),
                "보정": row.get("calibration_level"),
                "심사": "유지" if row.get("status") == "ok" else REVIEW_LABEL,
            }
            for row in forward.get("by_cohort", {}).values()
        ]
        lines += ["", "종류×근거별 성숙 하한 이탈(거래 단위, 매물 평균). '추가 실거래 확인'은 별도 검토 권고이지 운영 게이트가 아니다.", *_md_table(cohort_rows, ["코호트", "성숙 매물", "후속 거래", "하한 아래", "이탈률", "보정", "심사"])]
        lines += ["", "성숙 전방 점추정 오차 (창이 닫힌 확인만)", *_md_table(_point_error_rows(forward.get("error_by_kind")), ["종류", "건수", "MdAPE", "±10%", "편향"])]
        lines += ["", "미성숙 전방 점추정 오차 (분모 밖)", *_md_table(_point_error_rows(forward.get("immature_error_by_kind")), ["종류", "건수", "MdAPE", "±10%", "편향"])]
    review = metrics.get("upcoming_review")
    if review and review.get("threshold"):
        lines += [
            "",
            f"### {REVIEW_LABEL}",
            "정보 제공만. 추천·입찰·상태·필터를 바꾸지 않는다.",
            f"- {review['threshold']}",
            f"- {review.get('evidence', '')}",
            f"- 해당 {review.get('total', 0)}건 중 표시 {review.get('shown', 0)}건, "
            f"상한 {review.get('cap', UPCOMING_DISPLAY_CAP)}건. "
            f"생략 {review.get('total', 0) - review.get('shown', 0)}건은 표에 없다.",
        ]
        upcoming_rows = [
            {
                "법원": row.get("court", ""),
                "사건": row.get("case_no", ""),
                "물건": row.get("item_no", ""),
                "매각일": row.get("sale_date", ""),
                "근거": BASIS_LABEL.get(row.get("basis"), row.get("basis")),
                "사유": row.get("note", ""),
            }
            for row in review.get("rows", [])
        ]
        lines += _md_table(upcoming_rows, ["법원", "사건", "물건", "매각일", "근거", "사유"])
    elif "forward_exceedance" not in metrics:
        lines.append("- 이번 지표에는 월별 하한 심사와 예정 매물 목록이 없다. `npm run ml:avm`을 다시 실행하면 붙는다.")
    return lines + [""]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trades", type=Path, required=True)
    parser.add_argument("--targets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metrics", type=Path, required=True)
    parser.add_argument("--post-sale-output", type=Path, required=True, help="post-sale label values for windows that closed")
    parser.add_argument("--as-of", default=None, help="KST today YYYY-MM-DD; maturity and the upcoming list use this")
    parser.add_argument("--model-version", default=AVM_MODEL_VERSION)
    parser.add_argument("--cache-dir", type=Path, default=CACHE_DIR)
    parser.add_argument("--random-state", type=int, default=42)
    args = parser.parse_args()

    raw_trades = pd.read_csv(args.trades, dtype={"sgg": str, "jibun": str, "name": str, "dong": str})
    trades = prepare_trades(raw_trades)
    if "known_day" not in trades.columns:
        raise RuntimeError("prepare_trades did not set known_day")
    index = build_index(trades)
    trade_comps = comp_features(index, trades)
    trade_design = design_matrix(trades, trade_comps)
    metrics = evaluate(trades, trade_design, trade_comps, args.random_state)
    metrics["trades"] = int(len(trades))
    metrics["trades_by_kind"] = {kind: int(count) for kind, count in trades["kind"].value_counts().items()}
    metrics["gap_days"] = GAP_DAYS
    metrics["window_days"] = WINDOW_DAYS
    metrics["model_version"] = args.model_version
    metrics["valuation"] = "monthly_as_of"
    source = observed_source(raw_trades)
    metrics["knowledge"] = {
        "assumption": KNOWLEDGE_ASSUMPTION,
        "assumption_ko": KNOWLEDGE_ASSUMPTION_KO,
        "observed_column": source,
        "gap_days": GAP_DAYS,
        "cutoff": "known_day <= month_start(as_of)",
    }

    today = pd.Timestamp(args.as_of) if args.as_of else pd.Timestamp.today().normalize()
    today_day = int((today - EPOCH).days)
    raw_targets = pd.read_csv(args.targets, dtype={"court": str, "case_no": str, "item_no": str, "sgg": str, "jibun": str, "name": str, "dong": str})
    targets = prepare_targets(raw_targets, index)
    valued = targets[targets["kind"].isin(list(KIND_CODE)) & targets["day"].notna()].copy()
    target_comps = comp_features(index, valued)
    target_design = design_matrix(valued, target_comps)
    estimates, months = value_by_month(
        trades, trade_design, valued, target_design, target_comps,
        random_state=args.random_state,
        cache_dir=args.cache_dir,
        cache_version=args.model_version,
    )
    metrics["months"] = months
    metrics["months_fitted"] = sum(1 for row in months if row["source"] == "fit")
    metrics["months_cached"] = sum(1 for row in months if row["source"] == "cache")
    metrics["months_cold"] = sum(1 for row in months if row["source"] == "cold")
    metrics["cold_start_targets"] = int(estimates["cold_start"].fillna(False).sum())
    metrics["targets"] = int(len(estimates))
    metrics["targets_valued"] = int(estimates["value"].notna().sum())
    metrics["targets_by_basis"] = {basis: int(count) for basis, count in estimates["basis"].value_counts().items()}
    exceedance = forward_exceedance(index, valued, estimates, today_day)
    metrics["forward_exceedance"] = exceedance
    metrics["review_cohorts"] = review_cohorts(exceedance)
    metrics["upcoming_review"] = upcoming_review(valued, estimates, exceedance, today_day)
    metrics["forward_check"] = {
        "days": FORWARD_DAYS,
        "time_safe": True,
        "similar_size": SAME_UNIT_TOLERANCE,
        "strictly_subsequent": True,
        "all": exceedance["error_by_kind"],
        "after_training": exceedance["error_by_kind"],
        "note": "월별 as-of 모델이라 저장 추정은 그 달 이후 거래로 학습되지 않았다. after_training은 all과 같다.",
        "sections": [{
            "title": "미성숙 전방 확인 (창이 닫히기 전, 하한 이탈률 분모에 넣지 않음)",
            "rows": [
                {
                    "kind": kind,
                    "rows": int(row["rows"]),
                    "mdape": row.get("mdape"),
                    "within_10": row.get("within_10"),
                    "bias": row.get("bias"),
                }
                for kind, row in exceedance.get("immature_error_by_kind", {}).items()
            ],
        }],
    }
    post_sale = post_sale_values(index, targets, today_day)
    metrics["post_sale"] = {
        "method": POST_SALE_METHOD,
        "window_days": POST_SALE_DAYS,
        "gap_days": GAP_DAYS,
        "rows": int(len(post_sale)),
        "with_value": int(post_sale["value"].notna().sum()),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    estimates.to_csv(args.output, index=False)
    args.post_sale_output.parent.mkdir(parents=True, exist_ok=True)
    post_sale.to_csv(args.post_sale_output, index=False)
    args.metrics.parent.mkdir(parents=True, exist_ok=True)
    args.metrics.write_text(json.dumps(json_safe(metrics), ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    if metrics.get("status") == "ok":
        headline = metrics["model"]["all"]
        rule = metrics["current_rule"]["all"]
        print(f"[ml:avm] holdout {metrics['test_from']}~{metrics['test_to']} {metrics['test_rows']}건: "
              f"model MdAPE {headline['mdape']:.3f} (±10% {headline['within_10']:.3f}), "
              f"current rule MdAPE {rule['mdape']:.3f} (±10% {rule['within_10']:.3f})")
    print(f"[ml:avm] monthly models fitted {metrics['months_fitted']}, cache hit {metrics['months_cached']}, cold {metrics['months_cold']}")
    print(f"[ml:avm] {metrics['targets_valued']}/{metrics['targets']} targets valued -> {args.output}")
    print(f"[ml:avm] post-sale {metrics['post_sale']['with_value']}/{metrics['post_sale']['rows']} closed windows valued -> {args.post_sale_output}")


if __name__ == "__main__":
    main()
