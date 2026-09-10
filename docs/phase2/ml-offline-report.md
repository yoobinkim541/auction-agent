# Phase2 Offline ML Review

이 리포트는 DB를 수정하지 않는 오프라인 복기입니다. 모델 결과는 운영 추천/입찰가에 자동 반영하지 않습니다.

## Dataset
- Past snapshots: 3844
- Matched outcomes: 3844
- Sold outcomes: 3844
- Sale-ratio labels: 3844
- Positive realized margin rate: 85.2%

## Sale Ratio Regression
| model | train_rows | test_rows | mae_sale_ratio | rmse_sale_ratio |
| --- | --- | --- | --- | --- |
| hist_gbr | 2690 | 1154 | 0.0748 | 0.1228 |
| xgboost | 2690 | 1154 | 0.0776 | 0.1377 |
| current_expected_bid | 2690 | 1144 | 0.1516 | 0.2092 |
| dummy_median | 2690 | 1154 | 0.1682 | 0.2350 |

## Positive Margin Classification
| model | train_rows | test_rows | roc_auc | balanced_accuracy | accuracy |
| --- | --- | --- | --- | --- | --- |
| xgboost | 2690 | 1153 | 0.9397 | 0.7659 | 0.9055 |
| random_forest | 2690 | 1153 | 0.9386 | 0.8670 | 0.8751 |
| hist_gbc | 2690 | 1153 | 0.9382 | 0.7832 | 0.9107 |
| logistic | 2690 | 1153 | 0.9142 | 0.8400 | 0.8534 |
| dummy_prior | 2690 | 1153 | 0.5000 | 0.5000 | 0.8500 |

## Reference Price Performance
| rows | reference_mae | current_mae | reference_win_rate |
| --- | --- | --- | --- |
| 1601 | 0.1204 | 0.1505 | 0.693 |

## Rights Risk Review
| risk_grade | rows | sold | sold_rate | median_realized_margin | avg_assumed_amount | opposition_rows |
| --- | --- | --- | --- | --- | --- | --- |
| clean | 2182 | 2182 | 1.000 | 0.282 | 0.00억 | 0 |
| review_required | 1442 | 1442 | 1.000 | 0.261 | 0.01억 | 4 |
| caution | 218 | 218 | 1.000 | 0.365 | 0.00억 | 0 |
| risky | 2 | 2 | 1.000 | 0.277 | 1.82억 | 2 |

## Feature Coverage Watchlist
| feature | non_null_rows | coverage |
| --- | --- | --- |
| expected_bid | 3334 | 86.7% |
| expected_to_appraisal | 3334 | 86.7% |
| expected_to_min | 3334 | 86.7% |
| max_safe_bid | 3345 | 87.0% |
| market_price | 3843 | 100.0% |
| true_margin | 3843 | 100.0% |
| market_to_appraisal | 3843 | 100.0% |
| appraisal_value | 3844 | 100.0% |
| min_bid_price | 3844 | 100.0% |
| total_score | 3844 | 100.0% |
| inq_cnt | 3844 | 100.0% |
| interest_cnt | 3844 | 100.0% |

## Surprise Review Cases
| surprise_kind | case_no | item_no | region | sale_ratio | residual_pct | total_score | recommendation | realized_bid_margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overpriced | 2025타경51213 | 1 | 서울특별시 은평구 | 3.883 | 3.413 | 62 | avoid | -2.790 |
| overpriced | 2025타경764 | 1 | 서울특별시 영등포구 | 0.674 | 3.397 | 100 | consider | -0.759 |
| overpriced | 2025타경51573 | 1 | 경기도 하남시 | 1.625 | 1.851 | 88 | avoid | -0.806 |
| overpriced | 2024타경61693 | 1 | 경기도 성남시 | 1.460 | 0.947 | 50 | caution | -0.002 |
| overpriced | 2024타경91084 | 1 | 경기도 양주시 | 1.031 | 0.909 | 97 | avoid | -0.031 |
| overpriced | 2025타경62852 | 1 | 경기도 고양시 | 1.005 | 0.861 | 69 | avoid | -0.434 |
| overpriced | 2024타경50583 | 1 | 경기도 평택시 | 0.623 | 0.730 | 50 | caution | 0.308 |
| overpriced | 2025타경70774 | 1 | 경기도 남양주시 | 0.835 | 0.704 | 100 | consider | 0.072 |
| overpriced | 2024타경54773 | 1 | 경기도 부천시 | 1.021 | 0.702 | 40 | caution | -0.135 |
| overpriced | 2025타경55803 | 1 | 경기도 수원시 | 0.922 | 0.676 | 40 | avoid | -0.216 |
| overpriced | 2025타경13626 | 1 | 서울특별시 금천구 | 0.930 | 0.674 | 93 | caution | -0.072 |
| overpriced | 2025타경63952 | 1 | 경기도 고양시 | 0.962 | 0.658 | 86 | avoid | -0.068 |
| overpriced | 2025타경71480 | 1 | 경기도 남양주시 | 1.058 | 0.653 | 90 | avoid | -0.064 |
| overpriced | 2024타경75316 | 1 | 경기도 용인시 | 0.933 | 0.637 | 46 | caution | -0.037 |
| overpriced | 2025타경102393 | 1 | 서울특별시 강남구 | 1.145 | 0.590 | 68 | avoid | -0.143 |

## Group Median Baseline
| property_type | region | rows | median_sale_ratio | median_realized_margin |
| --- | --- | --- | --- | --- |
| villa | 서울특별시 강서구 | 221 | 0.664 | 0.211 |
| villa | 경기도 부천시 | 177 | 0.637 | 0.292 |
| villa | 경기도 수원시 | 134 | 0.541 | 0.399 |
| officetel | 서울특별시 강서구 | 125 | 0.670 | 0.256 |
| villa | 경기도 파주시 | 100 | 0.635 | 0.293 |
| villa | 경기도 고양시 | 94 | 0.562 | 0.247 |
| other | 사용본거지 | 92 | 0.652 | 0.276 |
| villa | 경기도 광주시 | 65 | 0.583 | 0.257 |
| villa | 서울특별시 구로구 | 60 | 0.686 | 0.203 |
| villa | 서울특별시 금천구 | 59 | 0.716 | 0.223 |
| apartment | 경기도 의정부시 | 59 | 0.556 | 0.735 |
| villa | 서울특별시 양천구 | 54 | 0.758 | 0.142 |
| villa | 서울특별시 관악구 | 49 | 0.758 | 0.177 |
| apartment | 경기도 남양주시 | 48 | 0.843 | 0.231 |
| officetel | 경기도 평택시 | 47 | 0.570 | 0.367 |
| villa | 경기도 안산시 | 46 | 0.586 | 0.388 |
| apartment | 경기도 고양시 | 45 | 0.796 | 0.110 |
| officetel | 인천광역시 미추홀구 | 43 | 0.612 | 0.320 |
| apartment | 경기도 수원시 | 42 | 0.652 | 0.272 |
| apartment | 경기도 부천시 | 41 | 0.764 | 0.151 |

## Adoption Gate
- 결과 미매칭률이 30% 미만으로 내려가기 전까지 운영 점수에 반영하지 않습니다.
- 낙찰가율 라벨 150건 이상, 시간순 holdout에서 현재 `expected_bid`보다 MAE가 낮을 때만 후보로 봅니다.
- `max_safe_bid` 기반 승률은 새 스냅샷부터 쌓이므로 최소 2주 관찰 후 판단합니다.
