import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LEARN_STEPS = ['registry-opinion:backfill', 'eval:postmortem', 'ml:eval', 'ml:shadow'];

describe('daily learning batch split', () => {
  it('runs the learning steps outside the time-boxed daily parse', () => {
    const parse = readFileSync('deploy/daily-parse.sh', 'utf8');
    const learn = readFileSync('deploy/daily-learn.sh', 'utf8');
    for (const step of LEARN_STEPS) {
      expect(parse).not.toContain(`npm run ${step}`);
      expect(learn).toContain(`npm run ${step}`);
    }
  });

  it('starts the learning batch only after the parse window (06:00 KST + 4h) has closed', () => {
    const parseUnit = readFileSync('deploy/gyeongmae-parse.service', 'utf8');
    const parseTimer = readFileSync('deploy/gyeongmae-parse.timer', 'utf8');
    const learnTimer = readFileSync('deploy/gyeongmae-learn.timer', 'utf8');
    const learnUnit = readFileSync('deploy/gyeongmae-learn.service', 'utf8');

    const minutes = (text: string) => {
      const m = text.match(/OnCalendar=\*-\*-\* (\d{2}):(\d{2}):\d{2} Asia\/Seoul/);
      expect(m, text).not.toBeNull();
      return Number(m![1]) * 60 + Number(m![2]);
    };
    const parseTimeout = Number(parseUnit.match(/TimeoutStartSec=(\d+)/)![1]);
    expect(minutes(learnTimer)).toBeGreaterThan(minutes(parseTimer) + parseTimeout / 60);
    expect(learnUnit).toMatch(/^After=.*gyeongmae-parse\.service/m);
    expect(learnUnit).toContain('OnFailure=gyeongmae-alert@%n.service');
  });
});
