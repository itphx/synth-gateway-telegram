# Конфигурация Telegram-шлюза

> Единственный справочник по конфигурации add-on'а. Здесь: переменные окружения,
> CLI-флаги, секрет-файлы, приоритеты, режимы аутентификации Synth API, прокси,
> доверие внутреннему CA и мультитенантность (`tenants.json`).
> Ссылки: [README](../README.md) · [deployment](deployment.md) · [add-on](addon.md).

## Приоритет значений

```text
CLI-флаг  >  env  >  файл secrets/  >  значение по умолчанию
```

**Пустая или whitespace-only строка эквивалентна отсутствию значения** (хелпер
`envOr`: подстановка `{env:VAR}` при незаданной переменной даёт пустую строку).
Это важно для движка, где пустая строка иначе «перекрыла бы» файл/дефолт.

## Переменные окружения

### Шлюз (`synth-gateway-telegram`)

| Env | Дефолт | Назначение |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `secrets/telegram_bot_token` | Токен бота (без него — dry-run) |
| `TELEGRAM_PROXY_URL` | цепочка `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY`, затем `secrets/telegram_proxy_url` | Egress-прокси Bot API |
| `SYNTH_URL` | `http://127.0.0.1:5000/api/v2` | Базовый URL API v2 |
| `SYNTH_SERVICE_KEY` | `secrets/synth_service_key` | Scoped service-key `synth_svc_…` (AD-052) — приоритетная машинная аутентификация |
| `SYNTH_API_KEY` | `secrets/synth_api_key` | Служебный Bearer-ключ (standalone/dev, legacy-fallback) |
| `SYNTH_OIDC_TOKEN_URL` | `secrets/oidc_token_url` | OIDC token-эндпоинт (`client_credentials`, managed) |
| `SYNTH_OIDC_DISCOVERY_URL` | `secrets/oidc_discovery_url` | URL OIDC discovery (альтернатива token URL) |
| `SYNTH_OIDC_CLIENT_ID` | `secrets/oidc_client_id` | OIDC `client_id` |
| `SYNTH_OIDC_CLIENT_SECRET` | `secrets/oidc_client_secret` | OIDC `client_secret` |
| `SYNTH_OIDC_SCOPE` | `secrets/oidc_scope` | Необязательный OIDC `scope` |
| `GATEWAY_ALLOWLIST` | `secrets/allowlist.json` | Список доступа `chatId:ROLE,...` |
| `GATEWAY_TENANTS_FILE` | `secrets/tenants.json` (если есть) | Файл тенантов; нет файла — один тенант `default` из env/CLI |
| `GATEWAY_DATA_DIR` | `<repo>/data` | Корневой каталог JSON-хранилища (тенанты — `<dataDir>/tenants/<id>`) |
| `GATEWAY_SECRETS_DIR` | `<repo>/secrets` | Каталог секрет-файлов |
| `GATEWAY_DRY_RUN` | вычисляется по наличию токена | Форсировать dry-run |
| `GATEWAY_WATCH` | `true` | Поднимать ли watcher ответов агента (SSE) |
| `GATEWAY_PARSE_MODE` | `plain` | Отправка ответов: `plain` \| `html` (escape + `parse_mode: 'HTML'`) |
| `GATEWAY_UNKNOWN_ACTION` | `register` | Политика неизвестного отправителя: `register` \| `hint` \| `reject` |
| `GATEWAY_POLL_TIMEOUT_SEC` | `30` | Таймаут long-polling `getUpdates`, сек (запросный таймаут — long-poll + 15 с) |
| `GATEWAY_REQUEST_TIMEOUT_SEC` | `30` | Таймаут обычных запросов Bot API, сек |
| `GATEWAY_HOST` / `GATEWAY_PORT` | `127.0.0.1` / `7100` | Health-сервер |

### MCP-сервер (`synth-gateway-tg`)

| Env | Дефолт | Назначение |
|---|---|---|
| `GATEWAY_DEFAULT_CHAT_ID` | `secrets/telegram_owner_chat_id` | Чат по умолчанию для `tg_send_message`/`tg_edit_message`/`tg_delete_message` |
| `GATEWAY_OWNER_CHAT_ID` | `GATEWAY_DEFAULT_CHAT_ID` | Получатель `tg_notify` |
| `GATEWAY_DATA_DIR` | `<repo>/data` | Каталог хранилища шлюза (для `tg_status`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_PROXY_URL` | см. выше | Токен и прокси Bot API |

## CLI-флаги

### Шлюз

```text
synth-gateway-telegram [--once] [--dry-run] [--no-watch] [--token TOKEN]
                       [--proxy URL] [--synth-url URL] [--service-key KEY]
                       [--api-key KEY] [--oidc-token-url URL]
                       [--oidc-discovery-url URL] [--oidc-client-id ID]
                       [--oidc-client-secret SECRET] [--oidc-scope SCOPE]
                       [--allowlist LIST] [--tenants-file PATH]
                       [--parse-mode plain|html]
                       [--unknown-action register|hint|reject]
                       [--poll-timeout SEC] [--request-timeout SEC]
                       [--data-dir DIR] [--host HOST] [--port N] [--help]
```

Флаги перекрывают env (значения — те же, что в таблицах выше). `--once` — один
проход `getUpdates` по каждому тенанту и выход; `--dry-run` — без токена один
проход и выход; `--no-watch` — не поднимать watcher ответов агента.
`--api-key` — алиас `--synth-api-key`.

### MCP-сервер

```text
synth-gateway-tg [--token T] [--proxy URL] [--chat ID] [--owner ID] [--data-dir DIR] [--help]
```

## Секрет-файлы

Каталог секретов — `GATEWAY_SECRETS_DIR` (по умолчанию `<repo>/secrets`), файлы
читаются **плоско**. Пустой файл = отсутствие значения. Секреты вне git, права `600`.

| Файл | Env-переменная | Назначение |
|---|---|---|
| `telegram_bot_token` | `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота |
| `telegram_proxy_url` | `TELEGRAM_PROXY_URL` | Egress-прокси Bot API (`socks5://` или `http(s)://`) |
| `telegram_owner_chat_id` | `GATEWAY_DEFAULT_CHAT_ID`, `GATEWAY_OWNER_CHAT_ID` | Чат по умолчанию / владелец для `tg_notify` |
| `allowlist.json` | `GATEWAY_ALLOWLIST` | Список доступа `{"<chatId>":"ROLE"}` |
| `tenants.json` | `GATEWAY_TENANTS_FILE` | Мультитенантность: боты → среды Synth |
| `synth_service_key` | `SYNTH_SERVICE_KEY` | Scoped service-key `synth_svc_…` (AD-052) |
| `synth_api_key` | `SYNTH_API_KEY` | Bearer (standalone/dev, legacy-fallback) |
| `oidc_token_url` | `SYNTH_OIDC_TOKEN_URL` | OIDC token-эндпоинт |
| `oidc_discovery_url` | `SYNTH_OIDC_DISCOVERY_URL` | URL OIDC discovery |
| `oidc_client_id` | `SYNTH_OIDC_CLIENT_ID` | OIDC `client_id` |
| `oidc_client_secret` | `SYNTH_OIDC_CLIENT_SECRET` | OIDC `client_secret` |
| `oidc_scope` | `SYNTH_OIDC_SCOPE` | Необязательный `scope` |

Пример наполнения:

```bash
printf '%s' '123456:AA...'          > secrets/telegram_bot_token
printf '%s' '{"123456789":"ADMIN"}' > secrets/allowlist.json
printf '%s' '<synth_svc_...>'       > secrets/synth_service_key   # приоритетно
chmod 600 secrets/*
```

## Аутентификация Synth API

Все вызовы Synth API (ingest `POST /events`, SSE `GET /events`, bindings,
sessions) берут Bearer-токен у `AuthTokenProvider`. Приоритет (AD-052):

```text
SYNTH_SERVICE_KEY  >  OIDC (discovery/token URL + client_id + client_secret)  >  SYNTH_API_KEY  >  без auth
```

- **Scoped service-key (рекомендуется).** Ключ `synth_svc_…` аутентифицирует
  машину и ограничен `scopes` + проекцией `allowedProjects`. Задан явно — он
  главный. Минимум для сквозного контура (приём событий + обратная доставка
  watch-all SSE `GET /events`) — scopes `events:ingest`, `events:watch`;
  локальные команды `/bind`/`/unbind` и работа с сессиями добавляют
  `bindings:read`, `bindings:write`, `sessions:create`, `sessions:read`. Роль
  ключа — `LEAD` (для команд `/bind`/`/unbind`: мутации `/events/bindings*`
  под `requirePermission('ADMIN','LEAD')`; watch-all SSE даёт сам
  service-credential по scope `events:watch` — elevated-роль для этого не нужна).

  ```bash
  curl -sX POST http://127.0.0.1:5000/api/v2/service-keys \
    -H 'Authorization: Bearer <ADMIN-ключ>' \
    -H 'content-type: application/json' \
    -d '{
      "label": "telegram-gateway",
      "roles": ["LEAD"],
      "scopes": ["events:ingest","events:watch","bindings:read","bindings:write","sessions:create","sessions:read"]
    }'
  # → { ..., "key": "synth_svc_…" }  — plaintext отдаётся ЕДИНСТВЕННЫЙ раз
  ```

  Отзыв — `POST /api/v2/service-keys/:id/revoke`.
- **OIDC-провайдер.** Статический `SYNTH_API_KEY` не принимается:
  задайте `SYNTH_OIDC_TOKEN_URL` (или `SYNTH_OIDC_DISCOVERY_URL`) +
  `SYNTH_OIDC_CLIENT_ID` + `SYNTH_OIDC_CLIENT_SECRET`. Токен запрашивается
  `grant_type=client_credentials`, кэшируется, обновляется за 30 с до
  `expires_in`, при `401` — forced refresh и один повтор (single-flight).
  Ошибки — `gateway.oidc_token_failed` (секреты в логи не попадают).
  OIDC-запросы идут **напрямую** (`fetch`), `TELEGRAM_PROXY_URL` к ним не
  применяется.

  **Для обратной доставки OIDC самодостаточен не полностью.** Watcher слушает
  watch-all SSE `GET /events`, а backend для этого читает **realm-роли**
  service-account'а, не client-роли клиента шлюза. Пока service-account'у
  клиента в Keycloak не выдана **realm-роль** `lead`/`admin` (Clients → клиент
  шлюза → Service accounts roles → назначить realm-роль), `GET /events` отдаёт
  только сессии по обычным правилам видимости, и ответы агента в чаты не
  доставляются. Поэтому для сквозного контура предпочтителен service-key: он
  даёт watch-all по scope `events:watch` **без** админ-прав. OIDC остаётся
  рабочей опцией (когда политика Keycloak уже выдаёт нужную realm-роль).
- **Standalone/dev (legacy).** `SYNTH_API_KEY` — Bearer, если service-key и OIDC
  не заданы.
- **Health.** `GET /health` → поля `auth`
  (`service-key`/`oidc`/`api-key`/`none`) и `token` (`ok`/`error`).

## Прокси Bot API

Приоритет:

```text
env TELEGRAM_PROXY_URL  >  ALL_PROXY  >  HTTPS_PROXY  >  HTTP_PROXY  >  secrets/telegram_proxy_url
```

- Схемы: **`socks5://`** (SOCKS5) и **`http(s)://`** (HTTP CONNECT).
- Прокси-агент создаётся **один раз** на конфигурацию и переиспользуется;
  `TelegramClient.close()` освобождает соединения при остановке.
- Таймауты обязательны: зависший запрос прерывается (`telegram.request_timeout`),
  поллер не падает и продолжает цикл с backoff. Сетевые ошибки обогащаются
  контекстом (метод, URL без токена `/bot<redacted>/…`, `proxy=true|false`);
  секреты в логи не попадают.
- Через SOCKS5 long-poll `getUpdates` может зависать — при проблемах
  предпочитайте HTTP CONNECT (`http://<proxy-host>:3129`).

## Доверие внутреннему CA (внешний https-инстанс Synth)

Если `synthUrl` тенанта — внешний https-адрес с внутренним (self-signed) CA
окружения, Node/undici (`fetch`) должен доверять этому CA, иначе TLS-ошибка
`SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Для in-cluster
`http://synth-backend:5000/api/v2` TLS-доверие не нужно.

- **Механизм:** env `NODE_EXTRA_CA_CERTS=<путь>` (кода шлюза не касается).
- **Bundle:** `certs/ca.crt` — root + intermediate (root первым); каталог `certs/`
  вне git, положите свой локально.
- **Локально:** `NODE_EXTRA_CA_CERTS=certs/ca.crt node dist/gateway/index.js`.
- **docker compose:** ro-mount `./certs/ca.crt:/certs/ca.crt` + `NODE_EXTRA_CA_CERTS=/certs/ca.crt`.
- **Kubernetes/Helm:** `ca.enabled` + `ca.caCert` (inline PEM) либо `ca.existingConfigMap`
  (+ `ca.configMapKey`, `ca.mountPath`); чарт монтирует файл и выставляет env.

## Мультитенантность (боты → среды Synth)

Один процесс обслуживает **N ботов**, каждый привязан к своей среде Synth.
Источник — `tenants.json`; путь: `--tenants-file` > `GATEWAY_TENANTS_FILE` >
`<secretsDir>/tenants.json` (если существует). **Нет файла — legacy:** один
тенант `default` из env/CLI/`secrets/` (состояние — в корне `dataDir`).

```json
{ "tenants": [
  { "id": "dev",  "botToken": "111111:DEV_BOT_TOKEN", "synthUrl": "http://127.0.0.1:5000/api/v2",
    "serviceKey": "synth_svc_DEV…", "allowlist": "123456789:ADMIN" },
  { "id": "test", "botToken": "222222:TEST_BOT_TOKEN", "synthUrl": "https://synth.k3s.example/api/v2",
    "serviceKey": "synth_svc_TEST…", "proxyUrl": "http://proxy.example.com:3129", "parseMode": "html" }
] }
```

Каждый тенант использует свою среду и свои креды Synth API (`serviceKey`/`apiKey`/
`oidc*`) — один `synth_svc_…` не переносится между средами.

| Поле | Обязательно | Назначение |
|---|---|---|
| `id` | да | Ключ тенанта: `[a-z0-9][a-z0-9_-]*`, уникален |
| `botToken` / `token` | да (кроме dry-run) | Токен бота тенанта |
| `synthUrl` / `synth.url` | нет | Базовый URL API v2 среды тенанта |
| `serviceKey` / `apiKey` | нет | Креды Synth API (приоритет service-key) |
| `oidcTokenUrl`/`oidcDiscoveryUrl`/`oidcClientId`/`oidcClientSecret`/`oidcScope` | нет | OIDC client-credentials |
| `proxyUrl` | нет | Egress-прокси Bot API тенанта |
| `allowlist` | нет | Строка `"chatId:ROLE,…"` **или** объект `{"chatId":"ROLE"}` |
| `parseMode` | нет | `plain` (дефолт) \| `html` |
| `unknownAction` | нет | `register` \| `hint` \| `reject` |
| `watch` | нет | Поднимать ли watcher ответов (SSE) |
| `pollTimeoutSec` / `requestTimeoutSec` | нет | Таймауты Bot API, сек |

Правила:

- **Приоритет:** per-tenant значения файла > глобальные дефолты (env/CLI/`secrets/`).
- **Строгая валидация (fail-fast):** неизвестное поле, дубль/невалидный `id`,
  отсутствие `id`/`botToken` (вне dry-run), битый JSON → понятная ошибка старта.
- **Изоляция состояния:** тенанты пишут в `<dataDir>/tenants/<id>`; legacy
  `default` — в корень `dataDir`.
- **Общие для процесса:** `dataDir`, `host`, `port`, `dryRun`, версия.
- **Health (`GET /health`, без auth):** плоские поля — агрегат по тенантам,
  `tenants` — разбивка. `status` = `down`, если хоть один тенант `down`;
  `degraded`, если хоть один `degraded`; иначе `ok`.
- **Логи:** префикс тенанта `[gateway][<id>] …`; в legacy — без префикса.
- Файл тенантов содержит токены/key — **секрет**, вне git.

## Идентичность отправителя и политика неизвестного

AD-089 разделяет **чат** (routing — `identity.chatKey`/`threadKey`) и **человека**
(ownership/attribution — `identity.principalId`, у шлюза `tg:<id>`). Событие несёт
в `payload.from` набор `{ id, username?, firstName?, displayName, isExternal: true }`;
ядро выводит автора (`@username` → имя → `tg:<id>`). Для групп `payload.chatId` —
id группы, `payload.from.id` — конкретный автор. Топик:
`identity.threadKey = thread:telegram:<chatId>:<threadId>`.

`GATEWAY_UNKNOWN_ACTION` — политика отправителя, не сопознанного с учётной записью
Synth («известность» резолвит **ядро**; шлюз реестр не ведёт и коды не генерирует):

| Значение | Поведение |
|---|---|
| `register` (дефолт) | событие публикуется; владельца/автора решает ядро; коды линковки не показываются |
| `hint` | событие публикуется; если ядро вернуло `identityHint` (одноразовый код) — шлюз шлёт `/link <код>` **только в приватный чат** (в группе/канале — лог `gateway.identity_hint_not_private`) |
| `reject` | событие не публикуется, отправителю уходит отказ |

**Роль в `GATEWAY_ALLOWLIST` — потолок прав, не дарование (AD-089).** Роль
(`chatId:ROLE`) даёт допуск к шлюзу и гейтит локальные команды `/bind`/`/unbind`/
`/new` (`ADMIN`/`LEAD`), а в Synth **сужает** роли **профиля** отправителя
(пересечение), но не повышает. Несопознанный отправитель → прав Synth нет
(fail-closed), чат/сессия работают. Права машинного аккаунта шлюза внешним
отправителям не раздаются — это служебная аутентификация транспорта.

## Правила

- Секреты **не коммитить** и **не печатать в логи** (в лог — только факт
  «задан/не задан» и число записей списка доступа).
- В Kubernetes/Helm секреты — через `existingSecret`/SealedSecret, не в `values.yaml`.
- В Docker — ro-mount каталога секретов (`./secrets:/run/secrets:ro`).
