/**
 * Phase4a 시간분할 백테스트 — 회차밴드 추가한 실증 낙찰가율 테이블이 기존 대비 낙찰가율 예측을
 * 개선하는지 검증. 학습(과거 매각) → 검증(최근 매각) 분할.
 *
 * 비교 대상:
 *  - new_table: 종류×지역×회차밴드 계층 (이번 변경)
 *  - old_table: 종류×지역만 (기존 로직 재현)
 *  - stored_expected_bid: 스냅샷에 저장된 현행 운영 예상낙찰가(expected_bid/appraisal)
 *
 * 지표: 실제 낙찰가율 대비 MAE·MAPE·편향(+면 과소예측). 낮을수록 좋음.
 * 사용: npm run backtest:sale-ratio [--split-pct 70]
 */
import 'dotenv/config';
import { query, pool } from '../shared/db.ts';
import { buildSaleRatioTable, regionFromAddress, roundBandFromMinBid, type SaleRatioSample } from '../pipeline/cost/sale-ratio-table.ts';
import { median } from '../shared/stats.ts';

interface Row {
  sale_date: string; property_type: string; address: string;
  sale_ratio: number; min_bid_price: number | null; appraisal_value: number;
  expected_bid: number | null;
}

/** 기존 로직 재현: 종류×지역만(회차 무시), MIN_N=20, 종류통합 → 프라이어. */
function oldLookup(samples: SaleRatioSample[]) {
  const byTR = new Map<string, number[]>();
  const byT = new Map<string, number[]>();
  const add = (m: Map<string, number[]>, k: string, v: number) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const s of samples) {
    if (!(s.ratioPct > 0)) continue;
    add(byTR, `${s.propertyType}|${s.region}`, s.ratioPct);
    add(byT, s.propertyType, s.ratioPct);
  }
  const PRIOR: Record<string, number> = { apartment: 88, officetel: 80, villa: 70, house: 75, land: 65 };
  return (propertyType: string, address: string): number => {
    const tr = byTR.get(`${propertyType}|${regionFromAddress(address)}`);
    if (tr && tr.length >= 20) return median(tr)! / 100;
    const t = byT.get(propertyType);
    if (t && t.length >= 20) return median(t)! / 100;
    return (PRIOR[propertyType] ?? 80) / 100;
  };
}

function metrics(preds: number[], actuals: number[]): { n: number; mae: number; mapePct: number; biasPct: number } {
  const errs = preds.map((p, i) => p - actuals[i]!);
  const abs = errs.map(Math.abs);
  const ape = errs.map((e, i) => Math.abs(e) / actuals[i]!);
  const bias = errs.map((e, i) => e / actuals[i]!); // 음수=과대예측
  return {
    n: preds.length,
    mae: abs.reduce((a, b) => a + b, 0) / abs.length,
    mapePct: (ape.reduce((a, b) => a + b, 0) / ape.length) * 100,
    biasPct: (bias.reduce((a, b) => a + b, 0) / bias.length) * 100,
  };
}

async function main(): Promise<void> {
  const splitPct = Number(process.argv.find((a) => a.startsWith('--split-pct='))?.split('=')[1] ?? 70);
  const rows = await query<Row>(
    `select sale_date::text, property_type, address, sale_ratio, min_bid_price, appraisal_value, expected_bid
       from gm_trusted_outcome_eval
      where sold and sale_ratio is not null and sale_ratio > 0
        and appraisal_value > 0 and property_type is not null and sale_date < current_date
      order by sale_date`,
  );
  if (rows.length < 100) { console.log(`표본 부족: ${rows.length}건`); await pool().end(); return; }

  const splitIdx = Math.floor(rows.length * splitPct / 100);
  const splitDate = rows[splitIdx]!.sale_date;
  const train = rows.slice(0, splitIdx);
  const test = rows.slice(splitIdx);

  const trainSamples: SaleRatioSample[] = train.map((x) => ({
    propertyType: x.property_type, region: regionFromAddress(x.address),
    band: roundBandFromMinBid(x.min_bid_price, x.appraisal_value), ratioPct: x.sale_ratio * 100,
  }));
  const newTable = buildSaleRatioTable(trainSamples);
  const oldLk = oldLookup(trainSamples);

  const actuals = test.map((x) => x.sale_ratio);
  const newPreds = test.map((x) => newTable.lookup(x.property_type, x.address, roundBandFromMinBid(x.min_bid_price, x.appraisal_value)).ratioPct / 100);
  const oldPreds = test.map((x) => oldLk(x.property_type, x.address));

  console.log(`=== Phase4a 낙찰가율 백테스트 ===`);
  console.log(`학습 ${train.length}건(~${splitDate} 이전) · 검증 ${test.length}건`);
  console.log(`\n[전체 검증셋]`);
  console.log(`  기존(종류×지역)     :`, fmt(metrics(oldPreds, actuals)));
  console.log(`  신규(+회차밴드)     :`, fmt(metrics(newPreds, actuals)));

  // 스냅샷 저장 expected_bid 있는 행만: 현행 운영 예측과 직접 비교
  const withEb = test.map((x, i) => ({ x, i })).filter(({ x }) => x.expected_bid && x.expected_bid > 0);
  if (withEb.length >= 30) {
    const a = withEb.map(({ x }) => x.sale_ratio);
    const ebPreds = withEb.map(({ x }) => x.expected_bid! / x.appraisal_value);
    const newSub = withEb.map(({ i }) => newPreds[i]!);
    console.log(`\n[expected_bid 저장된 ${withEb.length}건 — 현행 운영 예측과 직접비교]`);
    console.log(`  현행 expected_bid   :`, fmt(metrics(ebPreds, a)));
    console.log(`  신규(+회차밴드)     :`, fmt(metrics(newSub, a)));
  }

  await pool().end();
}

const fmt = (m: { n: number; mae: number; mapePct: number; biasPct: number }): string =>
  `n=${m.n} MAE=${m.mae.toFixed(4)} MAPE=${m.mapePct.toFixed(1)}% 편향=${m.biasPct >= 0 ? '+' : ''}${m.biasPct.toFixed(1)}%`;

main().catch((e) => { console.error('backtest 실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
