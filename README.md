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
