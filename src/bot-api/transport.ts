import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';

import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

/** Агент прокси, собранный по схеме URL. */
export type TelegramProxyAgent = SocksProxyAgent | HttpsProxyAgent<string>;

/** Результат JSON-запроса транспорта. */
export interface JsonResponse {
  status: number;
  headers: IncomingHttpHeaders;
  json: unknown;
}

/** Таймаут запроса по умолчанию, мс. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Маркер ошибки превышения таймаута запроса. */
export const REQUEST_TIMEOUT_ERROR = 'telegram.request_timeout';

/** Маркер ошибки прерывания запроса по внешнему сигналу. */
export const REQUEST_ABORTED_ERROR = 'telegram.request_aborted';

/** Опции {@link requestJson}. */
export interface JsonRequestOptions {
  /** HTTP-метод, по умолчанию `POST`. */
  method?: string;
  /** Заголовки запроса. */
  headers?: Record<string, string>;
  /** Тело запроса (строка). */
  body?: string;
  /** URL прокси; пустая строка/undefined — прямой запрос через fetch. */
  proxyUrl?: string;
  /**
   * Готовый агент прокси для переиспользования между запросами. Имеет приоритет
   * над `proxyUrl`; владелец жизненного цикла — вызывающий (внешний агент
   * транспортом не уничтожается). Клиент (`TelegramClient`) создаёт агент один
   * раз и передаёт его сюда — keep-alive/CONNECT-туннели не рвутся.
   */
  agent?: TelegramProxyAgent;
  /** Реализация fetch для прямого пути (для тестов). */
  fetchImpl?: typeof fetch;
  /**
   * Таймаут запроса, мс (по умолчанию {@link DEFAULT_REQUEST_TIMEOUT_MS}).
   * `0`/отрицательное — без таймаута (не рекомендуется). По истечении запрос
   * прерывается (`AbortController`/`req.destroy`) с ошибкой
   * {@link REQUEST_TIMEOUT_ERROR}.
   */
  timeoutMs?: number;
  /** Внешний сигнал прерывания (например, остановка поллера). */
  signal?: AbortSignal;
}

const SOCKS_SCHEMES = new Set(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']);
const HTTP_SCHEMES = new Set(['http', 'https']);

/**
 * Собирает агент прокси по схеме URL:
 * - `socks://`, `socks4://`, `socks4a://`, `socks5://`, `socks5h://` → `SocksProxyAgent`
 *   (для `socks5h`/`socks4a`/`socks` DNS резолвится на стороне прокси);
 * - `http://`, `https://` → `HttpsProxyAgent` (туннель через CONNECT).
 *
 * Неизвестная схема — ошибка `telegram.proxy_unsupported_scheme`.
 */
export function createProxyAgent(proxyUrl: string): TelegramProxyAgent {
  const url = proxyUrl.trim();
  const scheme = /^([a-z0-9+.-]+):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (scheme && SOCKS_SCHEMES.has(scheme)) {
    return new SocksProxyAgent(url);
  }
  if (scheme && HTTP_SCHEMES.has(scheme)) {
    return new HttpsProxyAgent(url);
  }
  throw new Error(`telegram.proxy_unsupported_scheme: ${scheme ?? url}`);
}

/**
 * Выполняет JSON-запрос к Telegram Bot API.
 *
 * Без прокси (пустой `proxyUrl`) запрос идёт через `fetchImpl`
 * (`globalThis.fetch` по умолчанию) — прежнее поведение клиента. С прокси —
 * через `node:https`/`node:http` с агентом выбранной схемы, что возвращает
 * `{ status, headers, json }`.
 *
 * Невалидный JSON в ответе — ошибка `telegram.invalid_json` с текстом ответа.
 */
export async function requestJson(
  url: string,
  options: JsonRequestOptions = {},
): Promise<JsonResponse> {
  if (options.agent) {
    return requestJsonWithAgent(url, options.agent, options);
  }
  const proxyUrl = options.proxyUrl?.trim();
  if (!proxyUrl) {
    return requestJsonWithFetch(url, options);
  }
  // Прямой вызов транспорта без готового агента (например, из тестов):
  // создаём агент на запрос и освобождаем после завершения, чтобы не оставлять
  // открытые keep-alive соединения. Клиент (`TelegramClient`) создаёт агент
  // один раз на конфигурацию и передаёт готовым через `options.agent`.
  const agent = createProxyAgent(proxyUrl);
  try {
    return await requestJsonWithAgent(url, agent, options);
  } finally {
    try {
      agent.destroy();
    } catch {
      /* noop */
    }
  }
}

async function requestJsonWithFetch(
  url: string,
  options: JsonRequestOptions,
): Promise<JsonResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const external = options.signal;
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    if (timeoutMs <= 0) return;
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(REQUEST_TIMEOUT_ERROR));
    }, timeoutMs);
  });

  try {
    const work = (async (): Promise<JsonResponse> => {
      const response = await fetchImpl(url, {
        method: options.method ?? 'POST',
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        json: parseJson(text, `HTTP ${response.status}`),
      };
    })();
    return await Promise.race([work, timeout]);
  } catch (error) {
    const method = options.method ?? 'POST';
    // Таймаут уже отдал понятную ошибку; внешний abort маппим отдельно.
    if (external?.aborted && !(error instanceof Error && error.message === REQUEST_TIMEOUT_ERROR)) {
      throw enrichNetworkError(new Error(REQUEST_ABORTED_ERROR), url, method, false);
    }
    throw enrichNetworkError(error, url, method, false);
  } finally {
    if (timer) clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

function requestJsonWithAgent(
  url: string,
  agent: TelegramProxyAgent,
  options: JsonRequestOptions,
): Promise<JsonResponse> {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const external = options.signal;
  const requestOptions: RequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: options.method ?? 'POST',
    headers: options.headers,
    agent,
  };

  // `req.setTimeout`/`req.destroy` не срабатывают, пока агент прокси устанавливает
  // CONNECT-туннель (сокет ещё не привязан к запросу). Поэтому дополнительно
  // гоним запрос через `Promise.race` с таймаутом/внешним abort — гарантированно
  // завершаем с понятной ошибкой, а destroy — best-effort очистка.
  let destroy: (() => void) | undefined;
  let settled = false;
  const work = new Promise<JsonResponse>((resolve, reject) => {
    const request = requestFn(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            json: parseJson(text, `HTTP ${response.statusCode ?? 0}`),
          });
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    destroy = () => {
      try {
        request.destroy();
      } catch {
        /* уже уничтожен */
      }
      // Агент не уничтожаем: он общий для конфигурации (владелец — вызывающий).
    };
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cleanup = (): void => {
    if (timer) clearTimeout(timer);
    if (external && onAbort) external.removeEventListener('abort', onAbort);
  };

  const timeout = new Promise<never>((_resolve, reject) => {
    if (timeoutMs <= 0) return;
    timer = setTimeout(() => {
      destroy?.();
      reject(new Error(REQUEST_TIMEOUT_ERROR));
    }, timeoutMs);
  });

  const aborted = new Promise<never>((_resolve, reject) => {
    if (!external) return;
    onAbort = () => {
      destroy?.();
      reject(new Error(REQUEST_ABORTED_ERROR));
    };
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  });

  return Promise.race([work, timeout, aborted])
    .catch((error: unknown) => {
      throw enrichNetworkError(error, url, options.method ?? 'POST', true);
    })
    .finally(() => {
      cleanup();
      if (!settled) destroy?.();
    });
}

/**
 * Убирает токен бота из URL для безопасного логирования: `/bot<token>/…` →
 * `/bot<redacted>/…`. Токены/секреты в сообщения об ошибках не попадают.
 */
function sanitizeTelegramUrl(url: string): string {
  return url.replace(/\/bot[^/]+/i, '/bot<redacted>');
}

/**
 * Дополняет сетевую ошибку контекстом: HTTP-метод, целевой URL без токена и
 * признак прокси. Прокси-URL (может содержать креды) и токен не включаются —
 * только флаг `proxy=true|false`.
 */
function enrichNetworkError(
  error: unknown,
  url: string,
  method: string,
  viaProxy: boolean,
): Error {
  const base = error instanceof Error ? error.message : String(error);
  const context = `[${method} ${sanitizeTelegramUrl(url)} proxy=${viaProxy ? 'true' : 'false'}]`;
  return new Error(`${base} ${context}`);
}

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`telegram.invalid_json (${context}): ${text.slice(0, 500)}`);
  }
}
