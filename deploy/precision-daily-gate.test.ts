import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const worktree = new URL('..', import.meta.url).pathname;

interface FixtureOptions {
  analyzeExit?: number;
  auditExit?: number;
  precisionExit?: number;
  trustExit?: number;
}

function fixture(options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'precision-daily-gate-'));
  const bash = join(directory, 'bash');
  const calls = join(directory, 'calls.log');
  const notify = join(directory, 'notify.sh');
  const notifyLog = join(directory, 'notify.log');
  const npm = join(directory, 'npm');
  const pwdLog = join(directory, 'pwd.log');

  writeFileSync(calls, '');
  writeFileSync(notifyLog, '');
  writeFileSync(pwdLog, '');
  writeFileSync(bash, `#!/bin/bash
if [ "$1" = "scripts/notify-telegram.sh" ]; then
  printf '%s\\n' "$*" >> "$NOTIFY_LOG"
  exit 0
fi
exec /bin/bash "$@"
`);
  writeFileSync(npm, `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS_LOG"
printf '%s\\n' "$PWD" >> "$PWD_LOG"
case "$*" in
  "run analyze -- --all") exit \${ANALYZE_EXIT:-0} ;;
  "run trust:backfill -- "*) exit \${TRUST_EXIT:-0} ;;
  "run precision:backfill -- "*) exit \${PRECISION_EXIT:-0} ;;
  "run --silent precision:audit")
    if [ "\${AUDIT_EXIT:-0}" = 0 ]; then printf '%s\\n' '{"ok":true}'; else printf '%s\\n' '{"ok":false}'; fi
    exit \${AUDIT_EXIT:-0}
    ;;
  "run --silent digest") printf '%s\\n' 'precision digest' ;;
  "run --silent eval:report -- --summary") printf '%s\\n' 'evaluation summary' ;;
esac
exit 0
`);
  writeFileSync(notify, '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$NOTIFY_LOG"\n');
  chmodSync(bash, 0o755);
  chmodSync(npm, 0o755);
  chmodSync(notify, 0o755);

  return { calls, directory, notify, notifyLog, npm, options, pwdLog };
}

function environment(testFixture: ReturnType<typeof fixture>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANALYZE_EXIT: String(testFixture.options.analyzeExit ?? 0),
    AUDIT_EXIT: String(testFixture.options.auditExit ?? 0),
    'BASH_FUNC_npm%%': '() { "$FAKE_NPM" "$@"; }',
    CALLS_LOG: testFixture.calls,
    FAKE_NPM: testFixture.npm,
    NOTIFY: testFixture.notify,
    NOTIFY_LOG: testFixture.notifyLog,
    PATH: `${testFixture.directory}:${process.env.PATH ?? ''}`,
    PRECISION_BACKFILL_LIMIT: '125',
    PRECISION_EXIT: String(testFixture.options.precisionExit ?? 0),
    PRECISION_TRUST_BACKFILL_LIMIT: '250',
    PWD_LOG: testFixture.pwdLog,
    TRUST_EXIT: String(testFixture.options.trustExit ?? 0),
  };
}

function runGate(options: FixtureOptions = {}) {
  const testFixture = fixture(options);
  const result = spawnSync('/bin/bash', ['-c', `
    source deploy/precision-daily-gate.sh
    run_precision_refresh_and_audit
  `], {
    cwd: worktree,
    encoding: 'utf8',
    env: environment(testFixture),
  });
  const calls = readFileSync(testFixture.calls, 'utf8').trim().split('\n');
  return { ...testFixture, ...result, calls };
}

describe('precision daily safety gate', () => {
  it('runs bounded trust and precision refreshes before the audit', () => {
    const result = runGate();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).toEqual([
      'run trust:backfill -- --limit=250 --since-days=2',
      'run precision:backfill -- --limit=125 --since-days=2',
      'run --silent precision:audit',
    ]);
  });

  it('returns failure and uses Telegram notification when the audit fails', () => {
    const result = runGate({ auditExit: 1 });

    expect(result.status).toBe(1);
    expect(readFileSync(result.notifyLog, 'utf8')).toContain('정밀 추천 감사 실패');
  });

  it.each([
    ['trust', { trustExit: 2 }],
    ['precision', { precisionExit: 3 }],
  ] as const)('closes the gate and notifies when %s refresh fails', (_phase, options) => {
    const result = runGate(options);

    expect(result.status).toBe(1);
    expect(readFileSync(result.notifyLog, 'utf8')).toContain('정밀 추천 감사 실패');
  });

  it('does not run the precision digest when the gate is closed', () => {
    const testFixture = fixture();
    const result = spawnSync('/bin/bash', ['-c', `
      source deploy/precision-daily-gate.sh
      run_precision_digest 0 "legacy evaluation stays available"
    `], {
      cwd: worktree,
      encoding: 'utf8',
      env: environment(testFixture),
    });

    expect(result.status).toBe(0);
    expect(readFileSync(testFixture.calls, 'utf8')).not.toContain('digest');
  });

  it('does not invoke digest or notify when the precision digest flag is disabled', () => {
    const testFixture = fixture();
    const result = spawnSync('/bin/bash', ['-c', `
      source deploy/precision-daily-gate.sh
      run_precision_digest 1 "evaluation remains available"
    `], {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...environment(testFixture), PRECISION_DIGEST_ENABLED: '0' },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(testFixture.calls, 'utf8')).not.toContain('digest');
    expect(readFileSync(testFixture.notifyLog, 'utf8')).toBe('');
  });

  it.each([
    ['successful', {}],
    ['failed', { auditExit: 1 }],
  ] as const)('preserves analyze failure after %s precision steps in the real daily script', (_label, options) => {
    const testFixture = fixture({ analyzeExit: 7, ...options });
    const project = join(testFixture.directory, 'project');
    const deploy = join(project, 'deploy');
    const scripts = join(project, 'scripts');
    const realDailyScript = join(worktree, 'deploy/daily-parse.sh');

    mkdirSync(deploy, { recursive: true });
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(deploy, 'precision-daily-gate.sh'), readFileSync(join(worktree, 'deploy/precision-daily-gate.sh')));
    writeFileSync(join(scripts, 'notify-telegram.sh'), '#!/bin/bash\nexit 0\n');

    const result = spawnSync('/bin/bash', [realDailyScript], {
      cwd: worktree,
      encoding: 'utf8',
      env: {
        ...environment(testFixture),
        GYEONGMAE_PROJECT_DIR: project,
        HOME: testFixture.directory,
      },
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(7);
    expect(new Set(readFileSync(testFixture.pwdLog, 'utf8').trim().split('\n'))).toEqual(new Set([project]));
  });
});
