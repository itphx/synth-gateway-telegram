# synth-gateway-telegram

> 🌐 **English** · [Russian](./README.md)
> This is the public GitHub mirror — development happens on [GitVerse](https://gitverse.ru/itphx/synth-gateway-telegram); see [CONTRIBUTING.md](./CONTRIBUTING.md).

**Telegram gateway** — an external bridge service (**Gateway**) of the
[Synth](https://gitverse.ru/itphx/synth) agent platform: a bridge between a Telegram
bot and the external-event platform (AD-089). The gateway receives bot updates
(long-polling), normalizes them into Synth external events and publishes them to
`POST /api/v2/events`, and delivers the agent's answers back to the chat over SSE.

## What it is and what it is not

- ✅ **Gateway** — an external bridge service with its own repository, images and deploy;
  it talks to Synth only through public contracts (API v2, MCP, external events).
- ❌ **Not a plugin**: it is not mounted into the core process and has no Extension API
  extension points (AD-090). The terminology is strict — Plugin ≠ Gateway ≠ Add-on ≠ Declarative.
- ❌ **No LLM is pulled into the service**: understanding and generation are done by the
  Synth engine; the gateway only deterministically transports events.

Rationale and boundaries — [docs/en/gateway.md](docs/en/gateway.md).

## Data flow

```text
Telegram Bot API                 synth-gateway-telegram                    Synth API v2
   getUpdates  ──long-polling──▶  poller ──normalize──▶ SynthEventsClient ──▶ POST /events
                                  │   └─ /help /bind … ──▶ reply to chat         │
                                  │                            Event/Binding/Router in core
                                  │      SSE GET /events ◀── session events      │
                                  └◀── watcher ── stream.chunk/done/cancelled ──┘
                                          └──▶ "Typing…" + streaming reply to chat
                                  └── offset / seen / chatSessions / routes / sent ── FileStore
```

The reply-sending mode is `parseMode` (`plain` \| `html` \| `markdown`). `markdown`
uses Bot API 10.1 "Rich Messages": native tables/headings/lists and
streaming the reply as a draft in private chats; details and fallbacks —
[docs/en/configuration.md](docs/en/configuration.md) §"Reply-sending modes".

Answer-delivery capabilities (briefly):

- **Streaming** — the agent's answer appears and is edited right in the chat (live
  message; in `markdown` — as an ephemeral rich draft, private chats only).
- **"Typing…"** — the `typing` status immediately and every 4 s while the stream is
  active (a 60 s idle watchdog turns the indicator off).
- **`/stop`** — interrupts the active agent answer in the chat session
  (`POST /sessions/:id/abort`); the answer is marked "⏹ Stopped".
- **Rich tables** — `parseMode: markdown` renders native Bot API 10.1 tables;
  the regular `parse_mode: Markdown`/`MarkdownV2` **cannot** do tables (rich is required).
- **Reply to the source** — the answer comes as a reply to the message the agent is
  answering, not to the last incoming one (even if new messages arrived during
  generation).

## MCP for the agent

The gateway exposes `tg_*` tools to the agent (send/edit/delete, `tg_notify`,
`tg_send_buttons`, `tg_get_me`, `tg_status` and **`tg_send_to_user`** — a message to a
specific Synth user by `user`/`principalId`/`chatId`).

Two transports:

| Transport | When | Launch |
|---|---|---|
| **stdio** (bin `synth-gateway-tg`) | local dev, the engine spawns the process | `node dist/mcp/index.js` |
| **Streamable HTTP** (`--http`) | cluster/K3s (the engine does not spawn the gateway process) | `node dist/mcp/index.js --http --port 7101` |

HTTP mode: path `/mcp/<tenantId>` (tenants — from `tenants.json`, unknown →
404), `GET /health` without auth, everything else — `Authorization: Bearer
<GATEWAY_MCP_TOKEN>` (secret from env/`secrets/mcp_token`). In the Helm chart this is
the second container of the same pod (port 7101) — see [docs/en/deployment.md](docs/en/deployment.md).

## MCP and skills auto-install

`synth.pack` describes the **`provides`** section (MCP server + skills), and
`scripts/install-into-synth.mjs` **idempotently** registers them in the instance:
managed — through API v2 (`/mcp/registry`, `/skills*`), standalone — merges
`mcp.servers` into `config.yaml` + copies skills to `{dataDir}/skills`.
In a cluster the chart's hook Job does this (`autoInstall`, `post-install,post-upgrade`),
the token — from a Secret and never reaches the logs; the chart can create the MCP-client
token itself (`mcp.tokenSecret.create=true`, stable across `helm upgrade`) and passes it
into the registry entry as `Authorization: Bearer …` (otherwise the Synth MCP client gets 401).

```bash
# install plan (no changes)
node scripts/install-into-synth.mjs --synth-url http://127.0.0.1:5000/api/v2 \
  --token "$SYNTH_INSTALL_TOKEN" --mcp-token "$SYNTH_MCP_TOKEN" \
  --tenant dev --service-host 127.0.0.1 --dry-run
```

The `provides` contract, three gateway configuration kinds and HTTP-MCP — [docs/en/gateway.md](docs/en/gateway.md);
values, Secret and verification — [docs/en/deployment.md](docs/en/deployment.md) §"MCP and skills
auto-install".

## Quick start

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test

# Daemon: health server + long-polling + agent-reply watcher
node dist/gateway/index.js

# Dry-run without a token (one getUpdates pass, no network calls)
node dist/gateway/index.js --dry-run --once

curl -s http://127.0.0.1:7100/health

# MCP server (stdio) for the agent
node dist/mcp/index.js --help
```

Docker / docker compose:

```bash
cp .env.example .env && docker compose up --build
```

The complete configuration reference (variables, CLI flags, secrets, authentication
modes, proxy, CA, multi-tenancy) — **[docs/en/configuration.md](docs/en/configuration.md)**.

## Synth API authentication

Priority (`src/gateway/auth.ts`): **service-key → OIDC → api-key → no auth**.

- **Scoped service-key (recommended).** `SYNTH_SERVICE_KEY` (`synth_svc_…`,
  AD-052) — machine authentication limited by `scopes` and the
  `allowedProjects` projection. The minimum for the end-to-end loop (event ingestion + reverse
  watch-all SSE delivery): scopes `events:ingest`, `events:watch`; role —
  `LEAD` (for `/bind` commands). The backend grants watch-all to the service-key itself by
  scope `events:watch` — admin rights are not needed.
- **OIDC (fallback).** `SYNTH_OIDC_*` (client-credentials) works, but for
  reverse delivery (watch-all SSE `GET /events`) it requires the gateway
  client's service account in Keycloak to have the **realm role** `lead`/`admin`:
  the backend reads realm roles, but not the client's client roles.
- **Legacy.** `SYNTH_API_KEY` — standalone/dev, if service-key and OIDC are not set.

Details and examples — [docs/en/configuration.md](docs/en/configuration.md) §"Synth API authentication".

## Structure

```text
synth-gateway-telegram/
├── synth.pack       # gateway manifest (kind/host/contracts) + `provides` (mcp, skills)
├── src/
│   ├── gateway/     # service synth-gateway-telegram (bin): poller, normalization, ingest, watcher, health
│   │                #   markdown.ts — Markdown → Telegram HTML; inbound.ts — InboundRegistry (reply target)
│   ├── mcp/         # MCP server synth-gateway-tg (bin): stdio and HTTP (http.ts)
│   │                #   http.ts — Streamable HTTP, /mcp/<tenant>, bearer auth; user-lookup.ts — tg_send_to_user
│   ├── installer/   # install.ts — resource installer logic (managed/standalone, idempotent)
│   └── bot-api/     # Telegram Bot API client (fetch + proxy)
├── scripts/         # install-into-synth.mjs (installer wrapper) + release helpers
├── charts/synth-gateway-telegram/    # Helm chart (MCP container, auto-install hook Job)
├── docker/ · docker-compose.yml · .env.example
├── examples/        # example Secrets (service, installer key) and tenants.json
├── docs/            # configuration.md · deployment.md · gateway.md
├── skills/gateway-telegram/SKILL.md  # AD-046 skill for the agent
└── .gitverse/workflows/  # ci.yaml (push/PR) · release.yaml (Docker + Helm + Release on tag v*)
```

## Commands

| Command | Action |
|---|---|
| `pnpm build` | build (`tsc` → `dist/`) |
| `pnpm typecheck` | type check |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
| `pnpm clean` | clean `dist/` |

## Deployment

- Docker / compose / Kubernetes / Helm — [docs/en/deployment.md](docs/en/deployment.md).
- Published Helm chart — `charts/synth-gateway-telegram`.
- Published artifacts (on tag `v*`): the image
  `gitverse.ru/itphx/synth-gateway-telegram:<version>`, the chart
  `synth/synth-gateway-telegram` from the registry
  `https://gitverse.ru/api/packages/itphx/helm` — see [docs/en/deployment.md](docs/en/deployment.md).

## License

MIT — see [LICENSE](LICENSE).
