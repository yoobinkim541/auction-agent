/**
 * 시간분할 백테스트 — 예상낙찰가의 실증 폴백(최저가 대비 배율 테이블)이 직전 로직보다 낙찰가율을
 * 잘 맞히는지 검증. 학습(과거 매각) → 검증(최근 매각) 분할.
 *
 * 비교 대상(둘 다 운영과 같이 '이번 최저가' 하한을 적용):
 *  - 배율+시세 구간: 아파트는 그 기일의 신뢰도 high 시세÷최저가 구간별 배율을 먼저 본다 (현행)
 *  - 배율: 종류×지역×회차밴드의 '낙찰가÷최저가' 중앙값 × 이번 최저가 (시세 구간 없이)
 *  - 밴드 낙찰가율: 종류×지역×회차밴드의 낙찰가율 중앙값 (직전 로직 재현)
 *  - stored_expected_bid: 스냅샷에 저장된 그 시점 운영 예상낙찰가(expected_bid/appraisal)
 *
 * 지표: 실제 낙찰가율 대비 MAE·MAPE·편향(예측−실제, +면 과대예측). 낮을수록 좋음.
 * 사용: npm run backtest:sale-ratio [--split-pct=70]
 */
import 'dotenv/config';
import { pool } from '../shared/db.ts';
import {
  buildSaleRatioTable, loadSaleRatioRows, regionFromAddress, roundBandFromMinBid, toSample, MIN_N, TYPE_RATIO_PRIOR,
  type SaleRatioRow as Row,
} from '../pipeline/cost/sale-ratio-table.ts';
import { median } from '../shared/stats.ts';

/** 직전 로직 재현: 낙찰가율 중앙값을 종류×지역×밴드 → 종류×밴드 → 종류×지역 → 종류 → 프라이어 순으로 조회. */
function bandRatioLookup(train: Row[]) {
  const cells = new Map<string, number[]>();
  for (const x of train) {
    const region = regionFromAddress(x.address);
    const band = roundBandFromMinBid(x.min_bid_price, x.appraisal_value);
    for (const key of [`${x.property_type}|${region}|${band}`, `${x.property_type}|${band}`, `${x.property_type}|${region}`, x.property_type]) {
      const arr = cells.get(key);
      if (arr) arr.push(x.sale_ratio * 100); else cells.set(key, [x.sale_ratio * 100]); // %: shared median 은 짝수 개수 평균을 정수로 반올림한다
    }
  }
  return (x: Row): number => {
    const region = regionFromAddress(x.address);
    const band = roundBandFromMinBid(x.min_bid_price, x.appraisal_value);
    for (const key of [`${x.property_type}|${region}|${band}`, `${x.property_type}|${band}`, `${x.property_type}|${region}`, x.property_type]) {
      const arr = cells.get(key);
      if (arr && arr.length >= MIN_N) return Math.round(median(arr)!) / 100;
    }
    return (TYPE_RATIO_PRIOR[x.property_type] ?? 80) / 100;
  };
}

function metrics(preds: number[], actuals: number[]): { n: number; mae: number; mapePct: number; biasPct: number } {
  const errs = preds.map((p, i) => p - actuals[i]!);
  const abs = errs.map(Math.abs);
  const ape = errs.map((e, i) => Math.abs(e) / actuals[i]!);
  const bias = errs.map((e, i) => e / actuals[i]!); // 양수=과대예측
  return {
    n: preds.length,
    mae: abs.reduce((a, b) => a + b, 0) / abs.length,
    mapePct: (ape.reduce((a, b) => a + b, 0) / ape.length) * 100,
    biasPct: (bias.reduce((a, b) => a + b, 0) / bias.length) * 100,
  };
}

async function main(): Promise<void> {
  const splitPct = Number(process.argv.find((a) => a.startsWith('--split-pct='))?.split('=')[1] ?? 70);
  const rows = await loadSaleRatioRows();
  if (rows.length < 100) { console.log(`표본 부족: ${rows.length}건`); await pool().end(); return; }

  const splitIdx = Math.floor(rows.length * splitPct / 100);
  const splitDate = rows[splitIdx]!.sale_date;
  const train = rows.slice(0, splitIdx);
  const test = rows.slice(splitIdx);

  const newTable = buildSaleRatioTable(train.map(toSample));
  const oldLk = bandRatioLookup(train);

  // 운영(expectedBid)과 같이 이번 최저가를 하한으로 둔다.
  const floorAtMin = (x: Row, ratio: number): number => Math.max(ratio, x.min_bid_price / x.appraisal_value);
  const actuals = test.map((x) => x.sale_ratio);
  const newPreds = test.map((x) => floorAtMin(x, newTable.lookup(x.property_type, x.address, x.min_bid_price, x.appraisal_value, x.market_price).ratioPct / 100));
  const plainPreds = test.map((x) => floorAtMin(x, newTable.lookup(x.property_type, x.address, x.min_bid_price, x.appraisal_value).ratioPct / 100));
  const oldPreds = test.map((x) => floorAtMin(x, oldLk(x)));

  console.log(`=== 예상 낙찰가율 백테스트 ===`);
  console.log(`학습 ${train.length}건(~${splitDate} 이전) · 검증 ${test.length}건`);
  console.log(`\n[전체 검증셋]`);
  console.log(`  밴드 낙찰가율(옛 로직)   :`, fmt(metrics(oldPreds, actuals)));
  console.log(`  최저가 배율(시세 구간 없이):`, fmt(metrics(plainPreds, actuals)));
  console.log(`  현행(배율+시세 구간)     :`, fmt(metrics(newPreds, actuals)));

  const apartments = test.map((x, i) => ({ x, i })).filter(({ x }) => x.property_type === 'apartment');
  if (apartments.length >= 30) {
    const a = apartments.map(({ x }) => x.sale_ratio);
    const anchored = apartments.filter(({ x }) => x.market_price).length;
    console.log(`\n[아파트 ${apartments.length}건 — 그중 그 기일 시세 신뢰도 high ${anchored}건]`);
    console.log(`  최저가 배율(시세 구간 없이):`, fmt(metrics(apartments.map(({ i }) => plainPreds[i]!), a)));
    console.log(`  현행(배율+시세 구간)     :`, fmt(metrics(apartments.map(({ i }) => newPreds[i]!), a)));
  }

  // 스냅샷 저장 expected_bid 있는 행만: 현행 운영 예측과 직접 비교
  const withEb = test.map((x, i) => ({ x, i })).filter(({ x }) => x.expected_bid && x.expected_bid > 0);
  if (withEb.length >= 30) {
    const a = withEb.map(({ x }) => x.sale_ratio);
    const ebPreds = withEb.map(({ x }) => x.expected_bid! / x.appraisal_value);
    const newSub = withEb.map(({ i }) => newPreds[i]!);
    console.log(`\n[expected_bid 저장된 ${withEb.length}건 — 그 시점 운영 예측과 직접비교]`);
    console.log(`  저장된 expected_bid :`, fmt(metrics(ebPreds, a)));
    console.log(`  현행(배율+시세 구간) :`, fmt(metrics(newSub, a)));
  }

  await pool().end();
}

const fmt = (m: { n: number; mae: number; mapePct: number; biasPct: number }): string =>
  `n=${m.n} MAE=${m.mae.toFixed(4)} MAPE=${m.mapePct.toFixed(1)}% 편향=${m.biasPct >= 0 ? '+' : ''}${m.biasPct.toFixed(1)}%`;

main().catch((e) => { console.error('backtest 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
