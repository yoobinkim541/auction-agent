# Phase2 Offline ML Review

이 리포트는 DB를 수정하지 않는 오프라인 복기입니다. 모델 결과는 운영 추천/입찰가에 자동 반영하지 않습니다.

## Dataset
- Past snapshots: 27945
- Matched outcomes: 27945
- Sold outcomes: 5598
- Sale-ratio labels: 5598
- Positive realized margin rate: 84.0%

## Sale Ratio Regression
| model | train_rows | test_rows | mae_sale_ratio | rmse_sale_ratio |
| --- | --- | --- | --- | --- |
| ensemble_blend | 4174 | 1412 | 0.0617 | 0.0880 |
| hist_absolute | 4174 | 1412 | 0.0626 | 0.0924 |
| hist_gbr | 4174 | 1412 | 0.0637 | 0.0892 |
| xgboost | 4174 | 1412 | 0.0647 | 0.0894 |
| ensemble_conservative | 4174 | 1412 | 0.0825 | 0.1119 |
| current_expected_bid | 4174 | 1412 | 0.1203 | 0.1493 |
| dummy_median | 4174 | 1412 | 0.1708 | 0.2171 |

## Sale Outcome Classification
| model | train_rows | test_rows | roc_auc | balanced_accuracy | accuracy |
| --- | --- | --- | --- | --- | --- |
| hist_gbc | 14483 | 7465 | 0.8061 | 0.7291 | 0.7674 |
| random_forest | 14483 | 7465 | 0.8016 | 0.7365 | 0.7590 |
| xgboost | 14483 | 7465 | 0.7975 | 0.7108 | 0.7941 |
| logistic | 14483 | 7465 | 0.7396 | 0.6856 | 0.6760 |
| dummy_prior | 14483 | 7465 | 0.5000 | 0.5000 | 0.8457 |

## Positive Margin Classification
| model | train_rows | test_rows | roc_auc | balanced_accuracy | accuracy |
| --- | --- | --- | --- | --- | --- |
| xgboost | 4174 | 1406 | 0.9528 | 0.8060 | 0.9104 |
| random_forest | 4174 | 1406 | 0.9488 | 0.8823 | 0.8812 |
| hist_gbc | 4174 | 1406 | 0.9475 | 0.8160 | 0.9111 |
| logistic | 4174 | 1406 | 0.9348 | 0.8793 | 0.8698 |
| dummy_prior | 4174 | 1406 | 0.5000 | 0.5000 | 0.8037 |

## Ensemble Blend
- 내부 시간순 검증창에서 학습한 비음수 가중치: `hist_gbr=0.282, hist_absolute=0.415, xgboost=0.248, group_median=0.046, current_expected_bid=0.010`
- 과대예측 방지 하방 버퍼: `0.0560`
- 외부 holdout에서만 성능을 기록했으며, 운영 추천·입찰가에는 아직 반영하지 않습니다.

## Rolling Time Validation
| fold | train_rows | test_rows | ensemble_mae | current_mae | downside_buffer |
| --- | --- | --- | --- | --- | --- |
| 1 | 2558 | 1286 | 0.0622 | 0.1511 | 0.0575 |
| 2 | 3844 | 1069 | 0.0612 | 0.1347 | 0.0568 |
| 3 | 4908 | 681 | 0.0582 | 0.1153 | 0.0531 |

## Reference Price Performance
| rows | reference_mae | current_mae | reference_win_rate |
| --- | --- | --- | --- |
| 2354 | 0.1069 | 0.1415 | 0.661 |

## Rights Risk Review
| risk_grade | rows | sold | sold_rate | median_realized_margin | avg_assumed_amount | opposition_rows |
| --- | --- | --- | --- | --- | --- | --- |
| review_required | 13811 | 2113 | 0.153 | 0.245 | 266454.30억 | 205 |
| clean | 11954 | 3149 | 0.263 | 0.277 | 0.00억 | 0 |
| caution | 1538 | 324 | 0.211 | 0.388 | 0.00억 | 0 |
| risky | 642 | 12 | 0.019 | 0.178 | 1092.58억 | 642 |

## Feature Coverage Watchlist
| feature | non_null_rows | coverage |
| --- | --- | --- |
| building_area_m2 | 0 | 0.0% |
| area_m2 | 17805 | 63.7% |
| max_safe_bid | 25471 | 91.1% |
| expected_bid | 25673 | 91.9% |
| expected_to_appraisal | 25673 | 91.9% |
| expected_to_min | 25673 | 91.9% |
| market_price | 27846 | 99.6% |
| true_margin | 27846 | 99.6% |
| market_to_appraisal | 27846 | 99.6% |
| market_confidence | 27898 | 99.8% |
| inq_cnt | 27941 | 100.0% |
| interest_cnt | 27941 | 100.0% |

## Surprise Review Cases
| surprise_kind | case_no | item_no | region | sale_ratio | residual_pct | total_score | recommendation | realized_bid_margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| overpriced | 2025타경764 | 1 | 경기도 평택시 | 0.674 | 3.397 | 100 | consider | -0.759 |
| overpriced | 2024타경87449 | 1 | 경기도 수원시 | 1.199 | 1.855 | 83 | consider | -1.028 |
| overpriced | 2024타경93376 | 1 | 경기도 오산시 | 0.745 | 1.130 | 55 | caution | 0.172 |
| overpriced | 2024타경61693 | 1 | 경기도 성남시 | 1.460 | 0.947 | 50 | caution | -0.002 |
| overpriced | 2024타경91084 | 1 | 경기도 양주시 | 1.031 | 0.909 | 97 | avoid | -0.031 |
| overpriced | 2025타경62852 | 1 | 경기도 고양시 | 1.005 | 0.861 | 69 | avoid | -0.434 |
| overpriced | 2024타경7955 | 1 | 경기도 용인시 | 0.629 | 0.747 | 50 | caution | 0.301 |
| overpriced | 2024타경50583 | 1 | 경기도 평택시 | 0.623 | 0.730 | 50 | caution | 0.308 |
| overpriced | 2025타경70774 | 1 | 경기도 남양주시 | 0.835 | 0.704 | 100 | consider | 0.072 |
| overpriced | 2024타경54773 | 1 | 경기도 부천시 | 1.021 | 0.702 | 40 | caution | -0.135 |
| overpriced | 2025타경55803 | 1 | 경기도 수원시 | 0.922 | 0.676 | 40 | avoid | -0.216 |
| overpriced | 2025타경13626 | 1 | 서울특별시 금천구 | 0.930 | 0.674 | 93 | caution | -0.072 |
| overpriced | 2025타경52184 | 1 | 경기도 광주시 | 0.432 | 0.660 | 0 | caution | -0.660 |
| overpriced | 2025타경63952 | 1 | 경기도 고양시 | 0.962 | 0.658 | 86 | avoid | -0.068 |
| overpriced | 2025타경71480 | 1 | 경기도 남양주시 | 1.058 | 0.653 | 90 | avoid | -0.064 |

## Group Median Baseline
| property_type | region | rows | median_sale_ratio | median_realized_margin |
| --- | --- | --- | --- | --- |
| villa | 서울특별시 강서구 | 308 | 0.664 | 0.208 |
| villa | 경기도 수원시 | 262 | 0.540 | 0.263 |
| villa | 경기도 부천시 | 202 | 0.638 | 0.290 |
| officetel | 서울특별시 강서구 | 174 | 0.670 | 0.255 |
| other | 사용본거지 | 151 | 0.688 | 0.237 |
| villa | 경기도 파주시 | 142 | 0.616 | 0.289 |
| villa | 경기도 고양시 | 131 | 0.564 | 0.242 |
| officetel | 경기도 평택시 | 109 | 0.570 | 0.366 |
| villa | 경기도 광주시 | 92 | 0.560 | 0.273 |
| villa | 서울특별시 구로구 | 89 | 0.677 | 0.214 |
| villa | 경기도 안산시 | 83 | 0.517 | 0.235 |
| villa | 서울특별시 양천구 | 82 | 0.761 | 0.142 |
| apartment | 경기도 고양시 | 79 | 0.778 | 0.144 |
| villa | 서울특별시 금천구 | 79 | 0.704 | 0.269 |
| apartment | 경기도 의정부시 | 77 | 0.603 | 0.735 |
| villa | 서울특별시 관악구 | 72 | 0.761 | 0.159 |
| apartment | 경기도 남양주시 | 59 | 0.844 | 0.222 |
| apartment | 경기도 수원시 | 55 | 0.801 | 0.262 |
| officetel | 서울특별시 영등포구 | 54 | 0.761 | 0.154 |
| officetel | 인천광역시 미추홀구 | 54 | 0.612 | 0.320 |

## Adoption Gate
- 결과 미매칭률이 30% 미만으로 내려가기 전까지 운영 점수에 반영하지 않습니다.
- 낙찰가율 라벨 150건 이상, 시간순 holdout에서 현재 `expected_bid`보다 MAE가 낮을 때만 후보로 봅니다.
- `max_safe_bid` 기반 승률은 새 스냅샷부터 쌓이므로 최소 2주 관찰 후 판단합니다.
