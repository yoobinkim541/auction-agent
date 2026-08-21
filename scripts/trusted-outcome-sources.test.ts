import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('trusted outcome metric sources', () => {
  it('uses trusted outcomes for model and error metrics while retaining raw coverage', () => {
    const evalSource = source('./eval-report.ts');
    const exportSource = source('./export-ml-dataset.ts');
    const serviceSource = source('../server/src/main/java/com/gyeongmae/service/ListingService.java');

    expect(evalSource).toContain('from gm_trusted_outcome_eval');
    expect(evalSource).toContain('from gm_outcome_eval');
    expect(exportSource).toContain('from gm_trusted_outcome_eval');
    expect(exportSource).not.toContain('gm_rights_risk_eval');
    expect(serviceSource).toContain('gm_trusted_outcome_eval');
    expect(serviceSource).toContain('gm_outcome_eval');
  });
});
