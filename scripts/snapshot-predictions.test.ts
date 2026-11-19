import { describe, expect, it } from 'vitest';

import { parseSnapshotMode } from './snapshot-predictions.ts';

describe('snapshot mode', () => {
  it('defaults to both ledgers and rejects both flags', () => {
    expect(parseSnapshotMode([])).toEqual({ predictions: true, features: true });
    expect(parseSnapshotMode(['--predictions-only'])).toEqual({ predictions: true, features: false });
    expect(parseSnapshotMode(['--features-only'])).toEqual({ predictions: false, features: true });
    expect(() => parseSnapshotMode(['--predictions-only', '--features-only'])).toThrow(/함께/);
  });
});
