# Phase2 Offline ML Review

이 리포트는 DB를 수정하지 않는 오프라인 복기입니다. 모델 결과는 운영 추천/입찰가에 자동 반영하지 않습니다.

## Dataset
- Past snapshots: 3226
- Matched outcomes: 1748
- Sold outcomes: 425
- Sale-ratio labels: 424
- Positive realized margin rate: 83.3%

## Sale Ratio Regression
| model | train_rows | test_rows | mae_sale_ratio | rmse_sale_ratio |
| --- | --- | --- | --- | --- |
| xgboost | 296 | 128 | 0.1300 | 0.1952 |
| hist_gbr | 296 | 128 | 0.1316 | 0.2020 |
| dummy_median | 296 | 128 | 0.2478 | 0.3233 |
| current_expected_bid | 296 | 92 | 0.2951 | 0.3619 |

## Positive Margin Classification
| model | train_rows | test_rows | roc_auc | balanced_accuracy | accuracy |
| --- | --- | --- | --- | --- | --- |
| random_forest | 296 | 128 | 0.9046 | 0.7944 | 0.8594 |
| hist_gbc | 296 | 128 | 0.8593 | 0.7128 | 0.8906 |
| xgboost | 296 | 128 | 0.8352 | 0.7218 | 0.9062 |
| logistic | 296 | 128 | 0.7727 | 0.6725 | 0.7344 |
| dummy_prior | 296 | 128 | 0.5000 | 0.5000 | 0.8672 |

## Reference Price Performance
| rows | reference_mae | current_mae | reference_win_rate |
| --- | --- | --- | --- |
| 248 | 0.1120 | 0.2359 | 0.471 |

## Rights Risk Review
| risk_grade | rows | sold | sold_rate | median_realized_margin | avg_assumed_amount | opposition_rows |
| --- | --- | --- | --- | --- | --- | --- |
| review_required | 972 | 283 | 0.291 | 0.312 | 0.00억 | 0 |
| clean | 629 | 96 | 0.153 | 0.345 | 0.00억 | 0 |
| caution | 146 | 46 | 0.315 | 0.403 | 0.00억 | 0 |
| risky | 1 | 0 | 0.000 | - | 1.10억 | 1 |

## Feature Coverage Watchlist
| feature | non_null_rows | coverage |
| --- | --- | --- |
| max_safe_bid | 0 | 0.0% |
| expected_bid | 1217 | 37.7% |
| expected_to_appraisal | 1217 | 37.7% |
| expected_to_min | 1217 | 37.7% |
| inq_cnt | 2764 | 85.7% |
| interest_cnt | 2764 | 85.7% |
| appraisal_value | 3226 | 100.0% |
| market_price | 3226 | 100.0% |
| min_bid_price | 3226 | 100.0% |
| total_score | 3226 | 100.0% |
| true_margin | 3226 | 100.0% |
| min_bid_ratio | 3226 | 100.0% |

## Surprise Review Cases
| surprise_kind | case_no | item_no | region | sale_ratio | residual_pct | total_score | recommendation | realized_bid_margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overpriced | 2025타경102861 | 1 | 서울특별시 서초구 | 1.598 | 0.598 | 21 | avoid | -0.113 |
| overpriced | 2024타경38337 | 1 | 경기도 양평군 | 1.526 | 0.526 | 0 | caution | -0.696 |
| overpriced | 2024타경40736 | 1 | 경기도 양평군 | 1.357 | 0.357 | 0 | avoid | -0.508 |
| overpriced | 2024타경3074 | 1 | 서울특별시 구로구 | 0.851 | 0.182 | 54 | caution | -0.128 |
| overpriced | 2024타경4778 | 1 | 경기도 이천시 | 1.012 | 0.150 | 31 | caution | 0.107 |
| overpriced | 2024타경103655 | 1 | 경기도 수원시 | 0.562 | 0.022 | 100 | consider | 0.463 |
| overpriced | 2025타경12308 | 1 | 서울특별시 금천구 | 1.001 | 0.001 | 0 | caution | -0.001 |
| avoid_but_sold | 2025타경12212 | 1 | 서울특별시 강서구 | 1.961 | - | 40 | caution | 0.363 |
| avoid_but_sold | 2025-103154 | 1 | 서울특별시 동작구 | 1.686 | - | 55 | caution | 0.288 |
| avoid_but_sold | 2024타경55397 | 1 | 경기도 평택시 | 1.630 | - | 55 | caution | -0.811 |
| avoid_but_sold | 2025타경102861 | 1 | 서울특별시 서초구 | 1.598 | 0.598 | 21 | avoid | -0.113 |
| avoid_but_sold | 2024타경38337 | 1 | 경기도 양평군 | 1.526 | 0.526 | 0 | caution | -0.696 |
| avoid_but_sold | 2025타경11310 | 1 | 서울특별시 강서구 | 1.397 | - | 33 | caution | 0.275 |
| avoid_but_sold | 2024타경40736 | 1 | 경기도 양평군 | 1.357 | 0.357 | 0 | avoid | -0.508 |
| avoid_but_sold | 2025타경12685 | 1 | 서울특별시 강서구 | 1.219 | - | 0 | caution | 0.100 |

## Group Median Baseline
| property_type | region | rows | median_sale_ratio | median_realized_margin |
| --- | --- | --- | --- | --- |
| villa | 인천광역시 미추홀구 | 32 | 0.607 | 0.275 |
| villa | 인천광역시 서구 | 28 | 0.585 | 0.292 |
| villa | 경기도 고양시 | 24 | 0.540 | 0.315 |
| villa | 경기도 파주시 | 20 | 0.645 | 0.332 |
| villa | 인천광역시 부평구 | 20 | 0.571 | 0.357 |
| villa | 경기도 광주시 | 20 | 0.536 | 0.333 |
| villa | 인천광역시 남동구 | 14 | 0.505 | 0.323 |
| villa | 경기도 안산시 | 13 | 0.585 | 0.440 |
| villa | 경기도 수원시 | 11 | 0.710 | 0.003 |
| villa | 서울특별시 관악구 | 11 | 0.706 | 0.102 |
| villa | 인천광역시 계양구 | 11 | 0.574 | 0.305 |
| villa | 서울특별시 동작구 | 8 | 0.821 | 0.574 |
| villa | 서울특별시 강서구 | 7 | 0.770 | 0.275 |
| villa | 경기도 부천시 | 7 | 0.638 | 0.291 |
| villa | 서울특별시 서초구 | 6 | 0.839 | -0.132 |
| villa | 경기도 평택시 | 6 | 0.285 | 0.400 |
| officetel | 서울특별시 강서구 | 5 | 0.746 | 0.344 |
| officetel | 경기도 수원시 | 5 | 0.734 | 0.184 |

## Adoption Gate
- 결과 미매칭률이 30% 미만으로 내려가기 전까지 운영 점수에 반영하지 않습니다.
- 낙찰가율 라벨 150건 이상, 시간순 holdout에서 현재 `expected_bid`보다 MAE가 낮을 때만 후보로 봅니다.
- `max_safe_bid` 기반 승률은 새 스냅샷부터 쌓이므로 최소 2주 관찰 후 판단합니다.
