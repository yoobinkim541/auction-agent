import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('courtauction scheduled coverage', () => {
  it('daily collection includes the supported Incheon courts', () => {
    const daily = readFileSync('deploy/daily-parse.sh', 'utf8');
    expect(daily).toContain('--region=서울,경기,인천');
  });

  it('24h catchup includes Incheon and Bucheon court codes', () => {
    const catchup = readFileSync('deploy/courtauction-catchup-24h.sh', 'utf8');
    expect(catchup).toMatch(/B000240/);
    expect(catchup).toMatch(/B000241/);
  });
});
