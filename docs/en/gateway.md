# Synth Gateway: boundaries and rationale

> 🌐 **English** · [Russian](../gateway.md)

> A brief summary. The full architecture decisions are in the main Synth repository:
> <https://gitverse.ru/itphx/synth> — AD-087 "Gateways", AD-089
> (external events), AD-090 (Plugin ≠ Gateway ≠ Add-on ≠ Declarative),
> AD-052 (service-key/scopes).
> This repository is the implementation of the platform's first **Gateway**, the Telegram gateway.

## Synth extension classes

**Gateway** is a **separate** class of Synth extension (**not** an add-on): an external
bridge service that connects Synth with the outside world (messengers, channels, transport)
through **public contracts** — API v2, MCP and external events (AD-089). The classes
are strictly separated (AD-090) and do not mix:

| Class | What runs | Carrier | Example |
|---|---|---|---|
| **Plugin** | code **in the core process** | a JS bundle via the Extension API | an in-process core extension |
| **Gateway** | an **external bridge service** in its own process | image + compose/Helm | `synth-gateway-telegram` (this repository) |
| **Add-on** | an **external service for another purpose** in its own process | image + compose/Helm | helper/integration |
| **Content pack** | nothing (data) | content files (skills, agents, MCP servers, routes) | `kind: "pack"` + `packType` (see AD-090) |

The single manifest of all classes is **`synth.pack`** in the repository root; the class is set
by the `kind` field (`plugin` | `gateway` | `addon` | `pack`).

## Telegram gateway boundaries

- ✅ an external service: long-polling Telegram → normalization → `POST /api/v2/events`;
  reverse delivery of the agent's answers over SSE;
- ✅ **exposes MCP to the agent** (stdio locally, Streamable HTTP in a cluster) and
  **installs its own MCP/skills** into the instance (the chart's hook Job);
- ❌ not a plugin: it is not mounted into the core process and has no Extension API
  extension points (hooks, `ToolRegistry`, `ProviderFactory`, UI slots);
- ❌ no direct access to the core internals (`FileStore`, `GatewayProvider`, sessions
  bypassing the API);
- ⚠️ **no LLM is pulled into the service**: understanding/generation is done by the Synth
  engine; the gateway is a deterministic event transport.

## Integration points

- **API v2** (`/api/v2`): `POST /events`, `GET /events` (SSE), `/events/bindings*`,
  `/sessions*`, `/users*` (for `tg_send_to_user`), `/mcp/registry`, `/skills*`
  (installer); authentication — a scoped service-key `synth_svc_…` (AD-052).
- **MCP**: `tg_*` tools for the agent; the namespace in Synth is
  `synth-gateway-telegram_<tool>`. Transports:
  - **stdio** (bin `synth-gateway-tg`) — local launch by the engine;
  - **Streamable HTTP** (`--http`) — path `/mcp/<tenantId>`, port 7101;
    it is exactly this that is used in K3s (the engine does not spawn the gateway process).
    The transport is **stateless** (there are no MCP sessions, `mcp-session-id` is not issued and
    is ignored): the gateway tools are independent, and a pod restart does not break
    already-connected Synth clients.
- **External events** (AD-089): the body `{ source, type, payload, identity, dedupKey }`;
  a stable `dedupKey` is required.

Configuration details — [configuration.md](configuration.md), deployment —
[deployment.md](deployment.md).

## The `provides` manifest (`synth.pack`)

The `synth.pack` manifest describes compatibility (`name`/`version`/`kind: "gateway"`/
`host`/`contracts`) and the **`provides`** section — which resources the gateway exposes
to the Synth instance. `{tenant}` is a placeholder substituted by the installer
(`--tenant`).

```json
{
  "name": "@itphx/synth-gateway-telegram",
  "version": "0.3.0",
  "kind": "gateway",
  "host": "^0.9.0",
  "contracts": { "apiV2": "^2", "events": "^1", "mcp": "^1" },
  "provides": {
    "mcp": {
      "name": "synth-gateway-telegram",
      "transport": "http",
      "port": 7101,
      "path": "/mcp/{tenant}",
      "description": "Telegram gateway: tg_* tools"
    },
    "skills": [{ "name": "gateway-telegram", "path": "skills/gateway-telegram" }]
  }
}
```

| Field | Meaning |
|---|---|
| `provides.mcp.name` | the name of the entry in the Synth MCP-server registry (AD-071); the tools appear as `<name>_<tool>` |
| `provides.mcp.transport` | the MCP transport: `http` (Streamable HTTP) |
| `provides.mcp.port` | the MCP server port; the chart builds the auto-install URL from it |
| `provides.mcp.path` | the endpoint path with the `{tenant}` placeholder |
| `provides.skills[].name` | the skill name (AD-046) |
| `provides.skills[].path` | the skill directory in the repository (`SKILL.md` + supporting files) |

## HTTP-MCP (`src/mcp/http.ts`)

- **Multi-tenancy.** The path `/mcp/<tenantId>`: the tool context (bot token,
  proxy, dataDir, synthUrl/serviceKey) is taken from `tenants.json` of **that**
  tenant — by the same loader as the gateway service. An unknown tenant → `404`.
  Everything on one port (by default **7101**).
- **Auth.** A bearer token from the `GATEWAY_MCP_TOKEN` env or `secrets/mcp_token`;
  missing/invalid → `401`. The token is a chart/Secret parameter, is not stored in git
  and does not reach the logs. Comparison — in constant time (`timingSafeEqual`).
- **`GET /health`** — without authentication (deploy probes): `{status, version,
  transport, tenants}`.
- **Backward compatibility.** Without `--http` the server works over stdio (as before).

Example request:

```bash
curl -s http://127.0.0.1:7101/health
curl -s -X POST http://127.0.0.1:7101/mcp/dev \
  -H 'authorization: Bearer <GATEWAY_MCP_TOKEN>' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

## Resource auto-install (`provides` → instance)

The gateway registers its resources in the instance itself — the reference installer
`scripts/install-into-synth.mjs` (the logic is in `src/installer/install.ts`) reads
`synth.pack.provides` and works in two modes:

| Mode | How it is enabled | What it does |
|---|---|---|
| **managed** | `--synth-url` + `--token` (env `SYNTH_INSTALL_TOKEN`) | MCP: `POST /mcp/registry` (a repeat/409 → `PUT /mcp/registry/:id` or `PUT /mcp/servers/:name`); skills: `POST /skills` (409 → `PATCH /skills/:name` + `PUT /skills/:name/files/*`); then `POST /skills/reload` |
| **standalone** | `--config <config.yaml>` + `--data-dir <dir>` | merge `mcp.servers` into config.yaml (atomically); copy the skill directory into `{dataDir}/skills/<name>/`; if the API is available — `POST /skills/reload` |

The installer **does not send** the `origin` field of the registry entry — this is a server detail
(AD-071): the schema allows only `instance|user`, and for an installer key (service-key)
the instance marks the entry as `instance` itself. A client-side value with the gateway
prefix would give `400 invalid_enum_value`.

Arguments: `--synth-url`, `--token`, `--tenant`, `--mcp-url` **or**
`--service-host` (the MCP URL is built as `http://<host>:<provides.mcp.port><path>`),
`--only mcp,skills` (or the `--mcp`/`--skills` flags), `--skills-dir`, `--mcp-token`
(env `SYNTH_MCP_TOKEN`), `--no-enabled-by-default`, `--config`, `--data-dir`,
`--root`, `--dry-run`, `--help`.

The registry entry is created with `enabledByDefault: true` (new projects/sessions
pick up the server; unset with `--no-enabled-by-default`) and, when `--mcp-token` is
set, with `config.headers.Authorization = Bearer <token>` — the core
passes `headers` to the MCP client, so Synth connects to
`/mcp/<tenant>` authorized (without a token the gateway's HTTP-MCP replies 401). The token is not
printed to the logs; in a cluster the chart issues it (Secret) and passes it into the Job as
`SYNTH_MCP_TOKEN`.

**Idempotency is mandatory:** a repeated run (including `helm upgrade`)
updates the entry/skill rather than creating duplicates; on error — a clear message
and a return code ≠ 0 (before any changes it is verified that the install mode for all
selected entities is set). In a cluster the installer is run by the chart's hook Job
(`autoInstall`, see [deployment.md](deployment.md)).

## Three gateway configuration kinds

| Kind | Configuration | What the installer does |
|---|---|---|
| **service + MCP + skills** | `mcp.enabled=true`, `autoInstall.enabled=true`, `autoInstall.mcp=true`, `autoInstall.skills=true` | starts the second MCP container (port 7101), registers the MCP server and the skill |
| **MCP only** (the agent calls tools, the chat is not connected) | `autoInstall.enabled=true`, `autoInstall.mcp=true`, `autoInstall.skills=false` | registers only the MCP registry entry |
| **skills only** (instructions for the agent without starting the service) | `mcp.enabled=false`, `autoInstall.enabled=true`, `autoInstall.mcp=false`, `autoInstall.skills=true` | installs only the skill |

For configurations **without an image**, `autoInstall.image` (an image with node) +
`autoInstall.scriptConfigMap` (a ConfigMap with `install-into-synth.mjs`) +
`autoInstall.skillsFromConfigMap` (skill files in values) are provided.

## Compatibility

The `synth.pack` manifest in the root fixes `name`/`version`/`kind: "gateway"`/`host` and
the contract ranges `apiV2`/`events`/`mcp` (semver). `host` and `contracts`
are checked when connecting to a Synth instance.
