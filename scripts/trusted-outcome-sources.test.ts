import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const viewDefinition = (sql: string, viewName: string): string => {
  const start = sql.indexOf(`create or replace view ${viewName} as`);
  const end = sql.indexOf('create or replace view ', start + 1);
  return sql.slice(start, end === -1 ? undefined : end);
};

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

  it('defines calibration and model replay views from trusted outcomes', () => {
    const operationalMigration = source('../db/migrate_phase2_operational_views.sql');
    const trustMigration = source('../db/migrate_precision_data_trust.sql');
    const schema = source('../db/schema.sql');

    expect(viewDefinition(operationalMigration, 'gm_ml_price_calibration')).toContain('from gm_trusted_outcome_eval');
    expect(viewDefinition(operationalMigration, 'gm_rights_risk_eval')).toContain('from gm_trusted_outcome_eval');
    expect(viewDefinition(trustMigration, 'gm_ml_price_calibration')).toContain('from gm_trusted_outcome_eval');
    expect(viewDefinition(schema, 'gm_ml_price_calibration')).toContain('from gm_trusted_outcome_eval');
    expect(viewDefinition(schema, 'gm_rights_risk_eval')).toContain('from gm_trusted_outcome_eval');
    expect(viewDefinition(schema, 'gm_shadow_score_eval')).toContain('gm_trusted_outcome_eval');
  });
});
