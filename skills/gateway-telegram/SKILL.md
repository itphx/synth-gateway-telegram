---
name: gateway-telegram
description: Уведомления и сообщения в Telegram через Telegram-шлюз Synth (add-on synth-gateway-telegram). Используй, когда нужно уведомить владельца, отправить/поправить/удалить сообщение в чате или показать inline-кнопки; а также при работе с входящими Telegram-событиями (source telegram).
---

# gateway-telegram — мост в Telegram

Рабочая инструкция агенту **opencode**. Ты вызываешь **MCP-тулы** сервиса
`synth-gateway-telegram` — он делает детерминированную работу (отправка/правка/
удаление, `getMe`, состояние). LLM внутрь сервиса не тянется.

## Когда использовать

- **Уведомить владельца** о значимом событии (завершён релиз, готов черновик,
  нужен ответ) — `tg_notify`.
- **Отправить сообщение** в конкретный чат/канал — `tg_send_message`.
- **Поправить/удалить** ранее отправленное шлюзом сообщение — `tg_edit_message`,
  `tg_delete_message`.
- **Показать варианты** (согласовать/выбрать) — `tg_send_buttons` с inline-кнопками.
- **Проверить подключение** бота — `tg_get_me`.
- **Узнать привязку** чата к сессии Synth — `tg_status`.

## Инструменты MCP

Неймспейс в Synth: `synth-gateway-telegram_<tool>`.

| Тул | Параметры | Назначение |
|---|---|---|
| `tg_send_message` | `text`, `chatId?`, `replyToMessageId?` | Отправить сообщение (chatId по умолчанию — `GATEWAY_DEFAULT_CHAT_ID`) |
| `tg_edit_message` | `messageId`, `text`, `chatId?` | Изменить текст ранее отправленного сообщения |
| `tg_delete_message` | `messageId`, `chatId?` | Удалить сообщение |
| `tg_notify` | `text` | Уведомление владельцу с маркером «🔔» |
| `tg_send_buttons` | `text`, `buttons: [{ text, data }]`, `chatId?` | Inline-клавиатура: `data` → `callback_data` (≤64 байта) |
| `tg_get_me` | — | `getMe` — проверка бота |
| `tg_status` | `chatId?` | Best-effort привязка чата/сессии из `GATEWAY_DATA_DIR` |

## Входящие сообщения и внешние события

Входящие сообщения бота обрабатывает не MCP, а сервис `src/gateway`:
long-polling Telegram → нормализация → **`POST /api/v2/events`** с
`source: 'telegram'` (AD-089). Команды (например, `/synth`, `/idea`) приходят
событием `type: 'command'` и меткой `payload.label`. Привязки чатов к сессиям —
`GET/POST/DELETE /api/v2/events/bindings`. Ответы агента доставляются обратно в
чат через SSE и `sendMessage`.

## Границы

- **Не спамить**: `tg_notify` — только по значимым событиям, а не на каждый шаг.
- **Без токена — dry-run**: тулы не делают сетевых вызовов и возвращают
  `{dryRun: true}`. Проверяй `tg_get_me` перед боевыми сообщениями.
- **Секреты — вне git** (`secrets/`): токен бота, прокси, чат владельца.
- Не дублировать транспорт: сообщения шлём только этими тулами, не поднимая свой
  Bot API-клиент и не читая JSON-хранилище шлюза на запись.

## Запуск (dev)

```bash
# из корня репозитория add-on'а
pnpm build
node dist/mcp/index.js --help
# MCP-сервер synth-gateway-telegram подключается к Synth
```
