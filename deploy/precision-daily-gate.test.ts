import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const worktree = new URL('..', import.meta.url).pathname;

function fixture(auditExit: number) {
  const directory = mkdtempSync(join(tmpdir(), 'precision-daily-gate-'));
  const calls = join(directory, 'calls.log');
  const notify = join(directory, 'notify.sh');
  const npm = join(directory, 'npm');

  writeFileSync(calls, '');
  writeFileSync(npm, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$CALLS_LOG"\nif [ "$*" = "run --silent precision:audit" ]; then\n  printf '%s\\n' '{"ok":${auditExit === 0 ? 'true' : 'false'}}'\n  exit ${auditExit}\nfi\n`);
  writeFileSync(notify, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$NOTIFY_LOG"\n');
  chmodSync(npm, 0o755);
  chmodSync(notify, 0o755);

  return { directory, calls, notify, npm };
}

function runGate(auditExit: number) {
  const testFixture = fixture(auditExit);
  const result = spawnSync('bash', ['-c', `
    source deploy/precision-daily-gate.sh
    run_precision_refresh_and_audit
  `], {
    cwd: worktree,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${testFixture.directory}:${process.env.PATH ?? ''}`,
      CALLS_LOG: testFixture.calls,
      NOTIFY_LOG: join(testFixture.directory, 'notify.log'),
      NOTIFY: testFixture.notify,
      PRECISION_TRUST_BACKFILL_LIMIT: '250',
      PRECISION_BACKFILL_LIMIT: '125',
    },
  });
  const calls = readFileSync(testFixture.calls, 'utf8').trim().split('\n');
  const notifyLog = join(testFixture.directory, 'notify.log');
  return { ...testFixture, ...result, calls, notifyLog };
}

describe('precision daily safety gate', () => {
  it('runs bounded trust and precision refreshes before the audit', () => {
    const result = runGate(0);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).toEqual([
      'run trust:backfill -- --limit=250 --since-days=2',
      'run precision:backfill -- --limit=125 --since-days=2',
      'run --silent precision:audit',
    ]);
  });

  it('returns failure and uses Telegram notification when the audit fails', () => {
    const result = runGate(1);

    expect(result.status).toBe(1);
    expect(readFileSync(result.notifyLog, 'utf8')).toContain('정밀 추천 감사 실패');
  });

  it('does not run the precision digest when the gate is closed', () => {
    const testFixture = fixture(0);
    const result = spawnSync('bash', ['-c', `
      source deploy/precision-daily-gate.sh
      run_precision_digest 0 "legacy evaluation stays available"
    `], {
      cwd: worktree,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${testFixture.directory}:${process.env.PATH ?? ''}`,
        CALLS_LOG: testFixture.calls,
        NOTIFY_LOG: join(testFixture.directory, 'notify.log'),
        NOTIFY: testFixture.notify,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(testFixture.calls, 'utf8')).not.toContain('digest');
  });
});
