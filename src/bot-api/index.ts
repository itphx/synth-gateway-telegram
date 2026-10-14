export { TelegramClient, GET_UPDATES_TIMEOUT_MARGIN_MS } from './client.js';
export {
  createProxyAgent,
  requestJson,
  DEFAULT_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_ERROR,
  REQUEST_ABORTED_ERROR,
} from './transport.js';
export type { JsonRequestOptions, JsonResponse, TelegramProxyAgent } from './transport.js';
export type {
  AnswerCallbackQueryParams,
  BotApiResponse,
  ChatAction,
  DeleteMessageParams,
  EditMessageReplyMarkupParams,
  EditMessageTextParams,
  GetUpdatesParams,
  SendChatActionParams,
  SendMessageParams,
  TelegramClientOptions,
} from './client.js';

// Типы Telegram Bot API — единственный источник истины `@grammyjs/types`
// (MIT, только типы). Локальный конверт ответа `BotApiResponse` — в `client.ts`.
export type {
  CallbackQuery,
  Chat,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  Message,
  ParseMode,
  Update,
  User,
} from '@grammyjs/types';
