# Telegram gateway configuration

> 🌐 **English** · [Russian](../configuration.md)

> The single reference for gateway configuration. It covers: environment variables,
> CLI flags, secret files, priorities, Synth API authentication modes, proxy,
> trust in an internal CA and multi-tenancy (`tenants.json`).
> Links: [README](../../README.en.md) · [deployment](deployment.md) · [Gateway](gateway.md).

## Value priority

```text
CLI flag  >  env  >  secrets/ file  >  default value
```

**An empty or whitespace-only string is equivalent to a missing value** (helper
`envOr`: substituting `{env:VAR}` for an unset variable yields an empty string).
This matters for the engine, where an empty string would otherwise "override" the file/default.

## Environment variables

### Gateway (`synth-gateway-telegram`)

| Env | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `secrets/telegram_bot_token` | Bot token (without it — dry-run) |
| `TELEGRAM_PROXY_URL` | chain `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY`, then `secrets/telegram_proxy_url` | Egress proxy for the Bot API |
| `SYNTH_URL` | `http://127.0.0.1:5000/api/v2` | Base URL of API v2 |
| `SYNTH_SERVICE_KEY` | `secrets/synth_service_key` | Scoped service-key `synth_svc_…` (AD-052) — the preferred machine authentication |
| `SYNTH_API_KEY` | `secrets/synth_api_key` | Service Bearer key (standalone/dev, legacy fallback) |
| `SYNTH_OIDC_TOKEN_URL` | `secrets/oidc_token_url` | OIDC token endpoint (`client_credentials`, managed) |
| `SYNTH_OIDC_DISCOVERY_URL` | `secrets/oidc_discovery_url` | OIDC discovery URL (alternative to the token URL) |
| `SYNTH_OIDC_CLIENT_ID` | `secrets/oidc_client_id` | OIDC `client_id` |
| `SYNTH_OIDC_CLIENT_SECRET` | `secrets/oidc_client_secret` | OIDC `client_secret` |
| `SYNTH_OIDC_SCOPE` | `secrets/oidc_scope` | Optional OIDC `scope` |
| `GATEWAY_ALLOWLIST` | `secrets/allowlist.json` | Access list `chatId:ROLE,...` |
| `GATEWAY_TENANTS_FILE` | `secrets/tenants.json` (if present) | Tenants file; without the file — a single `default` tenant from env/CLI |
| `GATEWAY_DATA_DIR` | `<repo>/data` | Root directory of the JSON storage (tenants — `<dataDir>/tenants/<id>`) |
| `GATEWAY_SECRETS_DIR` | `<repo>/secrets` | Directory of secret files |
| `GATEWAY_DRY_RUN` | inferred from the presence of a token | Force dry-run |
| `GATEWAY_WATCH` | `true` | Whether to start the agent-reply watcher (SSE) |
| `GATEWAY_PARSE_MODE` | `plain` | Reply sending: `plain` \| `html` \| `markdown` (see "Reply-sending modes") |
| `GATEWAY_UNKNOWN_ACTION` | `register` | Unknown-sender policy: `register` \| `hint` \| `reject` |
| `GATEWAY_POLL_TIMEOUT_SEC` | `30` | `getUpdates` long-polling timeout, sec (request timeout — long-poll + 15 s) |
| `GATEWAY_REQUEST_TIMEOUT_SEC` | `30` | Regular Bot API request timeout, sec |
| `GATEWAY_HOST` / `GATEWAY_PORT` | `127.0.0.1` / `7100` | Health server |

### Reply-sending modes (`parseMode`)

`GATEWAY_PARSE_MODE` / `--parse-mode` / per-tenant `parseMode`; an unknown value → the `plain` default.

| Mode | Behavior |
|---|---|
| `plain` | The agent's answer is sent as is (`sendMessage`, without `parse_mode`) |
| `html` | The answer's Markdown is rendered into Telegram HTML (`markdownToTelegramHtml`) and sent with `parse_mode: 'HTML'`, chunks ≤ 4096 |
| `markdown` | Bot API 10.1 "Rich Messages" (`sendRichMessage({ rich_message: { markdown } })`): native headings, lists, **tables**, quotes, code, footnotes. Markdown is passed as is |

> ⚠️ The regular `parse_mode: Markdown`/`MarkdownV2` **cannot do tables** — native
> tables are handled by the rich mode (`markdown`).

The `markdown` (rich) mode:

- **Streaming** — as an ephemeral draft (`sendRichMessageDraft`): in **private
  chats** the answer streams as accumulated Markdown with ~1 s throttling (edits to a single
  `draft_id` are animated). **In groups/channels Bot API drafts are unavailable** —
  only the "Typing…" indicator remains, and the full answer arrives at the end.
  `draft_id` is stable and derived from `stream_id` (different runs do not "merge").
- **Final** (`stream.done`) — a persistent `sendRichMessage` with the full Markdown
  (the draft is ephemeral and disappears by itself after ~30 s). `stream.cancelled` —
  a rich message with the partial text and the mark "⏹ Stopped"; `stream.error` —
  a rich error message.
- **Draft resilience.** `RICH_MESSAGE_EMPTY` (nothing to show —
  an unclosed fence, only `|`/`---`) is **not** a failure: the draft is skipped.
  Transient failures (network, `aborted`, 5xx) disable drafts only after
  **3 in a row** (a successful send resets the counter); `429` — the `retry_after` window.
  The final always tries rich: a permanent html fallback is enabled only on a
  **final** failure and does not depend on whether drafts worked.
- **Fallback.** If the rich call is rejected (400: limits/unsupported content)
  or the text is > 32768 characters — the watcher falls back to the html path
  (`markdownToTelegramHtml` + chunks ≤ 4096). Telegram errors do not crash the watcher.
- **Rich limits:** up to 32768 characters, 500 blocks, 20 columns per table. Reply —
  via `reply_parameters`.

### MCP server (`synth-gateway-tg`)

| Env | Default | Purpose |
|---|---|---|
| `GATEWAY_DEFAULT_CHAT_ID` | `secrets/telegram_owner_chat_id` | Default chat for `tg_send_message`/`tg_edit_message`/`tg_delete_message` |
| `GATEWAY_OWNER_CHAT_ID` | `GATEWAY_DEFAULT_CHAT_ID` | Recipient of `tg_notify` |
| `GATEWAY_DATA_DIR` | `<repo>/data` | Gateway storage directory (for `tg_status`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_PROXY_URL` | see above | Bot API token and proxy |
| `GATEWAY_MCP_TOKEN` | — | Bearer token for **HTTP-MCP** clients (`--http`; file `secrets/mcp_token`). Not set → HTTP mode does not start (fail-fast) |
| `GATEWAY_TENANTS_FILE` | `secrets/tenants.json` | HTTP-MCP tenants: `/mcp/<tenantId>`, tool context — from this file |
| `SYNTH_URL` | `http://127.0.0.1:5000/api/v2` | Tenant API v2 (legacy mode): resolving `tg_send_to_user` and event ingress |
| `SYNTH_SERVICE_KEY` | `secrets/synth_service_key` | Machine credential for resolving `user` → Telegram (requires the `users:read` scope) |

### `tg_send_to_user` and required permissions

The tool sends a message to a specific Synth user. The recipient is `user` (id or
Synth account `username`), `principalId` (`tg:<id>`, AD-089) or `chatId`.

- `principalId`/`chatId` — **without an API call** (they work without a scope too).
- `user` — via `GET {synthUrl}/users/:id` (on 404 — `GET /users` + lookup by
  `username`) with the tenant's machine credential: the **`users:read`** scope is required (added
  in the core in parallel). `identities[]` with
  `provider === 'telegram'` → `external_id` = `chat_id` is taken from the profile. No identity →
  a clear error (linking is in the Synth UI: Settings → Profile → Identities);
  no permissions (401/403) → `telegram.user_forbidden`; the API is unavailable →
  `telegram.synth_api_unavailable`.

## CLI flags

### Gateway

```text
synth-gateway-telegram [--once] [--dry-run] [--no-watch] [--token TOKEN]
                       [--proxy URL] [--synth-url URL] [--service-key KEY]
                       [--api-key KEY] [--oidc-token-url URL]
                       [--oidc-discovery-url URL] [--oidc-client-id ID]
                       [--oidc-client-secret SECRET] [--oidc-scope SCOPE]
                       [--allowlist LIST] [--tenants-file PATH]
                       [--parse-mode plain|html|markdown]
                       [--unknown-action register|hint|reject]
                       [--poll-timeout SEC] [--request-timeout SEC]
                       [--data-dir DIR] [--host HOST] [--port N] [--help]
```

Flags override env (the values are the same as in the tables above). `--once` — one
`getUpdates` pass per tenant and exit; `--dry-run` — without a token, one
pass and exit; `--no-watch` — do not start the agent-reply watcher.
`--api-key` — an alias of `--synth-api-key`.

### MCP server

```text
synth-gateway-tg [--token T] [--proxy URL] [--chat ID] [--owner ID] [--data-dir DIR] [--help]

# HTTP transport (Streamable HTTP; used in K8s — stdio is unavailable there)
synth-gateway-tg --http [--host 0.0.0.0] [--port 7101]
                 [--mcp-token TOKEN] [--tenants-file PATH] [--secrets-dir DIR]
                 [--data-dir DIR] [--chat ID] [--owner ID]
```

Without `--http` — the previous stdio mode. In HTTP mode the request path is `/mcp/<tenantId>`
(tenants from `tenants.json`; unknown → 404), `GET /health` — without auth,
the rest requires `Authorization: Bearer <GATEWAY_MCP_TOKEN>`. The default port is
7101 (`--port`), the address — `0.0.0.0` (`--host`). The `--chat`/`--owner` flags set
the default chat and the `tg_notify` recipient for the tools.

### Resource installer

```text
node scripts/install-into-synth.mjs \
  [--synth-url URL] [--token TOKEN] [--tenant ID] \
  [--mcp-url URL | --service-host HOST] [--only mcp,skills] [--skills-dir DIR] \
  [--mcp-token TOKEN] [--no-enabled-by-default] \
  [--config PATH] [--data-dir DIR] [--root DIR] [--dry-run] [--help]
```

`--mcp-token` (env `SYNTH_MCP_TOKEN`) — the bearer token of the gateway's MCP clients: it goes
into `config.headers.Authorization` of the registry entry (the core passes `headers` to the
MCP client; without it, connecting to the gateway's HTTP-MCP would get 401). By default
`enabledByDefault: true` is set — the server is enabled for new projects
(`--no-enabled-by-default` unsets it). Tokens are not printed to the log.

Details and examples — [deployment.md](deployment.md) §"MCP and skills
auto-install", the `provides` contract — [gateway.md](gateway.md).

## Secret files

The secrets directory is `GATEWAY_SECRETS_DIR` (by default `<repo>/secrets`); files
are read **flat**. An empty file = a missing value. Secrets are outside git, mode `600`.

| File | Env variable | Purpose |
|---|---|---|
| `telegram_bot_token` | `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `telegram_proxy_url` | `TELEGRAM_PROXY_URL` | Bot API egress proxy (`socks5://` or `http(s)://`) |
| `telegram_owner_chat_id` | `GATEWAY_DEFAULT_CHAT_ID`, `GATEWAY_OWNER_CHAT_ID` | Default chat / owner for `tg_notify` |
| `allowlist.json` | `GATEWAY_ALLOWLIST` | Access list `{"<chatId>":"ROLE"}` |
| `tenants.json` | `GATEWAY_TENANTS_FILE` | Multi-tenancy: bots → Synth environments |
| `synth_service_key` | `SYNTH_SERVICE_KEY` | Scoped service-key `synth_svc_…` (AD-052) |
| `synth_api_key` | `SYNTH_API_KEY` | Bearer (standalone/dev, legacy fallback) |
| `oidc_token_url` | `SYNTH_OIDC_TOKEN_URL` | OIDC token endpoint |
| `oidc_discovery_url` | `SYNTH_OIDC_DISCOVERY_URL` | OIDC discovery URL |
| `oidc_client_id` | `SYNTH_OIDC_CLIENT_ID` | OIDC `client_id` |
| `oidc_client_secret` | `SYNTH_OIDC_CLIENT_SECRET` | OIDC `client_secret` |
| `oidc_scope` | `SYNTH_OIDC_SCOPE` | Optional `scope` |
| `mcp_token` | `GATEWAY_MCP_TOKEN` | Bearer token for HTTP-MCP clients (`--http`) |

Example of populating:

```bash
printf '%s' '123456:AA...'          > secrets/telegram_bot_token
printf '%s' '{"123456789":"ADMIN"}' > secrets/allowlist.json
printf '%s' '<synth_svc_...>'       > secrets/synth_service_key   # preferred
chmod 600 secrets/*
```

## Synth API authentication

All Synth API calls (ingest `POST /events`, SSE `GET /events`, bindings,
sessions) take the Bearer token from `AuthTokenProvider`. Priority (AD-052):

```text
SYNTH_SERVICE_KEY  >  OIDC (discovery/token URL + client_id + client_secret)  >  SYNTH_API_KEY  >  no auth
```

- **Scoped service-key (recommended).** The `synth_svc_…` key authenticates the
  machine and is limited by `scopes` + the `allowedProjects` projection. If set explicitly, it
  wins. The minimum for the end-to-end loop (event ingestion + reverse watch-all
  SSE `GET /events` delivery) is scopes `events:ingest`, `events:watch`;
  the local `/bind`/`/unbind` commands and session work add
  `bindings:read`, `bindings:write`, `sessions:create`, `sessions:read`. The
  key's role is `LEAD` (for the `/bind`/`/unbind` commands: mutations of `/events/bindings*`
  are under `requirePermission('ADMIN','LEAD')`; watch-all SSE is granted by the
  service credential itself via the `events:watch` scope — an elevated role is not needed for it).

  ```bash
  curl -sX POST http://127.0.0.1:5000/api/v2/service-keys \
    -H 'Authorization: Bearer <ADMIN key>' \
    -H 'content-type: application/json' \
    -d '{
      "label": "telegram-gateway",
      "roles": ["LEAD"],
      "scopes": ["events:ingest","events:watch","bindings:read","bindings:write","sessions:create","sessions:read"]
    }'
  # → { ..., "key": "synth_svc_…" }  — the plaintext is returned EXACTLY once
  ```

  Revocation — `POST /api/v2/service-keys/:id/revoke`.
- **OIDC provider.** A static `SYNTH_API_KEY` is not accepted:
  set `SYNTH_OIDC_TOKEN_URL` (or `SYNTH_OIDC_DISCOVERY_URL`) +
  `SYNTH_OIDC_CLIENT_ID` + `SYNTH_OIDC_CLIENT_SECRET`. The token is requested with
  `grant_type=client_credentials`, cached, refreshed 30 s before
  `expires_in`, and on `401` — a forced refresh and one retry (single-flight).
  Errors — `gateway.oidc_token_failed` (secrets never reach the logs).
  OIDC requests go **directly** (`fetch`); `TELEGRAM_PROXY_URL` is not
  applied to them.

  **For reverse delivery, OIDC is not fully self-sufficient.** The watcher listens to the
  watch-all SSE `GET /events`, and for this the backend reads the **realm roles** of the
  gateway client's service account, not the client's client roles. Until the client's
  service account in Keycloak is granted the **realm role** `lead`/`admin` (Clients → the gateway
  client → Service accounts roles → assign the realm role), `GET /events` returns
  only sessions by the usual visibility rules, and the agent's answers are not delivered to chats.
  Therefore, for the end-to-end loop a service-key is preferable: it
  grants watch-all via the `events:watch` scope **without** admin rights. OIDC remains
  a working option (when the Keycloak policy already grants the required realm role).
- **Standalone/dev (legacy).** `SYNTH_API_KEY` — Bearer, if service-key and OIDC
  are not set.
- **Health.** `GET /health` → the `auth`
  (`service-key`/`oidc`/`api-key`/`none`) and `token` (`ok`/`error`) fields.

## Bot API proxy

Priority:

```text
env TELEGRAM_PROXY_URL  >  ALL_PROXY  >  HTTPS_PROXY  >  HTTP_PROXY  >  secrets/telegram_proxy_url
```

- Schemes: **`socks5://`** (SOCKS5) and **`http(s)://`** (HTTP CONNECT).
- The proxy agent is created **once** per configuration and reused;
  `TelegramClient.close()` releases connections on shutdown.
- Timeouts are mandatory: a hung request is aborted (`telegram.request_timeout`),
  the poller does not crash and continues the loop with backoff. Network errors are enriched
  with context (method, URL without the token `/bot<redacted>/…`, `proxy=true|false`);
  secrets never reach the logs.
- Over SOCKS5, the `getUpdates` long-poll may hang — if you have problems,
  prefer HTTP CONNECT (`http://<proxy-host>:3129`).

## Trusting an internal CA (external https Synth instance)

If a tenant's `synthUrl` is an external https address with the environment's internal
(self-signed) CA, Node/undici (`fetch`) must trust this CA, otherwise a TLS error
`SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` occurs. For an in-cluster
`http://synth-backend:5000/api/v2`, TLS trust is not needed.

- **Mechanism:** env `NODE_EXTRA_CA_CERTS=<path>` (does not touch the gateway code).
- **Bundle:** `certs/ca.crt` — root + intermediate (root first); the `certs/` directory is
  outside git, put your own there locally.
- **Locally:** `NODE_EXTRA_CA_CERTS=certs/ca.crt node dist/gateway/index.js`.
- **docker compose:** ro-mount `./certs/ca.crt:/certs/ca.crt` + `NODE_EXTRA_CA_CERTS=/certs/ca.crt`.
- **Kubernetes/Helm:** `ca.enabled` + `ca.caCert` (inline PEM) or `ca.existingConfigMap`
  (+ `ca.configMapKey`, `ca.mountPath`); the chart mounts the file and sets the env.

## Multi-tenancy (bots → Synth environments)

A single process serves **N bots**, each bound to its own Synth environment.
The source is `tenants.json`; the path: `--tenants-file` > `GATEWAY_TENANTS_FILE` >
`<secretsDir>/tenants.json` (if it exists). **No file — legacy:** a single
`default` tenant from env/CLI/`secrets/` (state — in the root of `dataDir`).

```json
{ "tenants": [
  { "id": "dev",  "botToken": "111111:DEV_BOT_TOKEN", "synthUrl": "http://127.0.0.1:5000/api/v2",
    "serviceKey": "synth_svc_DEV…", "allowlist": "123456789:ADMIN" },
  { "id": "test", "botToken": "222222:TEST_BOT_TOKEN", "synthUrl": "https://synth.k3s.example/api/v2",
    "serviceKey": "synth_svc_TEST…", "proxyUrl": "http://proxy.example.com:3129", "parseMode": "html" }
] }
```

Each tenant uses its own environment and its own Synth API credentials (`serviceKey`/`apiKey`/
`oidc*`) — a single `synth_svc_…` is not transferred between environments.

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Tenant key: `[a-z0-9][a-z0-9_-]*`, unique |
| `botToken` / `token` | yes (except dry-run) | The tenant's bot token |
| `synthUrl` / `synth.url` | no | Base URL of the tenant environment's API v2 |
| `serviceKey` / `apiKey` | no | Synth API credentials (service-key has priority) |
| `oidcTokenUrl`/`oidcDiscoveryUrl`/`oidcClientId`/`oidcClientSecret`/`oidcScope` | no | OIDC client-credentials |
| `proxyUrl` | no | The tenant's Bot API egress proxy |
| `allowlist` | no | The string `"chatId:ROLE,…"` **or** the object `{"chatId":"ROLE"}` |
| `parseMode` | no | `plain` (default) \| `html` (Markdown → Telegram HTML) \| `markdown` (Bot API 10.1 rich: tables/headings/lists + draft streaming) |
| `unknownAction` | no | `register` \| `hint` \| `reject` |
| `watch` | no | Whether to start the reply watcher (SSE) |
| `pollTimeoutSec` / `requestTimeoutSec` | no | Bot API timeouts, sec |

Rules:

- **Priority:** per-tenant values from the file > global defaults (env/CLI/`secrets/`).
- **Strict validation (fail-fast):** an unknown field, a duplicate/invalid `id`,
  a missing `id`/`botToken` (outside dry-run), broken JSON → a clear startup error.
- **State isolation:** tenants write to `<dataDir>/tenants/<id>`; the legacy
  `default` — to the root of `dataDir`.
- **Shared for the process:** `dataDir`, `host`, `port`, `dryRun`, version.
- **Health (`GET /health`, without auth):** flat fields — an aggregate across tenants,
  `tenants` — the breakdown. `status` = `down` if at least one tenant is `down`;
  `degraded` if at least one is `degraded`; otherwise `ok`.
- **Logs:** the tenant prefix `[gateway][<id>] …`; in legacy — without a prefix.
- The tenants file contains tokens/keys — a **secret**, outside git.

## Sender identity and the unknown policy

AD-089 separates the **chat** (routing — `identity.chatKey`/`threadKey`) and the **person**
(ownership/attribution — `identity.principalId`, in the gateway `tg:<id>`). An event carries
in `payload.from` the set `{ id, username?, firstName?, displayName, isExternal: true }`;
the core derives the author (`@username` → name → `tg:<id>`). For groups `payload.chatId` is
the group id, `payload.from.id` — the specific author. Topic:
`identity.threadKey = thread:telegram:<chatId>:<threadId>`.

`GATEWAY_UNKNOWN_ACTION` — the policy for a sender not matched to a Synth
account ("knownness" is resolved by the **core**; the gateway keeps no registry and generates no codes):

| Value | Behavior |
|---|---|
| `register` (default) | the event is published; the owner/author is decided by the core; linking codes are not shown |
| `hint` | the event is published; if the core returned `identityHint` (a one-time code) — the gateway sends the instruction to enter the code in the Synth UI (**Settings → Profile → Identities**) **only to a private chat**; the bot has no `/link` command (in a group/channel — the `gateway.identity_hint_not_private` log) |
| `reject` | the event is not published, a refusal is sent to the sender |

**Identity linking — only in the Synth UI (claim flow, AD-089).** The code from
`identityHint` is entered by an authenticated person in Synth → Settings → Profile →
Identities (`POST /api/v2/me/identities/claim`) — this is how ownership of an
external identifier is confirmed. The bot has **no** `/link` command: the gateway cannot link a
chat to an account for the user (an unknown command → "Unknown command
/link"). The bot's local commands are `/help`, `/start`, `/status`, `/stop`, `/bind`,
`/unbind`, `/new`.

**Indicator and reply streaming.** While the agent is generating, the watcher keeps the status
"Typing…" (`sendChatAction(typing)` immediately and every ~4 s) and streams content into
a single editable message (edit throttling ~1.5 s, truncation by the Telegram limit
4096); `reasoning` is not streamed. A 60 s idle watchdog turns the indicator off by itself if
there are no events for the session for a long time. The final is `stream.done` (the full text), a cancellation is
`stream.cancelled` ("⏹ Stopped"); the indicator is turned off on the final,
`stream.cancelled`, `stream.error`, an SSE disconnect/reconnect and when the
gateway stops (`stop()`). The `/stop` command interrupts the active agent answer in the chat session
(`POST /sessions/:id/abort`).

**Deduplication and the reply target.** For every answer the core sends both `stream.done`
(the full text) and `message.added` (a UI event with content truncated to 500
characters). `message.added` (assistant) — a **deferred fallback** (3 s grace):
it is delivered only if the stream did not arrive, and `stream.done`/`stream.cancelled` cancel it;
dedup — `stream:<id>` and `message:<sessionId>:<index>` (persistently in
`GatewayStore.sent`). The reply target is fixed **per run**: `dedupKey →
messageId` (the poller when publishing the event) + `stream_id → messageId` (the watcher via
`message.added(user).metadata.dedup_key/stream_id`, the `InboundRegistry`,
limit 200) — the reply goes to the message the agent is answering, not
to the last incoming one; fallback — `SessionRoute.lastInboundMessageId`. Rich-streaming
drafts do not support reply.

**The role in `GATEWAY_ALLOWLIST` is a permission ceiling, not a grant (AD-089).** The role
(`chatId:ROLE`) grants access to the gateway and gates the local `/bind`/`/unbind`/
`/new` commands (`ADMIN`/`LEAD`), and in Synth **narrows** the sender's **profile** roles
(intersection), but does not raise them. An unmatched sender → has no Synth rights
(fail-closed), the chat/session works. The gateway machine account's rights are not
handed out to external senders — this is transport service authentication.

## Rules

- **Do not commit** secrets and **do not print** them to the logs (log only the fact
  "set/not set" and the number of access-list entries).
- In Kubernetes/Helm, secrets go through `existingSecret`/SealedSecret, not in `values.yaml`.
- In Docker — an ro-mount of the secrets directory (`./secrets:/run/secrets:ro`).
