# Telegram gateway deployment

> 🌐 **English** · [Russian](../deployment.md)

> Docker, docker compose, Kubernetes and Helm for the `synth-gateway-telegram` gateway.
> Variables and secrets — [configuration.md](configuration.md); gateway boundaries —
> [gateway.md](gateway.md).

## Published artifacts

A release is published by the CI pipeline (`.gitverse/workflows/release.yaml`) on tag
`vX.Y.Z` (or via a manual `workflow_dispatch` run):

| Artifact | Coordinates |
|---|---|
| Docker image | `gitverse.ru/itphx/synth-gateway-telegram:<version>` (and `:latest`) |
| Helm chart | Helm registry `https://gitverse.ru/api/packages/itphx/helm`, chart `synth-gateway-telegram` version `<version>` |

The registries are public: `docker pull` and `helm repo add` require no authentication.

Installing from the published registry:

```bash
helm repo add synth https://gitverse.ru/api/packages/itphx/helm
helm repo update
helm install synth-gateway-telegram synth/synth-gateway-telegram \
  --version <version> \
  --namespace synth --create-namespace \
  --set existingSecret=synth-gateway-telegram-secrets

docker pull gitverse.ru/itphx/synth-gateway-telegram:<version>
```

## Docker

Local build (the published image is `gitverse.ru/itphx/synth-gateway-telegram`,
see "Published artifacts"). The image is built from a single package (multi-stage:
build → a thin runtime with prod dependencies); the entrypoint is `node dist/gateway/index.js`.

```bash
docker build -f docker/Dockerfile -t synth-gateway-telegram:latest .
docker run --rm -p 7100:7100 \
  -e SYNTH_URL=http://host.docker.internal:5000/api/v2 \
  -e TELEGRAM_BOT_TOKEN=... -e SYNTH_SERVICE_KEY=... -e GATEWAY_ALLOWLIST=123456789:ADMIN \
  -e GATEWAY_HOST=0.0.0.0 \
  -v "$PWD/data:/var/lib/synth-gateway/data" \
  synth-gateway-telegram:latest
```

Health: `curl -s http://127.0.0.1:7100/health` (no authentication).

## docker compose

The service + a volume for state and an ro-mount of secrets/CA — `docker-compose.yml`,
environment values — `.env` (see `.env.example`).

```bash
cp .env.example .env        # fill in the values
docker compose up --build
```

`SYNTH_URL` — the API v2 address of the Synth instance; for a Synth on the host,
`host.docker.internal` is used (in compose `extra_hosts` is set).

## Kubernetes / Helm

The published chart — `charts/synth-gateway-telegram` in this repository (installing
from the registry — the "Published artifacts" section above). The image
`gitverse.ru/itphx/synth-gateway-telegram` is pulled anonymously; secrets — via
an existing Secret (`existingSecret`), state — a PVC
(`persistence.enabled=true`).

Local verification and installation from the sources (before/without publishing):

```bash
helm lint charts/synth-gateway-telegram
helm template synth-gateway-telegram charts/synth-gateway-telegram

helm upgrade --install synth-gateway-telegram charts/synth-gateway-telegram \
  --namespace synth --create-namespace \
  --set existingSecret=synth-gateway-telegram-secrets
```

Specifics:

- **Strategy `Recreate` (default).** The gateway is a singleton (long-polling
  `getUpdates`): a second pod at the same time would give `409 Conflict`, so rolling
  is not allowed. Overridden by `--set strategy.type=RollingUpdate` (deliberately).- **PVC** (`persistence.enabled=true`) is required: without it the long-polling offset
  is lost when the pod restarts.
- **Keeping the PVC on release uninstall:** `--set persistence.keepOnUninstall=true` —
  the chart adds the `helm.sh/resource-policy: keep` annotation to the PVC manifest, and
  `helm uninstall` keeps the claim. The annotation is set via values (in the
  release manifest), not manually: on uninstall Helm filters the manifest and
  does not see an annotation put manually on a live object. Default — `false`.
- **Multi-tenancy:** `tenants.json` is put into a Secret under the `TENANTS_JSON` key;
  the chart mounts it as a file and sets `GATEWAY_TENANTS_FILE`
  (`--set tenantsFile.enabled=true`). The gateway reads the file **at startup**, so
  the chart adds the `checksum/extraObjects` annotation to the pod template (and
  `checksum/tenantsFile` when the file is enabled): `helm upgrade` on a change of
  `extraObjects`/values changes the pod template and rolls the pod — the new tenant list
  is applied automatically, without a manual `kubectl rollout restart`.
  If the tenants Secret is created **outside** `values`/`extraObjects`, the rollout
  is still needed manually.
- **Internal CA:** `--set ca.enabled=true --set-file ca.caCert=<ca.pem>` or
  `ca.existingConfigMap`; the chart mounts the file and sets `NODE_EXTRA_CA_CERTS`.
- **The Bot API proxy** comes only from the Secret (key `TELEGRAM_PROXY_URL`), not from
  the chart's `env:`.
- **Existing PVC:** `--set persistence.existingClaim=<claim>` — the chart does not
  create a PVC, and the Deployment mounts the specified claim.
- **Additional manifests:** `extraObjects` — a list of arbitrary
  Kubernetes objects; they are rendered as is (objects without `metadata.namespace`
  land in the release namespace).
- **HTTP MCP — a second container of the same pod** (`mcp.enabled`, default `true`):
  `node dist/mcp/index.js --http --host 0.0.0.0 --port 7101`. The same image, the same
  Secret (envFrom) and the same PVC; through a separate Service port (`mcp`, 7101)
  the Synth instance connects via `http://<fullname>:7101/mcp/<tenantId>`.
  A token is required: the `GATEWAY_MCP_TOKEN` key in `mcp.tokenSecretName` (or in
  `existingSecret`); without a token the container does not start (fail-fast).
  `mcp.port` must match `provides.mcp.port` in `synth.pack`.

Example Secret — `examples/secret.yaml` (a regular Secret, without Helm templating):

```bash
kubectl -n synth apply -f examples/secret.yaml
```

## MCP and skills auto-install

The gateway registers its resources in the Synth instance itself: the hook Job
(`templates/install-job.yaml`, `post-install,post-upgrade`) runs the
reference installer `scripts/install-into-synth.mjs` — it reads
`synth.pack.provides` and **idempotently** creates/updates the registry entry of
the MCP server and the skill (a repeated `helm upgrade` does not create duplicates). The `provides`
contract and the three add-on kinds — [gateway.md](gateway.md).

### Values

```yaml
autoInstall:
  enabled: true
  url: "http://synth-backend.synth.svc.cluster.local:5000/api/v2"   # API v2 of the Synth instance
  tenant: "dev"                       # substitution of {tenant} in provides.mcp.path
  installerSecretName: "synth-gateway-telegram-installer"   # Secret with the installer key
  installerSecretKey: "token"         # the key inside the Secret
  mcp: true                           # install the MCP server (per provides.mcp)
  skills: true                        # install the skills (per provides.skills)
  image: ""                           # empty — the chart image (synth.pack/skills/scripts inside)
  backoffLimit: 3
  # — service —
  scriptPath: "scripts/install-into-synth.mjs"  # path to the installer in the image
  scriptConfigMap: ""                 # add-on without an image: a ConfigMap with install-into-synth.mjs
  mcpUrl: ""                          # explicit MCP URL (otherwise built from provides.mcp + mcp.port)
  skillsFromConfigMap:                # add-on without an image: skill files in values
    enabled: false
    files: {}

mcp:
  enabled: true        # MCP container + Service port
  port: 7101
  tokenSecret:
    create: true       # the chart creates the Secret with the token itself (stable across upgrades)
    name: ""           # empty → mcp.tokenSecretName, otherwise <fullname>-mcp-token
    key: GATEWAY_MCP_TOKEN
  tokenSecretName: ""  # when create=false: the name of an EXISTING Secret with the token
  tokenSecretKey: GATEWAY_MCP_TOKEN
```

Installing with resource auto-install:

```bash
helm upgrade --install synth-gateway-telegram charts/synth-gateway-telegram \
  --namespace synth --create-namespace \
  --set existingSecret=synth-gateway-telegram-secrets \
  --set tenantsFile.enabled=true --set tenantsFile.secretName=synth-gateway-telegram-tenants \
  --set mcp.tokenSecret.create=true \
  --set autoInstall.enabled=true \
  --set autoInstall.url=http://synth-backend.synth.svc.cluster.local:5000/api/v2 \
  --set autoInstall.tenant=dev \
  --set autoInstall.installerSecretName=synth-gateway-telegram-installer
```

### MCP token and registry-entry authorization

The gateway's MCP endpoint is protected by a bearer token, and **the Synth MCP
client must also authorize with it** — otherwise a connection to `/mcp/<tenant>` gets 401. Therefore
the core passes through `headers` from the registry entry, and the installer puts
`Authorization: Bearer <token>` there.

Token source (priority):

| Variant | How to enable | What happens |
|---|---|---|
| **the chart creates the token** | `mcp.tokenSecret.create=true` | Secret `<fullname>-mcp-token` (key `GATEWAY_MCP_TOKEN`) with the value `synth_<43 chars>`; the value is **reused on `helm upgrade`** (`lookup`) and is not deleted on `helm uninstall` (`helm.sh/resource-policy: keep`) |
| **your own existing Secret** | `mcp.tokenSecretName=<secret>` (`mcp.tokenSecretKey`) | the token is taken from the specified Secret/key (kubectl/SealedSecret/an external secret manager) |
| **a key in `existingSecret`** | `existingSecret=<secret>` with the key `GATEWAY_MCP_TOKEN` | the token is picked up via `envFrom`; it is not passed to the hook Job (the key is not addressed explicitly) |

The token goes:

1. into the `mcp` container — env `GATEWAY_MCP_TOKEN` (with `create=true`/`tokenSecretName`
   via `secretKeyRef`: the value always comes from the right key, taking priority over `envFrom`);
2. into the **hook Job** — env `SYNTH_MCP_TOKEN` from the same Secret → the installer writes
   `config.headers.Authorization` when creating/updating the registry entry
   (`POST /mcp/registry`, `PUT /mcp/registry/:id`, `PUT /mcp/servers/:name`).

The token value is not stored in `values` and is not printed in the Job's logs; outside
the cluster (`helm template`), `lookup` finds nothing, so during rendering the token
is generated anew — this is normal, the render is not applied.

Checking the token and the registry entry's header:

```bash
# the token the MCP container uses (the value is a secret, do not commit)
kubectl -n synth get secret synth-gateway-telegram-mcp-token \
  -o jsonpath='{.data.GATEWAY_MCP_TOKEN}' | base64 -d; echo

# the token does not change on upgrade (lookup sees the existing Secret)
helm upgrade synth-gateway-telegram charts/synth-gateway-telegram -n synth --reuse-values
kubectl -n synth get secret synth-gateway-telegram-mcp-token -o jsonpath='{.metadata.resourceVersion}'; echo

# the registry entry has headers.Authorization (with the instance ADMIN key)
curl -s -H "Authorization: Bearer <ADMIN key>" \
  http://synth-backend.synth.svc.cluster.local:5000/api/v2/mcp/registry | grep -o 'Authorization[^,]*'
```

Rotation: delete the Secret and run `helm upgrade` — the chart creates a Secret with a new
token, and the `post-upgrade` Job updates the registry entry (otherwise the Synth MCP client
would get 401 for a while).

### Installer key (Secret)

The token is **not stored in values** — only the Secret name and the key in it; the Job passes
it via `secretKeyRef` into the `SYNTH_INSTALL_TOKEN` env and does not print it to the logs.
Example manifest — `examples/installer-secret.yaml`:

```bash
kubectl -n synth create secret generic synth-gateway-telegram-installer \
  --from-literal=token='synth_svc_…'
```

What the key is: an instance scoped key (AD-052) for machine installation of resources.
The target scope is `addons:install` (added in the core in parallel); while it does not exist,
the MCP registry `PUT`/skills in managed are gated by the `ADMIN` role — grant the installer key
the `ADMIN` role (or use the instance `SYNTH_API_KEY`) and narrow the rights once the
scope appears.

### Verifying the result

```bash
kubectl -n synth get job synth-gateway-telegram-install
kubectl -n synth logs job/synth-gateway-telegram-install     # [install] … (the token is not printed)

# in the Synth instance (with a key that has read permissions):
curl -s -H "Authorization: Bearer <key>" http://synth-backend:5000/api/v2/mcp/registry
curl -s -H "Authorization: Bearer <key>" http://synth-backend:5000/api/v2/skills
```

Expected Job log (managed, full set):

```text
[install] dry-run: no real changes are made          # only with --dry-run
[install] MCP synth-gateway-telegram → http://synth-gateway-telegram.synth.svc.cluster.local:7101/mcp/dev: created
[install] skill gateway-telegram: created
[install] done: MCP: created (…/mcp/dev); skill gateway-telegram: created
```

Local installer check without a cluster:

```bash
# plan (changes nothing)
node scripts/install-into-synth.mjs --synth-url http://127.0.0.1:5000/api/v2 \
  --token "$SYNTH_INSTALL_TOKEN" --mcp-token "$SYNTH_MCP_TOKEN" \
  --tenant dev --service-host 127.0.0.1 --dry-run

# standalone: merge mcp.servers into config.yaml + skills into {data-dir}/skills
node scripts/install-into-synth.mjs --config ~/.config/synth/config.yaml \
  --data-dir ~/.local/share/synth/data --service-host 127.0.0.1 --tenant dev
```

The installer accepts `--mcp-token`/`SYNTH_MCP_TOKEN` (bearer of MCP clients →
`config.headers.Authorization` of the registry entry) and by default sets
`enabledByDefault: true` (new projects pick up the server; unset with
`--no-enabled-by-default`). Tokens are not printed to the logs.

`helm uninstall` deletes the hook Job, but the resources already installed in Synth (the
MCP registry entry, the skill) remain — they are instance data, not release data.

## Verifying the chart configuration

```bash
# legacy (single-tenant): the GATEWAY_TENANTS_FILE env is absent
helm template x charts/synth-gateway-telegram | grep -c GATEWAY_TENANTS_FILE   # 0

# multi-tenant: the file is connected
helm template x charts/synth-gateway-telegram \
  --set existingSecret=synth-gateway-telegram-secrets --set tenantsFile.enabled=true \
  | grep -A2 GATEWAY_TENANTS_FILE        # → value: "/etc/gateway/tenants.json"

# pod template checksum (pod roll on a change of extraObjects/tenantsFile)
helm template x charts/synth-gateway-telegram \
  --set existingSecret=synth-gateway-telegram-secrets --set tenantsFile.enabled=true \
  | grep -A4 'checksum/extraObjects'      # → spec.template.metadata.annotations

# MCP container and Service port
helm template x charts/synth-gateway-telegram --set existingSecret=s \
  | grep -cE 'containerPort: 7101|name: mcp'              # → 4 (container, port, Service, probes)
helm template x charts/synth-gateway-telegram --set existingSecret=s --set mcp.enabled=false \
  | grep -c 'containerPort: 7101'                          # → 0

# auto-install hook Job (off by default / on)
helm template x charts/synth-gateway-telegram --set existingSecret=s | grep -c 'kind: Job'   # → 0
helm template x charts/synth-gateway-telegram --set existingSecret=s \
  --set autoInstall.enabled=true --set autoInstall.url=http://synth-backend:5000/api/v2 \
  --set autoInstall.tenant=dev --set autoInstall.installerSecretName=installer \
  | grep -A6 'helm.sh/hook'                                # → post-install,post-upgrade
```
