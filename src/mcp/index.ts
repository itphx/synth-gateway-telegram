#!/usr/bin/env node
import { TelegramClient } from '../bot-api/index.js';

import { loadConfig, type ConfigOverrides } from './config.js';
import { runMcpServer } from './server.js';

interface ParsedArgs {
  overrides: ConfigOverrides;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const overrides: ConfigOverrides = {};
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    const nextValue = (): string | undefined => inline ?? argv[(i += 1)];

    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--token': {
        const value = nextValue();
        if (value) overrides.token = value;
        break;
      }
      case '--proxy': {
        const value = nextValue();
        if (value) overrides.proxyUrl = value;
        break;
      }
      case '--chat': {
        const value = nextValue();
        if (value) overrides.defaultChatId = value;
        break;
      }
      case '--owner': {
        const value = nextValue();
        if (value) overrides.ownerChatId = value;
        break;
      }
      case '--data-dir': {
        const value = nextValue();
        if (value) overrides.dataDir = value;
        break;
      }
      default:
        break;
    }
  }

  return { overrides, help };
}

function printHelp(): void {
  console.log(
    [
      'synth-gateway-tg — MCP-сервер Telegram-шлюза Synth (stdio)',
      '',
      'Использование:',
      '  synth-gateway-tg [--token T] [--proxy URL] [--chat ID] [--owner ID] [--data-dir DIR]',
      '',
      'Инструменты MCP (неймспейс synth-gateway-telegram_*):',
      '  tg_send_message  { text, chatId?, replyToMessageId? }',
      '  tg_edit_message  { messageId, text, chatId? }',
      '  tg_delete_message{ messageId, chatId? }',
      '  tg_notify        { text }',
      '  tg_send_buttons  { text, buttons: [{ text, data }], chatId? }',
      '  tg_get_me        {}',
      '  tg_status        { chatId? }',
      '',
      'Флаги:',
      '  --token T     токен бота (env TELEGRAM_BOT_TOKEN, secrets/telegram_bot_token)',
      '  --proxy URL   прокси Bot API (env TELEGRAM_PROXY_URL, secrets/telegram_proxy_url)',
      '  --chat ID     чат по умолчанию (env GATEWAY_DEFAULT_CHAT_ID, secrets/telegram_owner_chat_id)',
      '  --owner ID    получатель tg_notify (env GATEWAY_OWNER_CHAT_ID)',
      '  --data-dir DIR каталог хранилища шлюза (env GATEWAY_DATA_DIR) для tg_status',
      '  --help, -h    эта справка',
      '',
      'Без токена сервер работает в dry-run: тулы не делают сетевых вызовов.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { overrides, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  const config = loadConfig(process.env, overrides);
  const client = new TelegramClient({
    token: config.telegram.token,
    proxyUrl: config.telegram.proxyUrl,
    ...(config.defaultChatId !== undefined ? { channelId: config.defaultChatId } : {}),
  });

  // stdout занят протоколом MCP — диагностика идёт в stderr.
  console.error(
    `[gateway-mcp] synth-gateway-tg ${config.version}: ` +
      `${client.dryRun ? 'dry-run (TELEGRAM_BOT_TOKEN не задан)' : 'реальный режим'}; ` +
      `data-dir ${config.dataDir}`,
  );

  await runMcpServer(
    {
      client,
      ...(config.defaultChatId !== undefined ? { defaultChatId: config.defaultChatId } : {}),
      ...(config.ownerChatId !== undefined ? { ownerChatId: config.ownerChatId } : {}),
      dataDir: config.dataDir,
    },
    config.version,
  );
  client.close();
}

main().catch((error: unknown) => {
  console.error('[gateway-mcp] фатальная ошибка:', error);
  process.exit(1);
});
