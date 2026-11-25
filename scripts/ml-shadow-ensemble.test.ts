import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  csvCell,
  decisionProbabilityPayload,
  parseCsv,
  pythonPath,
  readPredictionCsv,
} from './ml-shadow-ensemble.ts';

describe('ml-shadow-ensemble CSV helpers', () => {
  it('csvCell: null과 undefined를 빈 문자열로 처리한다', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('csvCell: 날짜는 YYYY-MM-DD 포맷으로 변환한다', () => {
    const d = new Date('2026-06-22T00:00:00Z');
    expect(csvCell(d)).toBe('2026-06-22');
  });

  it('csvCell: 쉼표, 줄바꿈, 따옴표가 포함된 문자열을 안전하게 이스케이프한다', () => {
    expect(csvCell('hello, world')).toBe('"hello, world"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('parseCsv: 쉼표와 따옴표로 감싸진 필드를 정확히 파싱한다', () => {
    const csv = 'col1,col2,col3\nval1,"val, 2","val ""3"""\n10,20,30\n';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['col1', 'col2', 'col3'],
      ['val1', 'val, 2', 'val "3"'],
      ['10', '20', '30'],
    ]);
  });
});

describe('pythonPath', () => {
  it('로컬 .venv-ml이 존재하면 해당 python 바이너리 경로를 반환한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'ml-shadow-'));
    try {
      mkdirSync(join(root, '.venv-ml/bin'), { recursive: true });
      writeFileSync(join(root, '.venv-ml/bin/python'), '');
      expect(pythonPath(root)).toBe(join(root, '.venv-ml/bin/python'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('로컬 .venv-ml이 없으면 python3를 반환한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'ml-shadow-'));
    try {
      expect(pythonPath(root)).toBe('python3');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ML scripts entrypoint guards', () => {
  it('scripts/ml-shadow-ensemble.ts는 import 시 main()이 자동 실행되지 않도록 진입점 가드를 갖춘다', () => {
    const source = readFileSync(new URL('./ml-shadow-ensemble.ts', import.meta.url), 'utf8');
    expect(source).toContain('if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)');
  });

  it('scripts/export-ml-dataset.ts는 import 시 main()이 자동 실행되지 않도록 진입점 가드를 갖춘다', () => {
    const source = readFileSync(new URL('./export-ml-dataset.ts', import.meta.url), 'utf8');
    expect(source).toContain('if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)');
  });
});

describe('frozen decision scoring', () => {
  const frozen = {
    court: '서울중앙지방법원',
    case_no: '2024타경1',
    item_no: '1',
    sale_date: '2026-11-20',
    horizon_days: 1,
    observed_on: '2026-11-18',
    snapshot_version: 'feature-v2',
    snapped_at: '2026-11-18T21:00:00.000Z',
    price_floor: 100,
    recommended_bid: 120,
    target_margin_pct: 0.15,
    target_margin_source: 'evaluator-default',
  };

  it('keeps identity and hash from the frozen row, not the model', () => {
    const [row] = decisionProbabilityPayload([frozen], [{
      court: '다른법원',
      case_no: '2024타경1',
      item_no: '1',
      sale_date: '2026-11-20',
      horizon_days: '1',
      probability: '0.4',
      feature_snapshot_hash: 'model-hash',
    }]);
    expect(row).toBeUndefined();
  });

  it('drops out-of-range probabilities and keeps an in-range score', () => {
    const rows = decisionProbabilityPayload(
      [frozen, { ...frozen, case_no: '2024타경2', horizon_days: 7 }],
      [
        { court: frozen.court, case_no: frozen.case_no, item_no: '1.0', sale_date: frozen.sale_date, horizon_days: '1', probability: '1.2' },
        { court: frozen.court, case_no: frozen.case_no, item_no: '1', sale_date: frozen.sale_date, horizon_days: '1', probability: ' ' },
        { court: frozen.court, case_no: '2024타경2', item_no: '1', sale_date: frozen.sale_date, horizon_days: '7', probability: '0.25' },
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.case_no).toBe('2024타경2');
    expect(rows[0]?.probability).toBe(0.25);
    expect(rows[0]?.feature_snapshot_hash).not.toBe('model-hash');
    expect(rows[0]?.snapshot_version).toBe('feature-v2');
  });
});
