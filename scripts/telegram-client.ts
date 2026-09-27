import { Agent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';

const TELEGRAM_TIMEOUT_MS = 15_000;

setGlobalDispatcher(new Agent({
  connect: { family: 4, timeout: TELEGRAM_TIMEOUT_MS },
  headersTimeout: TELEGRAM_TIMEOUT_MS,
  bodyTimeout: TELEGRAM_TIMEOUT_MS,
}));

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type FetchImpl = (input: string, init?: FetchInit) => Promise<FetchResponse>;

const defaultFetch = undiciFetch as unknown as FetchImpl;

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramChatMessage;
  channel_post?: TelegramChatMessage;
};

export type TelegramChatMessage = { chat: { id: number }; text?: string };

export type TelegramMessage = { message_id: number };

export class TelegramApiError extends Error {
  constructor(readonly errorCode: number, description: string) {
    super(`Telegram API ${errorCode}: ${description}`);
    this.name = 'TelegramApiError';
  }
}

export function createTelegramClient(token: string, fetchImpl: FetchImpl = defaultFetch): {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string | number, text: string): Promise<TelegramMessage>;
} {
  const api = `https://api.telegram.org/bot${token}`;

  async function request<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl(`${api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    const payload = await response.json() as TelegramResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new TelegramApiError(payload.error_code ?? response.status, payload.description ?? `HTTP ${response.status}`);
    }
    return payload.result as T;
  }

  return {
    getUpdates: (offset) => request<TelegramUpdate[]>('getUpdates', { offset, timeout: 0 }),
    sendMessage: (chatId, text) => request<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 3900),
      disable_web_page_preview: true,
    }),
  };
}
