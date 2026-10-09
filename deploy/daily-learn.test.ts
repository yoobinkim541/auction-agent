import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LEARN_STEPS = ['retry:outcomes', 'registry-opinion:backfill', 'eval:postmortem', 'ml:eval', 'ml:shadow'];

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

  it('gives the outcome retry a generous budget that still fits the learning unit timeout', () => {
    const learn = readFileSync('deploy/daily-learn.sh', 'utf8');
    const learnUnit = readFileSync('deploy/gyeongmae-learn.service', 'utf8');
    const budgetMs = Number(learn.match(/OUTCOME_RETRY_TIME_BUDGET_MS:-(\d+)/)![1]);
    const timeoutSec = Number(learnUnit.match(/TimeoutStartSec=(\d+)/)![1]);
    expect(budgetMs).toBeGreaterThanOrEqual(90 * 60_000); // 400건 × 약 11초 ≈ 75분
    expect(timeoutSec * 1000).toBeGreaterThanOrEqual(budgetMs + 60 * 60_000); // 나머지 학습 단계 여유 1시간
    // 사진 보강(12:37 KST)과 법원 사이트를 동시에 치지 않도록 재수집이 학습 배치의 첫 단계다
    expect(learn.indexOf('npm run retry:outcomes')).toBeLessThan(learn.indexOf('npm run registry-opinion:backfill'));
  });
});
