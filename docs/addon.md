# Add-on Synth: границы и основания

> Краткая выжимка. Полные архитектурные решения — в основном репозитории Synth:
> <https://gitverse.ru/itphx/synth> (AD-086, AD-089, AD-090).
> Этот репозиторий — реализация первого add-on'а, Telegram-шлюза.

## Что такое add-on

**Add-on** — внешний сервис-надстройка: отдельный процесс/контейнер со своим
репозиторием, релизным циклом, образами и деплоем. Он общается с Synth
исключительно по **публичным контрактам**: API v2, MCP и внешние события (AD-089).

Классы расширений Synth разведены жёстко (AD-090) и не смешиваются:

| Класс | Что запускается | Носитель | Доступ к internals |
|---|---|---|---|
| **Plugin** | код **в процессе core** | JS-бандл через Extension API | да (под permission-слоем) |
| **Add-on** | **внешний сервис** в своём процессе | образ + compose/Helm | **нет** |
| **Declarative** | ничего (данные) | файлы контента (скиллы, агенты, MCP-серверы, маршруты) | нет |

## Границы Telegram-шлюза

- ✅ внешний сервис: long-polling Telegram → нормализация → `POST /api/v2/events`;
  обратная доставка ответов агента через SSE;
- ✅ **отдаёт MCP агенту** (stdio локально, Streamable HTTP в кластере) и
  **сам устанавливает свои MCP/skills** в инстанс (hook-Job чарта);
- ❌ не плагин: не монтируется в процесс core, точек расширения Extension API
  (хуки, `ToolRegistry`, `ProviderFactory`, UI-слоты) не имеет;
- ❌ нет прямого доступа к internals ядра (`FileStore`, `GatewayProvider`, сессии
  в обход API);
- ⚠️ **LLM внутрь сервиса не тянется**: понимание/генерацию делает движок Synth,
  шлюз — детерминированный транспорт событий.

## Точки интеграции

- **API v2** (`/api/v2`): `POST /events`, `GET /events` (SSE), `/events/bindings*`,
  `/sessions*`, `/users*` (для `tg_send_to_user`), `/mcp/registry`, `/skills*`
  (инсталлятор); аутентификация — scoped service-key `synth_svc_…` (AD-052).
- **MCP**: инструменты `tg_*` для агента; неймспейс в Synth —
  `synth-gateway-telegram_<tool>`. Транспорты:
  - **stdio** (bin `synth-gateway-tg`) — локальный запуск движком;
  - **Streamable HTTP** (`--http`) — путь `/mcp/<tenantId>`, порт 7101;
    в K3s используется именно он (движок не спавнит процесс add-on'а).
- **Внешние события** (AD-089): тело `{ source, type, payload, identity, dedupKey }`;
  стабильный `dedupKey` обязателен.

Детали конфигурации — [configuration.md](configuration.md), развёртывание —
[deployment.md](deployment.md).

## Манифест `provides` (`addon.json`)

Манифест `addon.json` описывает совместимость (`name`/`version`/`kind: "addon"`/
`host`/`contracts`) и секцию **`provides`** — какие ресурсы add-on умеет отдавать
инстансу Synth. `{tenant}` — плейсхолдер, подставляется инсталлятором
(`--tenant`).

```json
{
  "name": "@itphx/synth-gateway-telegram",
  "version": "0.2.0",
  "kind": "addon",
  "host": "^0.9.0",
  "contracts": { "apiV2": "^2", "events": "^1", "mcp": "^1" },
  "provides": {
    "mcp": {
      "name": "synth-gateway-telegram",
      "transport": "http",
      "port": 7101,
      "path": "/mcp/{tenant}",
      "description": "Telegram-шлюз: тулы tg_*"
    },
    "skills": [{ "name": "gateway-telegram", "path": "skills/gateway-telegram" }]
  }
}
```

| Поле | Смысл |
|---|---|
| `provides.mcp.name` | имя записи в реестре MCP-серверов Synth (AD-071); тулы видны как `<name>_<tool>` |
| `provides.mcp.transport` | транспорт MCP: `http` (Streamable HTTP) |
| `provides.mcp.port` | порт MCP-сервера; по нему чарт собирает URL для авто-установки |
| `provides.mcp.path` | путь эндпоинта с плейсхолдером `{tenant}` |
| `provides.skills[].name` | имя скилла (AD-046) |
| `provides.skills[].path` | каталог скилла в репозитории (`SKILL.md` + supporting-файлы) |

## HTTP-MCP (`src/mcp/http.ts`)

- **Мультитенантность.** Путь `/mcp/<tenantId>`: контекст инструментов (токен
  бота, прокси, dataDir, synthUrl/serviceKey) берётся из `tenants.json` **этого**
  тенанта — тем же загрузчиком, что у сервиса шлюза. Неизвестный тенант → `404`.
  Всё на одном порту (по умолчанию **7101**).
- **Auth.** Bearer-токен из env `GATEWAY_MCP_TOKEN` или `secrets/mcp_token`;
  отсутствует/неверный → `401`. Токен — параметр чарта/Secret, в git не хранится
  и в логи не попадает. Сравнение — в постоянном времени (`timingSafeEqual`).
- **`GET /health`** — без аутентификации (пробы деплоя): `{status, version,
  transport, tenants}`.
- **Обратная совместимость.** Без `--http` сервер работает по stdio (как раньше).

Пример запроса:

```bash
curl -s http://127.0.0.1:7101/health
curl -s -X POST http://127.0.0.1:7101/mcp/dev \
  -H 'authorization: Bearer <GATEWAY_MCP_TOKEN>' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

## Авто-установка ресурсов (`provides` → инстанс)

Add-on сам регистрирует свои ресурсы в инстансе — референсный инсталлятор
`scripts/install-into-synth.mjs` (логика — `src/installer/install.ts`) читает
`addon.json.provides` и работает в двух режимах:

| Режим | Как включается | Что делает |
|---|---|---|
| **managed** | `--synth-url` + `--token` (env `SYNTH_INSTALL_TOKEN`) | MCP: `POST /mcp/registry` (повтор/409 → `PUT /mcp/registry/:id` либо `PUT /mcp/servers/:name`); skills: `POST /skills` (409 → `PATCH /skills/:name` + `PUT /skills/:name/files/*`); затем `POST /skills/reload` |
| **standalone** | `--config <config.yaml>` + `--data-dir <dir>` | merge `mcp.servers` в config.yaml (атомарно); копирование каталога скилла в `{dataDir}/skills/<name>/`; при доступном API — `POST /skills/reload` |

Аргументы: `--synth-url`, `--token`, `--tenant`, `--mcp-url` **или**
`--service-host` (URL MCP собирается как `http://<host>:<provides.mcp.port><path>`),
`--only mcp,skills` (или флаги `--mcp`/`--skills`), `--skills-dir`, `--mcp-token`
(env `SYNTH_MCP_TOKEN`), `--no-enabled-by-default`, `--config`, `--data-dir`,
`--root`, `--dry-run`, `--help`.

Запись реестра создаётся с `enabledByDefault: true` (новые проекты/сессии
подхватывают сервер; снять — `--no-enabled-by-default`) и, при заданном
`--mcp-token`, с `config.headers.Authorization = Bearer <токен>` — ядро
пробрасывает `headers` в MCP-клиент, поэтому Synth подключается к
`/mcp/<tenant>` авторизованно (без токена HTTP-MCP шлюза отвечает 401). Токен в
логи не печатается; в кластере его выдаёт чарт (Secret) и передаёт в Job как
`SYNTH_MCP_TOKEN`.

**Идемпотентность обязательна:** повторный прогон (в т.ч. `helm upgrade`)
обновляет запись/скилл, а не создаёт дубликаты; при ошибке — понятное сообщение
и код возврата ≠ 0 (до изменений проверяется, что выбран режим установки для всех
выбранных сущностей). В кластере инсталлятор запускается hook-Job'ом чарта
(`autoInstall`, см. [deployment.md](deployment.md)).

## Три вида аддонов

| Вид | Конфигурация | Что делает инсталлятор |
|---|---|---|
| **сервис + MCP + skills** | `mcp.enabled=true`, `autoInstall.enabled=true`, `autoInstall.mcp=true`, `autoInstall.skills=true` | поднимает второй контейнер MCP (порт 7101), регистрирует MCP-сервер и скилл |
| **только MCP** (агент вызывает тулы, чат не подключён) | `autoInstall.enabled=true`, `autoInstall.mcp=true`, `autoInstall.skills=false` | регистрирует только запись MCP-реестра |
| **только скиллы** (инструкции агенту без запуска сервиса) | `mcp.enabled=false`, `autoInstall.enabled=true`, `autoInstall.mcp=false`, `autoInstall.skills=true` | ставит только скилл |

Для аддонов **без образа** предусмотрены `autoInstall.image` (образ с node) +
`autoInstall.scriptConfigMap` (ConfigMap с `install-into-synth.mjs`) +
`autoInstall.skillsFromConfigMap` (файлы скиллов в values).

## Совместимость

Манифест `addon.json` в корне фиксирует `name`/`version`/`kind: "addon"`/`host` и
диапазоны контрактов `apiV2`/`events`/`mcp` (semver). `host` и `contracts`
проверяются при подключении к инстансу Synth.
