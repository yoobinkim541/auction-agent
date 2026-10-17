import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  csvCell,
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
    const py = pythonPath();
    expect(py).toContain('.venv-ml/bin/python');
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
