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
                                  └◀── watcher ── stream.done/message.added ────┘
                                          └──▶ sendMessage (ответ агента в чат)
                                  └── offset / seen / chatSessions / routes / sent ── FileStore
```

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

## Структура

```text
synth-gateway-telegram/
├── src/
│   ├── gateway/     # сервис synth-gateway-telegram (bin): поллер, нормализация, ingest, watcher, health
│   ├── mcp/         # MCP-сервер synth-gateway-tg (bin, stdio): тулы tg_*
│   └── bot-api/     # клиент Telegram Bot API (fetch + прокси)
├── charts/synth-gateway-telegram/    # Helm-чарт (k8s + NOTES.txt)
├── docker/ · docker-compose.yml · .env.example
├── examples/        # примеры Secret и tenants.json
├── docs/            # configuration.md · deployment.md · addon.md
├── skills/gateway-telegram/SKILL.md  # скилл AD-046 для агента
├── scripts/         # release-хелперы (docker-auth, publish-chart, version-bump, release-notes)
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
