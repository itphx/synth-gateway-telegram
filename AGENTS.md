# synth-gateway-telegram — соглашения репозитория

> Короткий рабочий контракт для агентов. Назначение и поток данных — [README.md](./README.md),
> границы add-on'а — [docs/addon.md](./docs/addon.md), конфигурация —
> [docs/configuration.md](./docs/configuration.md). Язык — русский. Коммит — только
> по явной просьбе пользователя; новые зависимости — с разрешения.

## Что это

Один npm-пакет (**не** pnpm-workspace) — внешний сервис-надстройка (add-on) Synth:
Telegram-бот ↔ платформа внешних событий (`POST /api/v2/events`, AD-089).
Основание — AD-086 (внешние сервисы-надстройки) и AD-090 (Plugin ≠ Add-on ≠ Declarative).

## Инварианты (не нарушать)

1. **Add-on — не плагин.** Нет монтирования в процесс core, нет Extension API/hooks.
2. **LLM внутрь сервиса не тянем.** Понимание/генерация — движок Synth; шлюз —
   детерминированный транспорт событий.
3. **Конфиг** — приоритет CLI-флаг > env > `secrets/` > дефолт; пустая/whitespace
   строка = отсутствие значения (`envOr`).
4. **Секреты — вне git** и не в логах; логи с префиксом `[gateway]`.
5. **Хранение — JSON через `FileStore`** (атомарная запись `*.tmp.<uuid>` →
   `rename()`, AD-005).
6. **`GET /health` — без auth.**
7. **Идемпотентность.** Входные апдейты дедуплицируются (`update_id`); в
   `POST /events` передаётся стабильный `dedupKey: telegram:<bot>:<update_id>`.
   Исходящие ответы — дедуп по `stream_id`/`message_index` (персистентно).
8. **Fail-closed список доступа.** Пользователь/чат вне allowlist → событие не
   публикуется (`normalizeUpdate` → `null`).
9. **Типы Bot API — только из `@grammyjs/types`** (единственный источник истины).
   Свои зеркала Telegram-типов не заводить; локально допустим лишь минимальный
   конверт ответа (`BotApiResponse`).
10. **Коммит** — только по явной просьбе; новые зависимости — с разрешения.

## Границы

- **Недоступно** (это Extension API **плагинов**): хуки жизненного цикла,
  `ToolRegistry`, `ProviderFactory`, UI-слоты; прямой доступ к internals ядра
  (сессии в обход API, `GatewayProvider`, `FileStore` ядра).
- **Доступно:** API v2 (events + bindings, sessions), чтение событий (SSE) — по
  мере надобности; MCP (stdio).

## Структура

```text
src/gateway/   # bin synth-gateway-telegram — сервис (поллер, нормализация, ingest, watcher, health, хранилище)
src/mcp/       # bin synth-gateway-tg — MCP-сервер (stdio), тулы tg_*
src/bot-api/   # клиент Telegram Bot API (fetch + прокси), типы из @grammyjs/types
```

`tsconfig.json` — базовый (editor/`pnpm typecheck`, включает тесты); `tsconfig.build.json`
(`extends`, эмит без `*.test.ts`) — для `pnpm build`. Тесты — рядом с исходниками (`*.test.ts`).
Сборка: `pnpm build` → `dist/gateway/index.js`, `dist/mcp/index.js`.

## Релиз и публикация

Версия — единый источник истины **git-тег** `vX.Y.Z`. Перед тегом
`scripts/version-bump.sh X.Y.Z` синхронизирует `package.json`, `addon.json` и
`charts/synth-gateway-telegram/Chart.yaml` (`version` + `appVersion`). CI-пайплайн
`.gitverse/workflows/release.yaml` (триггер — тег `v*` либо ручной
`workflow_dispatch` с `dry_run`) прогоняет проверки (build/typecheck/lint/test) и
публикует: Docker `gitverse.ru/itphx/synth-gateway-telegram:<version>` (`:latest`,
kaniko), Helm-чарт в реестр `https://gitverse.ru/api/packages/itphx/helm`
(нативный Helm, не OCI), GitVerse Release.

Публикацию запускает человек (push тега / ручной запуск) — на обычные push/PR
workflow ничего не публикует. Токен — секрет `GV_TOKEN` (префикс `GITVERSE_`
запрещён). Сложный bash вынесен в `scripts/` (`${...}` в inline-bash ломает
Go-шаблон GitVerse CI).

## Куда смотреть (триггеры)

| Тема | Файл |
|---|---|
| Назначение, поток данных | `README.md`, `docs/addon.md` |
| Конфиг / секреты / мультитенантность | `docs/configuration.md`, `src/gateway/config.ts` |
| Деплой (docker/compose/K8s/Helm) | `docs/deployment.md` |
| Аутентификация Synth API (service-key/OIDC/ключ) | `src/gateway/auth.ts` |
| Нормализация `Update` → SynthEvent | `src/gateway/normalize.ts` |
| Политика неизвестного отправителя | `src/gateway/unknown-action.ts` |
| Явные команды бота | `src/gateway/commands.ts`, `command-handler.ts` |
| Обратная доставка ответов (SSE) | `src/gateway/watcher.ts` |
| Публикация событий (API v2) | `src/gateway/ingest.ts` |
| Релиз / публикация (Docker/Helm) | `.gitverse/workflows/release.yaml`, `scripts/`, `docs/deployment.md` |
| Таймауты / прокси / клиент Bot API | `src/bot-api/transport.ts`, `src/bot-api/client.ts` |
| MCP-тулы (`tg_*`) | `src/mcp/server.ts`, `src/mcp/tools.ts` |
| Скилл агента | `skills/gateway-telegram/SKILL.md` |
