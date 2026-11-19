"""Replay three orderings on the same frozen comparison pool. Never rank on a result."""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

WEEKLY_LIMIT = 7
STRATEGIES = {"현행 정밀": None, "예상 순마진율": "bid_margin", "ML": "shadow_good_probability"}
WINNABLE = ("hit", "below_target", "pending", "no_post_sale")   # frozen bid cleared the sold amount inside the range


def selections(candidates: pd.DataFrame, score: str | None) -> pd.DataFrame:
    """Within a KST decision week: first observed day first, then that day's rank.

    Friday cannot retrospectively displace a Monday pick. No fill from a lower
    trust tier; a strategy without a score abstains on that item. ``score=None``
    is the operational order and only sees the frozen precision shortlist.
    """
    if score is None:
        candidates = candidates[candidates.shortlist_eligible.eq(True)]
    order = ["decision_time"]
    ascending = [True]
    if score is not None:
        candidates = candidates[candidates[score].notna()]
        order.append(score)
        ascending.append(False)
    order.extend(["confidence_rank", "price_gap", "sale_date", "listing_id"])
    ascending.extend([False, False, True, True])
    return (candidates.sort_values(order, ascending=ascending, kind="stable")
            .drop_duplicates(["court", "case_no"]).head(WEEKLY_LIMIT))


def _rate(n: int, d: int) -> str:
    return f"{n / d:.0%}" if d else "—"


def render(rows: pd.DataFrame, weeks: int = 8) -> str:
    from .good_listing import DECISION_LOSSES, DECISION_PENDING, POST_SALE_WINDOW_DAYS, bid_margin, reportable_outcomes

    lines = ["# 주간 후보 순위 복기", "",
             "판단일(KST) 기준. 후보군은 같은 날 동결한 비교 후보군(추천·조건부 중 신뢰·권리·입찰 범위 게이트 통과)이다. "
             "현행 정밀은 그중 운영 정밀 숏리스트에 든 매물만, 예상 순마진율과 ML은 후보군 전체에서 고른다. "
             "주중 먼저 고른 사건은 나중 후보로 교체하지 않는다. 각 방식은 주당 최대 7건, 같은 법원·사건은 한 번만 선택한다. "
             "D-1/D-7은 독립 실험이다.", "",
             f"목표 충족은 권장가로 낙찰가를 넘고, 매각 후 {POST_SALE_WINDOW_DAYS}일 안의 같은 건물·같은 평형 실거래 시세에서 "
             "그 권장가와 비용을 뺀 마진이 동결 목표 이상인 경우다. 낙찰 가능은 권장가가 낙찰가를 넘고 범위 안인 건수로 매각 직후 확인된다. "
             "사후 확인 대기는 그중 매각 후 시세 창이 아직 닫히지 않은 건수다. "
             "점수 없는 매물은 선택하지 않는다. 미확정·동가·사후 시세 없음을 실패로 세지 않으며, 결과를 보고 후보를 제거하거나 다시 채우지 않는다.", "",
             f"후보 사건(법원+사건)이 {WEEKLY_LIMIT}건 이하인 주는 모든 방식이 후보를 전부 고를 수 있어 '순서 비교 불가'로 표시한다. 그 주의 차이는 순위 효과가 아니다.", ""]
    frame = rows[rows["snapshot_version"].eq("feature-v2")].copy() if not rows.empty else rows
    if frame.empty:
        return "\n".join(lines + ["동결된 v2 판단 기록이 없습니다. 과거 최신값으로 대체하지 않습니다.", ""])
    frame["decision_time"] = pd.to_datetime(frame["snapped_at"], utc=True, format="mixed")
    frame["decision_day"] = frame.decision_time.dt.tz_convert("Asia/Seoul").dt.tz_localize(None).dt.normalize()
    frame["week"] = frame["decision_day"] - pd.to_timedelta(frame["decision_day"].dt.weekday, unit="D")
    frame["price_gap"] = frame.conservative_value - frame.recommended_bid
    frame["confidence_rank"] = frame.precision_confidence.map({"high": 3, "medium": 2, "low": 1})
    frame["bid_margin"] = bid_margin(frame)
    frame["decision_outcome"] = reportable_outcomes(frame)
    newest = frame.week.max()
    frame = frame[frame.week > newest - pd.Timedelta(weeks=weeks)]
    lines += ["| 판단 주(월) | 시점 | 방식 | 후보 | 점수 있음 | 선택 | 결과 매칭 | 낙찰 가능 | 사후 확인 대기 | 판정 가능 | 목표 충족 | 손실 | 충족/판정 가능 |",
              "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    detail = []
    slots = 0
    comparable = 0
    for (week, horizon), observed in frame.groupby(["week", "horizon_days"], sort=True):
        pool = observed[observed.comparison_eligible.eq(True)]
        rankable = len(pool[["court", "case_no"]].drop_duplicates()) > WEEKLY_LIMIT
        slots += 1
        comparable += int(rankable)
        pool_cell = f"{len(pool)}" if rankable else f"{len(pool)} (순서 비교 불가)"
        for strategy, score in STRATEGIES.items():
            picked = selections(pool, score)
            counts = picked.decision_outcome.value_counts()
            wins = int(counts.get("hit", 0))
            losses = sum(int(counts.get(k, 0)) for k in DECISION_LOSSES)
            known = wins + losses
            winnable = sum(int(counts.get(k, 0)) for k in WINNABLE)
            pending = int(counts.get(DECISION_PENDING, 0))
            scored = int(pool.shortlist_eligible.eq(True).sum()) if score is None else int(pool[score].notna().sum())
            matched = int(picked.matched.eq(True).sum())
            lines.append(f"| {week.date()} | D-{horizon} | {strategy} | {pool_cell} | {scored} | {len(picked)} | {matched} | {winnable} | {pending} | {known} | {wins} | {losses} | {_rate(wins, known)} |")
            if week == newest:
                for rank, r in enumerate(picked.itertuples(), 1):
                    detail.append(f"| D-{horizon} | {strategy} | {rank} | {r.decision_day.date()} | {r.court} {r.case_no} ({r.item_no}) | {str(r.sale_date)[:10]} | {r.decision_outcome} |")
    compared = frame.result_min_price.gt(0) & frame.min_bid_price.gt(0)
    mismatched = int(frame.loc[compared, "result_min_price"].ne(frame.loc[compared, "min_bid_price"]).sum())
    lines += ["", f"순서 비교 가능한 주·시점: {comparable}/{slots} (후보 사건 {WEEKLY_LIMIT + 1}건 이상).",
              "", f"최저가 회차 감사(표에 포함된 기간, 시점별 관측 단위): 비교 가능 {int(compared.sum())}건 중 불일치 {mismatched}건 ({_rate(mismatched, int(compared.sum()))}). 결과표 최저가는 순위에 사용하지 않는다.",
              "", "표본 수·점수 커버리지·결과 확인률을 함께 비교한다. 결과가 부족하거나, 일부 후보만 채점됐거나, 순서 비교 불가인 주는 우위의 근거로 사용하지 않는다."]
    if detail:
        lines += ["", f"## 최근 판단 주({newest.date()}) 선택 내역", "", "| 시점 | 방식 | 선택순 | 판단일 | 사건(물건) | 기일 | 판정 |", "|---|---|---:|---|---|---|---|", *detail]
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("artifacts/ml/frozen_decisions.csv"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/ml/weekly-shortlist.md"))
    args = parser.parse_args()
    rows = pd.read_csv(args.input, dtype={"case_no": str, "item_no": str, "result_cd": str})
    report = render(rows)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report, encoding="utf-8")
    print(f"[ml:weekly] {len(rows)} frozen observations -> {args.output}")


if __name__ == "__main__":
    main()
