import { describe, expect, it } from 'vitest';
import { createTelegramClient, TelegramApiError } from './telegram-client.ts';

describe('telegram client', () => {
  it('외부 fetch 구현과 중단 신호를 사용해 업데이트를 조회한다', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ ok: true, result: [{ update_id: 7 }] }), {
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = createTelegramClient('secret-token', fetchImpl);
    await expect(client.getUpdates(7)).resolves.toEqual([{ update_id: 7 }]);

    expect(requestUrl).toContain('/botsecret-token/getUpdates');
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('Telegram API가 ok=false를 반환하면 전송 실패로 알린다', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error_code: 403, description: 'bot was blocked by the user' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
    const client = createTelegramClient('secret-token', fetchImpl);

    await expect(client.sendMessage('5771238245', 'hello')).rejects.toEqual(
      new TelegramApiError(403, 'bot was blocked by the user'),
    );
  });
});

describe('telegram client — 인라인 버튼', () => {
  it('reply_markup을 함께 보내고, 콜백 응답 토스트는 190자로 자른다', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: true }), { headers: { 'content-type': 'application/json' } });
    };
    const client = createTelegramClient('secret-token', fetchImpl);
    const keyboard = { inline_keyboard: [[{ text: '★', callback_data: 'fav|2024타경1' }]] };

    await client.sendMessage(1, 'hi', keyboard);
    await client.sendMessage(1, 'plain');
    await client.answerCallbackQuery('cb-1', 'x'.repeat(300));

    expect(bodies[0]!.reply_markup).toEqual(keyboard);
    expect(bodies[1]).not.toHaveProperty('reply_markup');
    expect(bodies[2]).toEqual({ callback_query_id: 'cb-1', text: 'x'.repeat(190) });
  });

  it('sendPhoto는 photo URL과 캡션, reply_markup을 포함하여 전송한다', async () => {
    const bodies: Record<string, unknown>[] = [];
    let requestUrl = '';
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createTelegramClient('secret-token', fetchImpl);
    const keyboard = { inline_keyboard: [[{ text: '★ 관심', callback_data: 'fav|1' }]] };

    const res = await client.sendPhoto('123', 'https://example.com/photo.jpg', '매물 사진', keyboard);

    expect(res).toEqual({ message_id: 10 });
    expect(requestUrl).toContain('/botsecret-token/sendPhoto');
    expect(bodies[0]).toMatchObject({
      chat_id: '123',
      photo: 'https://example.com/photo.jpg',
      caption: '매물 사진',
      reply_markup: keyboard,
    });
  });
});
