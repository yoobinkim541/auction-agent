import { describe, expect, it } from 'vitest';
import { parseTelegramCommand } from './telegram-command.ts';

describe('telegram command parsing', () => {
  it('채널에서 봇 이름이 붙은 명령을 분리한다', () => {
    expect(parseTelegramCommand('/status@Auction_Agent_botbot')).toEqual({ name: '/status', arg: '' });
    expect(parseTelegramCommand('/case@Auction_Agent_botbot 2023타경111644')).toEqual({ name: '/case', arg: '2023타경111644' });
  });
});
