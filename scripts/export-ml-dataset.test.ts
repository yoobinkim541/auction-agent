import { describe, expect, it } from 'vitest';
import { exportSelection } from './export-ml-dataset.ts';

describe('ml export selection', () => {
  it('writes both CSVs by default and can emit the frozen file alone', () => {
    expect(exportSelection([])).toMatchObject({
      exploratory: true,
      frozen: true,
      exploratoryPath: 'artifacts/ml/outcome_eval.csv',
      frozenPath: 'artifacts/ml/frozen_decisions.csv',
    });
    expect(exportSelection(['--frozen-only', '--frozen-out=custom.csv']).exploratory).toBe(false);
    expect(exportSelection(['--frozen-only', '--frozen-out=custom.csv']).frozenPath).toBe('custom.csv');
  });
});
