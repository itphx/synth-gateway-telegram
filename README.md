# synth-gateway-telegram

**Telegram-шлюз** — внешний сервис-надстройка (**add-on**) агентной платформы
[Synth](https://gitverse.ru/itphx/synth): мост между Telegram-ботом и платформой
внешних событий (AD-089). Шлюз принимает апдейты бота (long-polling), нормализует
их во внешние события Synth и публикует в `POST /api/v2/events`, а ответы агента
доставляет обратно в чат через SSE.

## Что это и чем НЕ является

- ✅ **Add-on** — внешний сервис со своим репозиторием, образами и деплоем;
  общается с Synth только по публичным контрактам (API v2, MCP, внешние события).
- ❌ **Не плагин**: не монтируется в процесс ядра, точек расширения Extension API
  не имеет (AD-090). Терминология жёсткая — Plugin ≠ Add-on ≠ Declarative.
- ❌ **LLM внутрь сервиса не тянется**: понимание и генерацию делает движок Synth,
  шлюз лишь детерминированно транспортирует события.

Основания и границы — [docs/addon.md](docs/addon.md).

## Поток данных

```text
Telegram Bot API                 synth-gateway-telegram                    Synth API v2
   getUpdates  ──long-polling──▶  poller ──normalize──▶ SynthEventsClient ──▶ POST /events
                                  │   └─ /help /bind … ──▶ ответ в чат           │
                                  │                            Event/Binding/Router ядра
                                  │      SSE GET /events ◀── session events      │
                                  └◀── watcher ── stream.chunk/done/cancelled ──┘
                                          └──▶ «Печатает…» + стриминг ответа в чат
                                  └── offset / seen / chatSessions / routes / sent ── FileStore
```

Режим отправки ответов — `parseMode` (`plain` \| `html` \| `markdown`). `markdown`
использует Bot API 10.1 «Rich Messages»: нативные таблицы/заголовки/списки и
стриминг ответа черновиком в приватных чатах; детали и фоллбеки —
[docs/configuration.md](docs/configuration.md) §«Режимы отправки ответов».

Возможности доставки ответов (кратко):

- **Стриминг** — ответ агента появляется и правится прямо в чате (live-сообщение;
  в `markdown` — эфемерным rich-черновиком, только приватные чаты).
- **«Печатает…»** — статус `typing` сразу и каждые 4 c, пока стрим активен
  (watchdog простоя 60 c гасит индикатор).
- **`/stop`** — прерывает активный ответ агента в сессии чата
  (`POST /sessions/:id/abort`); ответ помечается «⏹ Остановлено».
- **Rich-таблицы** — `parseMode: markdown` рендерит нативные таблицы Bot API 10.1;
  штатный `parse_mode: Markdown`/`MarkdownV2` таблиц **не** умеет (нужен rich).
- **Reply на источник** — ответ приходит reply-ем на то сообщение, на которое
  отвечает агент, а не на последнее входящее (даже если во время генерации пришли
  новые сообщения).

## MCP для агента

Шлюз отдаёт агенту тулы `tg_*` (отправка/правка/удаление, `tg_notify`,
`tg_send_buttons`, `tg_get_me`, `tg_status` и **`tg_send_to_user`** — сообщение
конкретному пользователю Synth по `user`/`principalId`/`chatId`).

Два транспорта:

| Транспорт | Когда | Запуск |
|---|---|---|
| **stdio** (bin `synth-gateway-tg`) | локальный dev, движок спавнит процесс | `node dist/mcp/index.js` |
| **Streamable HTTP** (`--http`) | кластер/K3s (движок не спавнит процесс add-on'а) | `node dist/mcp/index.js --http --port 7101` |

HTTP-режим: путь `/mcp/<tenantId>` (тенанты — из `tenants.json`, неизвестный →
404), `GET /health` без auth, остальное — `Authorization: Bearer
<GATEWAY_MCP_TOKEN>` (секрет из env/`secrets/mcp_token`). В Helm-чарте это второй
контейнер того же пода (порт 7101) — см. [docs/deployment.md](docs/deployment.md).

## Авто-установка MCP и скиллов

`addon.json` описывает секцию **`provides`** (MCP-сервер + скиллы), а
`scripts/install-into-synth.mjs` **идемпотентно** регистрирует их в инстансе:
managed — через API v2 (`/mcp/registry`, `/skills*`), standalone — merge
`mcp.servers` в `config.yaml` + копирование скиллов в `{dataDir}/skills`.
В кластере это делает hook-Job чарта (`autoInstall`, `post-install,post-upgrade`),
токен — из Secret и в логи не попадает; чарт умеет сам создать токен MCP-клиентов
(`mcp.tokenSecret.create=true`, стабильный при `helm upgrade`) и пробрасывает его
в запись реестра как `Authorization: Bearer …` (иначе MCP-клиент Synth получит 401).

```bash
# план установки (изменений нет)
node scripts/install-into-synth.mjs --synth-url http://127.0.0.1:5000/api/v2 \
  --token "$SYNTH_INSTALL_TOKEN" --mcp-token "$SYNTH_MCP_TOKEN" \
  --tenant dev --service-host 127.0.0.1 --dry-run
```

Контракт `provides`, три вида аддонов и HTTP-MCP — [docs/addon.md](docs/addon.md);
values, Secret и проверка — [docs/deployment.md](docs/deployment.md) §«Авто-установка
MCP и скиллов».

## Быстрый старт

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test

# Демон: health-сервер + long-polling + watcher ответов агента
node dist/gateway/index.js

# Dry-run без токена (один проход getUpdates, сетевых вызовов нет)
node dist/gateway/index.js --dry-run --once

curl -s http://127.0.0.1:7100/health

# MCP-сервер (stdio) для агента
node dist/mcp/index.js --help
```

Docker / docker compose:

```bash
cp .env.example .env && docker compose up --build
```

Полный справочник конфигурации (переменные, CLI-флаги, секреты, режимы
аутентификации, прокси, CA, мультитенантность) — **[docs/configuration.md](docs/configuration.md)**.

## Аутентификация Synth API

Приоритет (`src/gateway/auth.ts`): **service-key → OIDC → api-key → без auth**.

- **Scoped service-key (рекомендуется).** `SYNTH_SERVICE_KEY` (`synth_svc_…`,
  AD-052) — машинная аутентификация, ограниченная `scopes` и проекцией
  `allowedProjects`. Минимум для сквозного контура (приём событий + обратная
  доставка watch-all SSE): scopes `events:ingest`, `events:watch`; роль —
  `LEAD` (для команд `/bind`). Backend даёт watch-all самому service-key по
  scope `events:watch` — админ-права не нужны.
- **OIDC (fallback).** `SYNTH_OIDC_*` (client-credentials) работает, но для
  обратной доставки (watch-all SSE `GET /events`) требует, чтобы
  service-account клиента шлюза в Keycloak имел **realm-роль** `lead`/`admin`:
  backend читает realm-роли, а client-роли клиента — нет.
- **Legacy.** `SYNTH_API_KEY` — standalone/dev, если service-key и OIDC не заданы.

Детали и примеры — [docs/configuration.md](docs/configuration.md) §«Аутентификация Synth API».

## Структура

```text
synth-gateway-telegram/
├── addon.json       # манифест add-on'а (kind/host/contracts) + `provides` (mcp, skills)
├── src/
│   ├── gateway/     # сервис synth-gateway-telegram (bin): поллер, нормализация, ingest, watcher, health
│   │                #   markdown.ts — Markdown → Telegram-HTML; inbound.ts — InboundRegistry (reply-адресат)
│   ├── mcp/         # MCP-сервер synth-gateway-tg (bin): stdio и HTTP (http.ts)
│   │                #   http.ts — Streamable HTTP, /mcp/<tenant>, bearer-auth; user-lookup.ts — tg_send_to_user
│   ├── installer/   # install.ts — логика инсталлятора ресурсов (managed/standalone, идемпотентно)
│   └── bot-api/     # клиент Telegram Bot API (fetch + прокси)
├── scripts/         # install-into-synth.mjs (обёртка инсталлятора) + release-хелперы
├── charts/synth-gateway-telegram/    # Helm-чарт (MCP-контейнер, hook-Job авто-установки)
├── docker/ · docker-compose.yml · .env.example
├── examples/        # примеры Secret (сервис, installer-ключ) и tenants.json
├── docs/            # configuration.md · deployment.md · addon.md
├── skills/gateway-telegram/SKILL.md  # скилл AD-046 для агента
└── .gitverse/workflows/  # ci.yaml (push/PR) · release.yaml (Docker + Helm + Release по тегу v*)
```

## Команды

| Команда | Действие |
|---|---|
| `pnpm build` | сборка (`tsc` → `dist/`) |
| `pnpm typecheck` | проверка типов |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
| `pnpm clean` | очистка `dist/` |

## Развёртывание

- Docker / compose / Kubernetes / Helm — [docs/deployment.md](docs/deployment.md).
- Публикуемый Helm-чарт — `charts/synth-gateway-telegram`.
- Опубликованные артефакты (по тегу `v*`): образ
  `gitverse.ru/itphx/synth-gateway-telegram:<version>`, чарт
  `synth/synth-gateway-telegram` из реестра
  `https://gitverse.ru/api/packages/itphx/helm` — см. [docs/deployment.md](docs/deployment.md).

## Лицензия

MIT — см. [LICENSE](LICENSE).
