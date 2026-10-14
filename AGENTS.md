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
   Исходящие ответы — дедуп по `stream_id`/`message:<sessionId>:<index>`
   (персистентно). Ядро на каждый ответ шлёт и `stream.done` (полный текст), и
   `message.added` (обрезанный до 500 символов контент) — `message.added`
   (assistant) доставляется только как **отложенный фоллбек** (grace 3 c): если
   за паузу пришёл `stream.done`/`stream.cancelled`, он его отменяет (защита от
   дубля «стрим + огрызок»).
   **Reply-адресат** фиксируется по прогону, а не по «последнему входящему»:
   `InboundRegistry` (per-tenant, лимит 200) связывает `dedupKey → messageId`
   (поллер при публикации) и `stream_id → messageId` (watcher по
   `message.added(user).metadata`), иначе при нескольких входящих подряд шапка
   reply уезжала бы на последнее; fallback — `SessionRoute.lastInboundMessageId`.
8. **Fail-closed список доступа.** Пользователь/чат вне allowlist → событие не
   публикуется (`normalizeUpdate` → `null`).
9. **Типы Bot API — только из `@grammyjs/types`** (единственный источник истины).
   Свои зеркала Telegram-типов не заводить; локально допустим лишь минимальный
   конверт ответа (`BotApiResponse`).
10. **Токены — не в git и не в логах.** Bot-токен, service-key, `GATEWAY_MCP_TOKEN`,
    installer-ключ живут в env/Secret/`secrets/`; в логах — только факт «задан/не
    задан». HTTP-MCP сравнивает bearer-токен в постоянном времени; hook-Job
    подставляет installer-ключ через `secretKeyRef` → `SYNTH_INSTALL_TOKEN`.
11. **Инсталлятор идемпотентен.** `scripts/install-into-synth.mjs`
    (`src/installer/install.ts`) повторным прогоном **обновляет** запись
    MCP-реестра/скилл, а не создаёт дубликаты (managed: `POST`→409→`PUT`;
    standalone: перезапись тем же содержимым); ошибка → понятное сообщение и
    exit-code ≠ 0 (режим установки проверяется до изменений). Запись реестра —
    с `enabledByDefault: true` (снять `--no-enabled-by-default`) и, при
    `--mcp-token`/`SYNTH_MCP_TOKEN`, с `config.headers.Authorization`.
12. **Коммит** — только по явной просьбе; новые зависимости — с разрешения.

## Границы

- **Недоступно** (это Extension API **плагинов**): хуки жизненного цикла,
  `ToolRegistry`, `ProviderFactory`, UI-слоты; прямой доступ к internals ядра
  (сессии в обход API, `GatewayProvider`, `FileStore` ядра).
- **Доступно:** API v2 (events + bindings, sessions, users, mcp registry, skills),
  чтение событий (SSE) — по мере надобности; MCP (stdio + Streamable HTTP).

## Структура

```text
src/gateway/   # bin synth-gateway-telegram — сервис (поллер, нормализация, ingest, watcher, health, хранилище)
│              #   markdown.ts — Markdown → Telegram-HTML (чанкинг ≤4096, балансировка тегов)
│              #   inbound.ts  — InboundRegistry: dedupKey/stream_id → messageId (reply-адресат)
src/mcp/       # bin synth-gateway-tg — MCP-сервер, тулы tg_*; скилл — skills/gateway-telegram/SKILL.md
│              #   index.ts      — CLI: stdio (по умолчанию) и --http
│              #   http.ts       — Streamable HTTP: /mcp/<tenantId>, bearer-auth, GET /health
│              #   user-lookup.ts — резолв `user` → Telegram (API v2, identities, scope users:read)
src/installer/ # install.ts — инсталлятор ресурсов (`provides`): managed (API v2) и standalone
src/bot-api/   # клиент Telegram Bot API (fetch + прокси), типы из @grammyjs/types
scripts/       # install-into-synth.mjs — обёртка инсталлятора (для hook-Job чарта) + release-хелперы
```

`tsconfig.json` — базовый (editor/`pnpm typecheck`, включает тесты); `tsconfig.build.json`
(`extends`, эмит без `*.test.ts`) — для `pnpm build`. Тесты — рядом с исходниками (`*.test.ts`).
Сборка: `pnpm build` → `dist/gateway/index.js`, `dist/mcp/index.js`, `dist/installer/install.js`.

## MCP: транспорты и авто-установка

- **stdio** (`node dist/mcp/index.js`) — локальный dev; **HTTP**
  (`--http --port 7101`) — кластер: контекст инструментов берётся из
  `tenants.json` **тенанта** (`/mcp/<tenantId>`, неизвестный → 404), токен —
  `GATEWAY_MCP_TOKEN`/`secrets/mcp_token` (нет/неверный → 401).
- **`provides` в `addon.json`** — контракт с инсталлятором: `mcp`
  (name/transport/port/`path: /mcp/{tenant}`) и `skills`
  (`{name, path}`); `{tenant}` подставляется `--tenant`.
- **Чарт** (`charts/synth-gateway-telegram`): MCP-контейнер в том же поде
  (`mcp.enabled`/`mcp.port`, порт Service, тот же Secret/PVC) и hook-Job
  `templates/install-job.yaml` (`autoInstall`, post-install/post-upgrade) с
  общим контрактом шаблона add-on'ов (`addons/synth-addon-template`);
  `autoInstall.mcp=true` требует MCP-эндпоинт (`mcp.enabled` или `autoInstall.mcpUrl`).
- **Токен MCP-клиентов.** HTTP-MCP защищён bearer-токеном, и Synth-MCP-клиент
  авторизуется им через `headers` записи реестра: чарт умеет сам создать токен
  (`mcp.tokenSecret.create=true` → Secret `<fullname>-mcp-token`, стабильный при
  `helm upgrade` через `lookup`, `resource-policy: keep`), тот же Secret читает
  контейнер `mcp` (`GATEWAY_MCP_TOKEN`) и hook-Job (`SYNTH_MCP_TOKEN`), а
  инсталлятор пишет `config.headers.Authorization` в create- и update-ветках.
- **Образ** (`docker/Dockerfile`) содержит `addon.json`, `skills/` и
  `scripts/install-into-synth.mjs` — они нужны hook-Job'у; ENTRYPOINT сервиса
  при этом не меняется.

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
| reply-адресат прогона / реестр входящих | `src/gateway/inbound.ts`, `src/gateway/watcher.ts` |
| Режимы отправки ответов (`parseMode`: plain/html/**markdown** rich) | `src/gateway/watcher.ts`, `src/bot-api/client.ts`, `docs/configuration.md` §«Режимы отправки ответов» |
| Публикация событий (API v2) | `src/gateway/ingest.ts` |
| Релиз / публикация (Docker/Helm) | `.gitverse/workflows/release.yaml`, `scripts/`, `docs/deployment.md` |
| Таймауты / прокси / клиент Bot API | `src/bot-api/transport.ts`, `src/bot-api/client.ts` |
| MCP-тулы (`tg_*`) | `src/mcp/server.ts`, `src/mcp/tools.ts` |
| MCP по HTTP (тенант-роутинг, auth) | `src/mcp/http.ts`, `src/mcp/index.ts` |
| `tg_send_to_user` / резолв пользователя Synth | `src/mcp/user-lookup.ts` |
| Авто-установка ресурсов (`provides`) | `src/installer/install.ts`, `scripts/install-into-synth.mjs`, `addon.json` |
| Чарт: MCP-контейнер, hook-Job | `charts/synth-gateway-telegram/templates/{deployment,service,install-job}.yaml`, `values.yaml` |
| Скилл агента | `skills/gateway-telegram/SKILL.md` |
