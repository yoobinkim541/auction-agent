/**
 * 리포트 전용 앙상블.
 * 1) 탐색용 낙찰가율 — 최신 매물 ⋈ 신뢰 결과. gm_shadow_scores 에만 쓴다. 판단 확률을 넣지 않는다.
 * 2) good-listing-v3 — 그날 동결된 feature-v2 비교 후보군만 채점해 gm_decision_probabilities 에 한 번만 넣는다.
 *    가격 그림자가 없어도 판단 채점은 진행하고, 판단 모델이 기권해도 가격 그림자는 남긴다.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { query, pool } from '../shared/db.ts';
import { TRAINING_ROWS_SQL, frozenFeatureSelectSql, frozenTrainingSql, GOOD_LISTING_MODEL_NAME, GOOD_LISTING_DECISION_LABEL, GOOD_LISTING_DECISION_VERSION } from './export-ml-dataset.ts';
import { FEATURE_SNAPSHOT_VERSION, fullyFrozenSql, kstToday } from './snapshot-predictions.ts';

const MODEL_NAME = 'sale-ratio-ensemble';
const defaultLeadDays = Number(process.env.ML_SHADOW_LEAD_DAYS) || 30;
const leadDays = Number(process.argv.find((arg) => arg.startsWith('--lead-days='))?.slice('--lead-days='.length)) || defaultLeadDays;
const modelVersion = process.argv.find((arg) => arg.startsWith('--model-version='))?.slice('--model-version='.length) ?? process.env.ML_SHADOW_MODEL_VERSION ?? 'ensemble-v2';
const dryRun = process.argv.includes('--dry-run');

type DbRow = Record<string, unknown>;
type Cell = string | number | boolean | null | undefined | Date;

export const DECISION_HASH_FIELDS = [
  'court', 'case_no', 'item_no', 'sale_date', 'horizon_days', 'snapshot_version', 'observed_on',
  'fully_frozen', 'address', 'property_type', 'appraisal_value', 'price_floor', 'area_m2',
  'is_collective_building', 'recommended_bid', 'hard_cap_bid', 'conservative_value',
  'target_margin_pct', 'target_margin_source', 'assumed_amount', 'fixed_costs', 'acq_tax',
  'acq_tax_rate_pct', 'move_out_cost', 'bond_cost', 'etc_cost', 'cost_bid_price', 'cost_bid_basis',
  'inq_cnt', 'interest_cnt', 'has_opposition_tenant', 'risk_grade', 'market_confidence',
  'precision_confidence',
  'avm_value', 'avm_low', 'avm_high', 'avm_basis', 'avm_building_comps', 'avm_model_version',
  'avm_as_of', 'avm_available', 'shortlist_eligible', 'comparison_eligible', 'trust_status',
  'precision_evaluator_version',
] as const;

export function csvCell(value: Cell): string {
  if (value == null) return '';
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function writeCsv(path: string, rows: DbRow[]): void {
  if (!rows.length) {
    writeFileSync(path, '');
    return;
  }
  const columns = Object.keys(rows[0]!);
  const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column] as Cell)).join(','))].join('\n') + '\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv);
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell === '') {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell.endsWith('\r') ? cell.slice(0, -1) : cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function readPredictionCsv(path: string): Record<string, string>[] {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  if (rows.length < 2) return [];
  const headers = rows[0]!;
  return rows.slice(1).filter((row) => row.some((value) => value !== '')).map((row) => Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? '']),
  ));
}

export function pythonPath(): string {
  const localPython = resolve('.venv-ml/bin/python');
  return existsSync(localPython) ? localPython : 'python3';
}

export function itemNo(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || text === 'null' || text === 'undefined') return '1';
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/** 빈 문자열을 0으로 만들지 않는다. 숫자가 아니면 null. */
export function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function decisionKey(row: { court?: unknown; case_no?: unknown; item_no?: unknown; sale_date?: unknown; horizon_days?: unknown }): string {
  return [row.court, row.case_no, itemNo(row.item_no), String(row.sale_date ?? '').slice(0, 10), String(row.horizon_days ?? '').replace(/\.0$/, '')].join('\t');
}

function hashValue(value: unknown): unknown {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return String(value);
}

/** 어댑터가 모델에 넘긴 동결 입력의 해시. 모델이 돌려준 해시는 쓰지 않는다. */
export function decisionSnapshotHash(row: DbRow): string {
  const snapshot: Record<string, unknown> = {};
  for (const field of DECISION_HASH_FIELDS) snapshot[field] = hashValue(row[field]);
  const encoded = JSON.stringify(snapshot, [...DECISION_HASH_FIELDS]);
  return createHash('sha256').update(encoded).digest('hex');
}

export type DecisionInsert = {
  court: string;
  case_no: string;
  item_no: string;
  sale_date: string;
  horizon_days: number;
  observed_on: string;
  snapshot_version: string;
  feature_snapped_at: string;
  probability: number;
  feature_snapshot_hash: string;
};

/** 모델 출력은 확률만 받는다. 키·해시·관측일은 동결 행에서 온다. 범위 밖이거나 후보에 없으면 버린다. */
export function decisionProbabilityPayload(candidates: DbRow[], scored: Record<string, string>[]): DecisionInsert[] {
  const byKey = new Map(candidates.map((row) => [decisionKey(row), row]));
  const inserts: DecisionInsert[] = [];
  for (const score of scored) {
    const frozen = byKey.get(decisionKey(score));
    if (!frozen) continue;
    if (!score.probability?.trim()) continue;
    const probability = Number(score.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) continue;
    const horizon = Number(frozen.horizon_days);
    if (horizon !== 1 && horizon !== 7) continue;
    const snappedAt = frozen.snapped_at instanceof Date ? frozen.snapped_at.toISOString() : String(frozen.snapped_at ?? '');
    if (!snappedAt) continue;
    inserts.push({
      court: String(frozen.court),
      case_no: String(frozen.case_no),
      item_no: itemNo(frozen.item_no),
      sale_date: String(frozen.sale_date).slice(0, 10),
      horizon_days: horizon,
      observed_on: String(frozen.observed_on).slice(0, 10),
      snapshot_version: String(frozen.snapshot_version),
      feature_snapped_at: snappedAt,
      probability,
      feature_snapshot_hash: decisionSnapshotHash(frozen),
    });
  }
  return inserts;
}

/**
 * 오늘 동결됐고 아직 이 모델 버전이 없는 feature-v2 행. 최신 목록·결과와 다시 조인하지 않는다.
 * 인수금액이 없으면 채점하지 않는다. 조회수·관심수·신뢰도가 비어도 행은 남긴다.
 * $1 관측일, $2 모델 이름, $3 모델 버전.
 */
export const DECISION_SCORE_CANDIDATES_SQL = `
  select ${frozenFeatureSelectSql('f')}
    from gm_feature_snapshots f
   where f.observed_on = $1::date
     and f.sale_date > $1::date
     and f.horizon_days in (1, 7)
     and f.snapshot_version = '${FEATURE_SNAPSHOT_VERSION}'
     and ${fullyFrozenSql('f')}
     and f.comparison_eligible is true
     and f.assumed_amount is not null
     and not exists (
       select 1
         from gm_decision_probabilities d
        where d.court = f.court
          and d.case_no = f.case_no
          and d.item_no = f.item_no
          and d.sale_date = f.sale_date
          and d.horizon_days = f.horizon_days
          and d.model_name = $2
          and d.model_version = $3
     )
   order by f.sale_date, f.horizon_days, f.court, f.case_no, f.item_no`;

export const DECISION_PROBABILITY_INSERT_SQL = `
  insert into gm_decision_probabilities
    (court, case_no, item_no, sale_date, horizon_days, model_name, model_version, label_version,
     probability, feature_snapshot_hash, feature_snapped_at)
  select p.court, p.case_no, p.item_no, p.sale_date::date, p.horizon_days, $4, $5, $6,
         p.probability, p.feature_snapshot_hash, p.feature_snapped_at::timestamptz
    from jsonb_to_recordset($1::jsonb) as p(
      court text, case_no text, item_no text, sale_date text, horizon_days int,
      observed_on text, snapshot_version text, probability double precision,
      feature_snapshot_hash text, feature_snapped_at text
    )
   where p.sale_date::date > (now() at time zone 'Asia/Seoul')::date
     and p.observed_on::date = (now() at time zone 'Asia/Seoul')::date
     and $2::date = (now() at time zone 'Asia/Seoul')::date
     and p.snapshot_version = $3
     and p.horizon_days in (1, 7)
     and p.probability >= 0
     and p.probability <= 1
  on conflict (court, case_no, item_no, sale_date, horizon_days, model_name, model_version) do nothing`;

const UPCOMING_PREDICTION_SQL = `
  with latest_listing as (
    select distinct on (court, case_no, coalesce(nullif(item_no, ''), '1')) *
      from gm_listings
     order by court, case_no, coalesce(nullif(item_no, ''), '1'), crawled_at desc nulls last, id desc
  )
  select l.court, l.case_no, coalesce(nullif(l.item_no, ''), '1') as item_no, l.sale_date::text,
         l.property_type, l.address,
         l.appraisal_value::float8, loc.expected_bid_price::float8 as expected_bid,
         loc.market_price::float8, l.min_bid_price::float8,
         s.total_score::float8, s.passed_filter,
         loc.report->>'recommendation' as recommendation,
         (loc.acquisition_cost->>'trueSafetyMargin')::float8 as true_margin,
         r.max_safe_bid::float8, l.inq_cnt::float8, l.interest_cnt::float8,
         l.fail_count::float8, l.area_m2::float8, l.building_area_m2::float8,
         l.is_collective_building, loc.market_confidence,
         r.risk_grade, r.assumed_amount::float8,
         exists (
           select 1
             from jsonb_array_elements(coalesce(r.tenants, '[]'::jsonb)) tenant
            where coalesce((tenant->>'hasOpposition')::boolean, false)
         ) as has_opposition_tenant,
         a.value::float8 as avm_value, a.value_low::float8 as avm_low, a.value_high::float8 as avm_high,
         a.basis as avm_basis, a.building_comps::float8 as avm_building_comps,
         (loc.acquisition_cost->>'moveOutCost')::float8 as move_out_cost,
         (loc.acquisition_cost->>'bondCost')::float8 as bond_cost
    from latest_listing l
    left join gm_location_analysis loc on loc.listing_id = l.id
    left join gm_scores s on s.listing_id = l.id
    left join gm_rights_analysis r on r.listing_id = l.id
    left join gm_avm_estimates a
      on a.court = l.court
     and a.case_no = l.case_no
     and a.item_no = coalesce(nullif(l.item_no, ''), '1')
     and a.sale_date = l.sale_date
   where l.sale_date > $2::date
     and l.sale_date <= $2::date + $1::int
   order by l.sale_date, l.court, l.case_no, item_no`;

function cleanup(paths: string[]): void {
  for (const path of paths) {
    try { unlinkSync(path); } catch { /* 임시 파일이 없어도 된다 */ }
  }
}

async function scoreFrozenDecisions(today: string): Promise<boolean> {
  const paths: string[] = [];
  try {
    const candidates = await query<DbRow>(DECISION_SCORE_CANDIDATES_SQL, [today, GOOD_LISTING_MODEL_NAME, GOOD_LISTING_DECISION_VERSION]);
    if (!candidates.length) {
      console.log('[ml:shadow] 오늘 채점할 feature-v2 동결 행이 없습니다');
      return false;
    }
    const trainingRows = await query<DbRow>(frozenTrainingSql(), [today]);
    const prefix = resolve(tmpdir(), `gyeongmae-ml-good-${process.pid}`);
    const trainPath = `${prefix}-train.csv`;
    const predictPath = `${prefix}-predict.csv`;
    const outputPath = `${prefix}-output.csv`;
    paths.push(trainPath, predictPath, outputPath);
    writeCsv(trainPath, trainingRows);
    writeCsv(predictPath, candidates);
    const scriptPath = fileURLToPath(new URL('./ml/shadow_ensemble.py', import.meta.url));
    const pythonResult = spawnSync(pythonPath(), [
      scriptPath,
      '--good-only',
      '--frozen-train', trainPath,
      '--frozen-predict', predictPath,
      '--good-output', outputPath,
    ], { env: process.env, stdio: 'inherit' });
    if (pythonResult.status !== 0) {
      console.error(`[ml:shadow] ${GOOD_LISTING_DECISION_VERSION} 실패: exit=${pythonResult.status}. 가격 그림자는 계속합니다`);
      return true;
    }
    const scored = readPredictionCsv(outputPath);
    const payload = decisionProbabilityPayload(candidates, scored);
    if (!payload.length) {
      console.log(`[ml:shadow] ${GOOD_LISTING_DECISION_VERSION} 가 쓸 확률이 없습니다 (기권 또는 범위 밖)`);
      return false;
    }
    if (dryRun) {
      console.log(`[ml:shadow] dry-run: ${GOOD_LISTING_DECISION_VERSION} ${payload.length}건을 DB에 저장하지 않았습니다`);
      return false;
    }
    await query(DECISION_PROBABILITY_INSERT_SQL, [
      JSON.stringify(payload),
      today,
      FEATURE_SNAPSHOT_VERSION,
      GOOD_LISTING_MODEL_NAME,
      GOOD_LISTING_DECISION_VERSION,
      GOOD_LISTING_DECISION_LABEL,
    ]);
    console.log(`[ml:shadow] ${GOOD_LISTING_DECISION_VERSION} ${payload.length}건 저장 (do nothing)`);
    return false;
  } catch (error) {
    console.error(`[ml:shadow] ${GOOD_LISTING_DECISION_VERSION} 실패:`, error instanceof Error ? error.message : error, '가격 그림자는 계속합니다');
    return true;
  } finally {
    cleanup(paths);
  }
}

async function scorePriceShadow(today: string): Promise<void> {
  const trainingRows = await query<DbRow>(TRAINING_ROWS_SQL);
  const predictionRows = await query<DbRow>(UPCOMING_PREDICTION_SQL, [leadDays, today]);
  if (!predictionRows.length) {
    console.log(`[ml:shadow] D-1~D-${leadDays} 예정 매물이 없어 가격 그림자를 건너뜁니다`);
    return;
  }
  if (!trainingRows.length) {
    console.error('[ml:shadow] 신뢰 가능한 과거 결과가 없어 가격 그림자를 건너뜁니다');
    return;
  }
  const prefix = resolve(tmpdir(), `gyeongmae-ml-shadow-${process.pid}`);
  const trainPath = `${prefix}-train.csv`;
  const predictPath = `${prefix}-predict.csv`;
  const outputPath = `${prefix}-output.csv`;
  writeCsv(trainPath, trainingRows);
  writeCsv(predictPath, predictionRows);
  try {
    const scriptPath = fileURLToPath(new URL('./ml/shadow_ensemble.py', import.meta.url));
    const pythonResult = spawnSync(pythonPath(), [scriptPath, '--train', trainPath, '--predict', predictPath, '--output', outputPath], {
      env: process.env,
      stdio: 'inherit',
    });
    if (pythonResult.status !== 0) throw new Error(`shadow 모델 실행 실패: exit=${pythonResult.status}`);
    const predictions = readPredictionCsv(outputPath);
    const payload = predictions.flatMap((prediction) => {
      const predicted = finiteNumber(prediction.predicted_sale_ratio);
      if (predicted == null || predicted <= 0) return [];
      const conservative = finiteNumber(prediction.conservative_sale_ratio);
      const confidence = finiteNumber(prediction.confidence);
      return [{
        court: prediction.court,
        case_no: prediction.case_no,
        item_no: prediction.item_no || '1',
        sale_date: prediction.sale_date,
        predicted_sale_ratio: predicted,
        conservative_sale_ratio: conservative != null && conservative > 0 ? conservative : null,
        confidence: confidence != null && confidence >= 0 && confidence <= 1 ? confidence : null,
        feature_snapshot_hash: prediction.feature_snapshot_hash,
        features: JSON.parse(prediction.features_json || '{}') as Record<string, unknown>,
      }];
    });
    if (!payload.length) throw new Error('shadow 모델이 예측을 생성하지 않았습니다');
    if (dryRun) {
      console.log(`[ml:shadow] dry-run: ${payload.length}건을 DB에 저장하지 않았습니다`);
      return;
    }
    await query(
      `insert into gm_shadow_scores
         (court, case_no, item_no, sale_date, model_name, model_version,
          predicted_sale_ratio, conservative_sale_ratio, confidence, feature_snapshot_hash, features)
       select p.court, p.case_no, p.item_no, p.sale_date::date, $2, $3,
              p.predicted_sale_ratio, p.conservative_sale_ratio, p.confidence, p.feature_snapshot_hash, p.features
         from jsonb_to_recordset($1::jsonb) as p(
           court text, case_no text, item_no text, sale_date text,
           predicted_sale_ratio double precision, conservative_sale_ratio double precision,
           confidence double precision, feature_snapshot_hash text, features jsonb
         )
       on conflict (court, case_no, item_no, sale_date, model_name, model_version) do update set
         predicted_sale_ratio=excluded.predicted_sale_ratio,
         conservative_sale_ratio=excluded.conservative_sale_ratio,
         confidence=excluded.confidence,
         feature_snapshot_hash=excluded.feature_snapshot_hash,
         features=excluded.features,
         created_at=now()`,
      [JSON.stringify(payload), MODEL_NAME, modelVersion],
    );
    console.log(`[ml:shadow] ${payload.length}건 저장 완료: ${MODEL_NAME}/${modelVersion}`);
  } finally {
    cleanup([trainPath, predictPath, outputPath]);
  }
}

async function main(): Promise<void> {
  // 매각 당일은 뺀다. 배치가 도는 시각에는 입찰이 이미 시작돼, 그날 다시 쓴 점수는 매각 전 예측이 아니다.
  const today = kstToday();
  const scoringFailed = await scoreFrozenDecisions(today);
  await scorePriceShadow(today);
  if (scoringFailed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error('ml shadow 실패:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => pool().end().catch(() => undefined));
}
