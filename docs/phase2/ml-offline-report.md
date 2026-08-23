# Phase2 Offline ML Review

이 리포트는 DB를 수정하지 않는 오프라인 복기입니다. 모델 결과는 운영 추천/입찰가에 자동 반영하지 않습니다.

## Dataset
- Past snapshots: 2508
- Matched outcomes: 2508
- Sold outcomes: 2508
- Sale-ratio labels: 2508
- Positive realized margin rate: 85.6%

## Sale Ratio Regression
| model | train_rows | test_rows | mae_sale_ratio | rmse_sale_ratio |
| --- | --- | --- | --- | --- |
| xgboost | 1755 | 753 | 0.0793 | 0.1135 |
| hist_gbr | 1755 | 753 | 0.0810 | 0.1180 |
| current_expected_bid | 1755 | 752 | 0.1552 | 0.1834 |
| dummy_median | 1755 | 753 | 0.1805 | 0.2305 |

## Positive Margin Classification
| model | train_rows | test_rows | roc_auc | balanced_accuracy | accuracy |
| --- | --- | --- | --- | --- | --- |
| xgboost | 1755 | 753 | 0.9436 | 0.7897 | 0.9044 |
| random_forest | 1755 | 753 | 0.9419 | 0.8672 | 0.8340 |
| hist_gbc | 1755 | 753 | 0.9414 | 0.8445 | 0.9190 |
| logistic | 1755 | 753 | 0.8757 | 0.8074 | 0.8300 |
| dummy_prior | 1755 | 753 | 0.5000 | 0.5000 | 0.8194 |

## Reference Price Performance
| rows | reference_mae | current_mae | reference_win_rate |
| --- | --- | --- | --- |
| 1091 | 0.1021 | 0.1492 | 0.745 |

## Rights Risk Review
| risk_grade | rows | sold | sold_rate | median_realized_margin | avg_assumed_amount | opposition_rows |
| --- | --- | --- | --- | --- | --- | --- |
| clean | 1442 | 1442 | 1.000 | 0.290 | 0.00억 | 0 |
| review_required | 914 | 914 | 1.000 | 0.255 | 0.00억 | 0 |
| caution | 152 | 152 | 1.000 | 0.359 | 0.00억 | 0 |

## Feature Coverage Watchlist
| feature | non_null_rows | coverage |
| --- | --- | --- |
| expected_bid | 2135 | 85.1% |
| expected_to_appraisal | 2135 | 85.1% |
| expected_to_min | 2135 | 85.1% |
| max_safe_bid | 2166 | 86.4% |
| appraisal_value | 2508 | 100.0% |
| market_price | 2508 | 100.0% |
| min_bid_price | 2508 | 100.0% |
| total_score | 2508 | 100.0% |
| true_margin | 2508 | 100.0% |
| inq_cnt | 2508 | 100.0% |
| interest_cnt | 2508 | 100.0% |
| min_bid_ratio | 2508 | 100.0% |

## Surprise Review Cases
| surprise_kind | case_no | item_no | region | sale_ratio | residual_pct | total_score | recommendation | realized_bid_margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overpriced | 2024타경61693 | 1 | 경기도 성남시 | 1.460 | 0.947 | 50 | caution | -0.002 |
| overpriced | 2024타경91084 | 1 | 경기도 양주시 | 1.031 | 0.909 | 97 | avoid | -0.031 |
| overpriced | 2024타경54773 | 1 | 경기도 부천시 | 1.021 | 0.702 | 40 | caution | -0.135 |
| overpriced | 2025타경55803 | 1 | 경기도 수원시 | 0.922 | 0.676 | 40 | avoid | -0.216 |
| overpriced | 2025타경63952 | 1 | 경기도 고양시 | 0.962 | 0.658 | 86 | avoid | -0.068 |
| overpriced | 2025타경71480 | 1 | 경기도 남양주시 | 1.058 | 0.653 | 90 | avoid | -0.064 |
| overpriced | 2024타경75316 | 1 | 경기도 용인시 | 0.933 | 0.637 | 46 | caution | -0.037 |
| overpriced | 2025타경102393 | 1 | 서울특별시 강남구 | 1.145 | 0.590 | 68 | avoid | -0.143 |
| overpriced | 2023타경104455 | 1 | 경기도 안양시 | 1.280 | 0.580 | 96 | consider | 0.015 |
| overpriced | 2023타경104820 | 1 | 경기도 의왕시 | 1.146 | 0.549 | 50 | caution | 0.119 |
| overpriced | 2025타경56215 | 1 | 경기도 오산시 | 0.848 | 0.542 | 0 | avoid | -1.289 |
| overpriced | 2025타경102095 | 1 | 서울특별시 동작구 | 1.169 | 0.462 | 33 | avoid | -1.165 |
| overpriced | 2024타경2205 | 1 | 경기도 광주시 | 0.800 | 0.455 | 66 | avoid | -0.204 |
| overpriced | 2025타경32544 | 1 | 경기도 부천시 | 0.870 | 0.449 | 31 | avoid | 0.034 |
| overpriced | 2025타경30750 | 1 | 경기도 부천시 | 0.912 | 0.448 | 77 | avoid | -0.013 |

## Group Median Baseline
| property_type | region | rows | median_sale_ratio | median_realized_margin |
| --- | --- | --- | --- | --- |
| villa | 서울특별시 강서구 | 160 | 0.664 | 0.229 |
| villa | 경기도 수원시 | 109 | 0.535 | 0.410 |
| officetel | 서울특별시 강서구 | 104 | 0.669 | 0.258 |
| villa | 경기도 부천시 | 93 | 0.655 | 0.273 |
| villa | 경기도 파주시 | 58 | 0.636 | 0.296 |
| other | 사용본거지 | 57 | 0.641 | 0.288 |
| villa | 경기도 고양시 | 55 | 0.542 | 0.217 |
| apartment | 경기도 의정부시 | 50 | 0.543 | 0.735 |
| villa | 서울특별시 구로구 | 46 | 0.688 | 0.147 |
| officetel | 인천광역시 미추홀구 | 42 | 0.612 | 0.320 |
| villa | 서울특별시 금천구 | 40 | 0.709 | 0.229 |
| villa | 서울특별시 양천구 | 36 | 0.754 | 0.064 |
| villa | 서울특별시 동작구 | 33 | 0.955 | 0.051 |
| officetel | 인천광역시 부평구 | 33 | 0.650 | 0.278 |
| villa | 경기도 광주시 | 32 | 0.576 | 0.245 |
| villa | 서울특별시 관악구 | 31 | 0.754 | 0.158 |
| officetel | 서울특별시 영등포구 | 29 | 0.761 | 0.162 |
| apartment | 경기도 남양주시 | 28 | 0.858 | 0.165 |
| officetel | 서울특별시 금천구 | 28 | 0.670 | 0.255 |
| officetel | 경기도 평택시 | 27 | 0.570 | 0.367 |

## Adoption Gate
- 결과 미매칭률이 30% 미만으로 내려가기 전까지 운영 점수에 반영하지 않습니다.
- 낙찰가율 라벨 150건 이상, 시간순 holdout에서 현재 `expected_bid`보다 MAE가 낮을 때만 후보로 봅니다.
- `max_safe_bid` 기반 승률은 새 스냅샷부터 쌓이므로 최소 2주 관찰 후 판단합니다.
