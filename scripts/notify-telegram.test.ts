import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('notify-telegram.sh', () => {
  it('IPv4로 Telegram API에 연결한다', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gm-telegram-notify-'));
    const fakeCurl = join(directory, 'curl');
    const argsLog = join(directory, 'curl.args');
    await writeFile(fakeCurl, `#!/bin/sh
printf '%s\\n' "$*" > "$CURL_ARGS_LOG"
printf '{"ok":true}'
`);
    await chmod(fakeCurl, 0o755);

    try {
      await execFileAsync('/bin/bash', ['scripts/notify-telegram.sh', '테스트', '완료', '본문'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${directory}:/usr/bin:/bin`,
          CURL_ARGS_LOG: argsLog,
          GM_TELEGRAM_BOT_TOKEN: 'test-token',
          GM_TELEGRAM_CHAT_ID: '5771238245',
        },
      });
      const args = await readFile(argsLog, 'utf8');
      expect(args).toContain('-4');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
