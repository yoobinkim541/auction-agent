import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { query, pool } from '../shared/db.ts';

type Cell = string | number | boolean | null | undefined | Date;
type DbRow = Record<string, Cell>;

const MODEL_NAME = 'sale-ratio-ensemble';
const defaultLeadDays = Number(process.env.ML_SHADOW_LEAD_DAYS) || 30;
const leadDays = Number(process.argv.find((arg) => arg.startsWith('--lead-days='))?.slice('--lead-days='.length)) || defaultLeadDays;
const modelVersion = process.argv.find((arg) => arg.startsWith('--model-version='))?.slice('--model-version='.length)
  ?? process.env.ML_SHADOW_MODEL_VERSION
  ?? 'ensemble-v1';
const dryRun = process.argv.includes('--dry-run');

const csvCell = (value: Cell): string => {
  if (value == null) return '';
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function writeCsv(path: string, rows: DbRow[]): void {
  if (!rows.length) {
    writeFileSync(path, '');
    return;
  }
  const columns = Object.keys(rows[0]!);
  const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv);
}

function parseCsv(text: string): string[][] {
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

function readPredictionCsv(path: string): Record<string, string>[] {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  if (rows.length < 2) return [];
  const headers = rows[0]!;
  return rows.slice(1).filter((row) => row.some((value) => value !== '')).map((row) => Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? '']),
  ));
}

function pythonPath(): string {
  const localPython = resolve('.venv-ml/bin/python');
  return existsSync(localPython) ? localPython : 'python3';
}

async function main(): Promise<void> {
  const trainingRows = await query<DbRow>(
    `with latest_listing as (
       select distinct on (case_no, coalesce(nullif(item_no, ''), '1'))
              id as listing_id, case_no, coalesce(nullif(item_no, ''), '1') as item_no
         from gm_listings
        order by case_no, coalesce(nullif(item_no, ''), '1'), crawled_at desc nulls last, id desc
     ), trusted as (
       select e.*, rr.risk_grade, rr.assumed_amount,
              exists (
                select 1
                  from jsonb_array_elements(coalesce(rr.tenants, '[]'::jsonb)) tenant
                 where coalesce((tenant->>'hasOpposition')::boolean, false)
              ) as has_opposition_tenant
         from gm_trusted_outcome_eval e
         left join latest_listing l
           on l.case_no = e.case_no
          and l.item_no = coalesce(nullif(e.item_no, ''), '1')
         left join gm_rights_analysis rr on rr.listing_id = l.listing_id
        where e.sale_date < current_date
     )
     select case_no, item_no, sale_date::text, property_type, court, address,
            appraisal_value::float8, expected_bid::float8, market_price::float8, min_bid_price::float8,
            total_score::float8, passed_filter, recommendation, true_margin::float8, max_safe_bid::float8,
            inq_cnt::float8, interest_cnt::float8,
            sold, sold_amount::float8, result_cd, matched, residual::float8, residual_pct, sale_ratio,
            would_have_won_under_max_safe_bid, realized_bid_margin,
            risk_grade, assumed_amount::float8, has_opposition_tenant
       from trusted
      order by sale_date, case_no, item_no`,
  );

  const predictionRows = await query<DbRow>(
    `with latest_listing as (
       select distinct on (case_no, coalesce(nullif(item_no, ''), '1')) *
         from gm_listings
        order by case_no, coalesce(nullif(item_no, ''), '1'), crawled_at desc nulls last, id desc
     )
     select l.case_no, coalesce(nullif(l.item_no, ''), '1') as item_no, l.sale_date::text,
            l.property_type, l.court, l.address,
            l.appraisal_value::float8, loc.expected_bid_price::float8 as expected_bid,
            loc.market_price::float8, l.min_bid_price::float8,
            s.total_score::float8, s.passed_filter,
            loc.report->>'recommendation' as recommendation,
            (loc.acquisition_cost->>'trueSafetyMargin')::float8 as true_margin,
            r.max_safe_bid::float8, l.inq_cnt::float8, l.interest_cnt::float8,
            r.risk_grade, r.assumed_amount::float8,
            exists (
              select 1
                from jsonb_array_elements(coalesce(r.tenants, '[]'::jsonb)) tenant
               where coalesce((tenant->>'hasOpposition')::boolean, false)
            ) as has_opposition_tenant
       from latest_listing l
       left join gm_location_analysis loc on loc.listing_id = l.id
       left join gm_scores s on s.listing_id = l.id
       left join gm_rights_analysis r on r.listing_id = l.id
      where l.sale_date >= current_date
        and l.sale_date <= current_date + $1::int
      order by l.sale_date, l.case_no, item_no`,
    [leadDays],
  );

  if (!predictionRows.length) {
    console.log(`[ml:shadow] D-0~D-${leadDays} 예정 매물이 없어 종료합니다`);
    return;
  }
  if (!trainingRows.length) throw new Error('신뢰 가능한 과거 결과가 없어 shadow 학습을 중단합니다');

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
    if (!predictions.length) throw new Error('shadow 모델이 예측을 생성하지 않았습니다');
    if (dryRun) {
      console.log(`[ml:shadow] dry-run: ${predictions.length}건을 DB에 저장하지 않았습니다`);
      return;
    }

    const payload = predictions.map((prediction) => ({
      case_no: prediction.case_no,
      item_no: prediction.item_no || '1',
      sale_date: prediction.sale_date,
      predicted_sale_ratio: Number(prediction.predicted_sale_ratio),
      confidence: Number(prediction.confidence),
      feature_snapshot_hash: prediction.feature_snapshot_hash,
      features: JSON.parse(prediction.features_json || '{}') as Record<string, unknown>,
    }));
    await query(
      `insert into gm_shadow_scores
         (case_no, item_no, sale_date, model_name, model_version,
          predicted_sale_ratio, confidence, feature_snapshot_hash, features)
       select p.case_no, p.item_no, p.sale_date::date, $2, $3,
              p.predicted_sale_ratio, p.confidence, p.feature_snapshot_hash, p.features
         from jsonb_to_recordset($1::jsonb) as p(
           case_no text,
           item_no text,
           sale_date text,
           predicted_sale_ratio double precision,
           confidence double precision,
           feature_snapshot_hash text,
           features jsonb
         )
       on conflict (case_no, item_no, sale_date, model_name, model_version) do update set
         predicted_sale_ratio=excluded.predicted_sale_ratio,
         confidence=excluded.confidence,
         feature_snapshot_hash=excluded.feature_snapshot_hash,
         features=excluded.features,
         created_at=now()`,
      [JSON.stringify(payload), MODEL_NAME, modelVersion],
    );
    console.log(`[ml:shadow] ${predictions.length}건 저장 완료: ${MODEL_NAME}/${modelVersion}`);
  } finally {
    for (const path of [trainPath, predictPath, outputPath]) {
      try { unlinkSync(path); } catch {}
    }
  }
}

main()
  .catch((error) => {
    console.error('ml shadow 실패:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool().end().catch(() => undefined));
