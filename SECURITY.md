# Security Policy

We take the security of Synth gateways seriously. Thank you for helping keep the
project and its users safe.

A Russian version of this document is available: [SECURITY.ru.md](./SECURITY.ru.md).

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Report privately:

- Email: **admin@itphx.ru**
- Telegram: <https://t.me/synth_dev_admin>

If possible, encrypt or otherwise limit distribution of any exploit details until
a fix is available.

## What to include

To help us triage quickly, please provide:

- **Add-on version** (`version` in `package.json` / `synth.pack`, or the git tag —
  for example `v0.3.2`).
- **Synth version** the gateway was used with.
- **Environment** — OS, deployment method (Docker / Helm / `synth.pack`
  auto-install), Node.js version, and relevant configuration (redact secrets).
- **Steps to reproduce** — a minimal sequence that triggers the issue.
- **Proof of concept** — logs, requests, or a small script where possible.
- **Impact** — what an attacker could achieve.

## Response timeline

These are **best-effort** targets for a small maintainer team:

| Stage | Target |
|---|---|
| Acknowledgement of the report | within **72 hours** |
| Initial assessment and severity triage | within **7 days** |
| Fix or mitigation | as soon as practical, coordinated with you |

We will keep you informed of progress and credit you in the release notes unless
you prefer to remain anonymous.

## Scope

**In scope:**

- Code in this repository (`src/`, scripts, Docker and Helm assets).
- The gateway's integration surface: inbound update handling, authentication of
  the Synth ⇄ gateway channel (binding/service keys, MCP HTTP bearer auth),
  secret handling, input validation, and misconfiguration that leads to a
  security impact.

**Out of scope:**

- Vulnerabilities in the **Telegram Bot API or the Telegram platform** itself —
  report those to Telegram.
- Vulnerabilities in **third-party services or dependencies** — report them to
  the upstream project; we will still update the dependency once a fix is
  released.
- Vulnerabilities in the **Synth core** itself — report those to the main
  repository instead: <https://gitverse.ru/itphx/synth>.
- Issues that require an already-compromised host, or that stem purely from
  intentional misconfiguration (for example, exposing the service publicly when
  the documentation says not to).
- Social engineering, physical access, and denial-of-service by resource
  exhaustion on self-hosted deployments.

## Secrets policy

- Secrets must **never** be committed: the **Telegram bot token**, Synth
  **service keys** / API keys, OIDC client secret, MCP bearer token, and
  `tenants.json` (which carries `serviceKey` values). `secrets/` and `certs/` are
  git-ignored; see [CONTRIBUTING.md](./CONTRIBUTING.md).
- Example manifests under `examples/` (`secret.yaml`, `installer-secret.yaml`,
  `tenants.json.example`) contain **placeholders only** (for example
  `REPLACE_ME`) and must never hold real values.
- If you believe a secret was committed by accident, treat it as compromised:
  rotate the bot token via BotFather, revoke the affected Synth key, and notify us
  at the contacts above.
