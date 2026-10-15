# Развёртывание Telegram-шлюза

> 🌐 [English](./en/deployment.md) · **Русский**

> Docker, docker compose, Kubernetes и Helm для шлюза `synth-gateway-telegram`.
> Переменные и секреты — [configuration.md](configuration.md); границы шлюза —
> [gateway.md](gateway.md).

## Публикуемые артефакты

Релиз публикуется CI-пайплайном (`.gitverse/workflows/release.yaml`) по тегу
`vX.Y.Z` (или через ручной запуск `workflow_dispatch`):

| Артефакт | Координаты |
|---|---|
| Docker-образ | `gitverse.ru/itphx/synth-gateway-telegram:<version>` (и `:latest`) |
| Helm-чарт | Helm-реестр `https://gitverse.ru/api/packages/itphx/helm`, чарт `synth-gateway-telegram` версии `<version>` |

Реестры публичные: `docker pull` и `helm repo add` аутентификации не требуют.

Установка из опубликованного реестра:

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

Локальная сборка (опубликованный образ — `gitverse.ru/itphx/synth-gateway-telegram`,
см. «Публикуемые артефакты»). Образ собирается из одного пакета (multi-stage:
сборка → тонкий runtime с prod-зависимостями); entrypoint — `node dist/gateway/index.js`.

```bash
docker build -f docker/Dockerfile -t synth-gateway-telegram:latest .
docker run --rm -p 7100:7100 \
  -e SYNTH_URL=http://host.docker.internal:5000/api/v2 \
  -e TELEGRAM_BOT_TOKEN=... -e SYNTH_SERVICE_KEY=... -e GATEWAY_ALLOWLIST=123456789:ADMIN \
  -e GATEWAY_HOST=0.0.0.0 \
  -v "$PWD/data:/var/lib/synth-gateway/data" \
  synth-gateway-telegram:latest
```

Health: `curl -s http://127.0.0.1:7100/health` (без аутентификации).

## docker compose

Сервис + volume для состояния и ro-mount секретов/CA — `docker-compose.yml`,
значения окружения — `.env` (см. `.env.example`).

```bash
cp .env.example .env        # заполните значения
docker compose up --build
```

`SYNTH_URL` — адрес API v2 инстанса Synth; для Synth на хосте используется
`host.docker.internal` (в compose задан `extra_hosts`).

## Kubernetes / Helm

Публикуемый чарт — `charts/synth-gateway-telegram` в этом репозитории (установка
из реестра — раздел «Публикуемые артефакты» выше). Образ
`gitverse.ru/itphx/synth-gateway-telegram` тянется анонимно; секреты — через
существующий Secret (`existingSecret`), состояние — PVC
(`persistence.enabled=true`).

Локальная проверка и установка из исходников (до/без публикации):

```bash
helm lint charts/synth-gateway-telegram
helm template synth-gateway-telegram charts/synth-gateway-telegram

helm upgrade --install synth-gateway-telegram charts/synth-gateway-telegram \
  --namespace synth --create-namespace \
  --set existingSecret=synth-gateway-telegram-secrets
```

Особенности:

- **Стратегия `Recreate` (по умолчанию).** Шлюз — singleton (long-polling
  `getUpdates`): второй под одновременно дал бы `409 Conflict`, поэтому rolling
  недопустим. Переопределяется `--set strategy.type=RollingUpdate` (осознанно).- **PVC** (`persistence.enabled=true`) обязателен: без него смещение long-polling
  теряется при рестарте пода.
- **Сохранение PVC при удалении релиза:** `--set persistence.keepOnUninstall=true` —
  чарт добавляет в манифест PVC аннотацию `helm.sh/resource-policy: keep`, и
  `helm uninstall` оставляет claim. Аннотация задаётся именно через values (в
  манифесте релиза), а не вручную: Helm при удалении фильтрует манифест и
  проставленную вручную на живом объекте аннотацию не видит. Дефолт — `false`.
- **Мультитенантность:** `tenants.json` кладётся в Secret ключом `TENANTS_JSON`;
  чарт монтирует его файлом и выставляет `GATEWAY_TENANTS_FILE`
  (`--set tenantsFile.enabled=true`). Шлюз читает файл **на старте**, поэтому
  чарт добавляет в pod-шаблон аннотацию `checksum/extraObjects` (и
  `checksum/tenantsFile` при включённом файле): `helm upgrade` при изменении
  `extraObjects`/values меняет pod-шаблон и перекатывает под — новый список
  тенантов применяется автоматически, без ручного `kubectl rollout restart`.
  Если Secret тенантов создаётся **вне** `values`/`extraObjects`, перекат
  по-прежнему нужен вручную.
- **Внутренний CA:** `--set ca.enabled=true --set-file ca.caCert=<ca.pem>` либо
  `ca.existingConfigMap`; чарт монтирует файл и выставляет `NODE_EXTRA_CA_CERTS`.
- **Прокси Bot API** приходит только из Secret (ключ `TELEGRAM_PROXY_URL`), не из
  `env:` чарта.
- **Существующий PVC:** `--set persistence.existingClaim=<claim>` — чарт PVC не
  создаёт, а Deployment монтирует указанный claim.
- **Дополнительные манифесты:** `extraObjects` — список произвольных
  Kubernetes-объектов; рендерятся как есть (объекты без `metadata.namespace`
  попадают в namespace релиза).
- **MCP по HTTP — второй контейнер того же пода** (`mcp.enabled`, дефолт `true`):
  `node dist/mcp/index.js --http --host 0.0.0.0 --port 7101`. Тот же образ, тот
  же Secret (envFrom) и тот же PVC; отдельным портом Service (`mcp`, 7101)
  инстанс Synth подключается по `http://<fullname>:7101/mcp/<tenantId>`.
  Требуется токен: ключ `GATEWAY_MCP_TOKEN` в `mcp.tokenSecretName` (или в
  `existingSecret`); без токена контейнер не стартует (fail-fast).
  `mcp.port` должен совпадать с `provides.mcp.port` в `synth.pack`.

Пример Secret — `examples/secret.yaml` (обычный Secret, без Helm-шаблонизации):

```bash
kubectl -n synth apply -f examples/secret.yaml
```

## Авто-установка MCP и скиллов

Шлюз сам регистрирует свои ресурсы в инстансе Synth: hook-Job
(`templates/install-job.yaml`, `post-install,post-upgrade`) запускает
референсный инсталлятор `scripts/install-into-synth.mjs` — он читает
`synth.pack.provides` и **идемпотентно** создаёт/обновляет запись реестра
MCP-серверов и скилл (повторный `helm upgrade` не плодит дубликаты). Контракт
`provides` и три вида аддонов — [gateway.md](gateway.md).

### Values

```yaml
autoInstall:
  enabled: true
  url: "http://synth-backend.synth.svc.cluster.local:5000/api/v2"   # API v2 инстанса Synth
  tenant: "dev"                       # подстановка {tenant} в provides.mcp.path
  installerSecretName: "synth-gateway-telegram-installer"   # Secret с installer-ключом
  installerSecretKey: "token"         # ключ внутри Secret
  mcp: true                           # ставить MCP-сервер (по provides.mcp)
  skills: true                        # ставить скиллы (по provides.skills)
  image: ""                           # пусто — образ чарта (synth.pack/skills/scripts внутри)
  backoffLimit: 3
  # — служебное —
  scriptPath: "scripts/install-into-synth.mjs"  # путь к инсталлятору в образе
  scriptConfigMap: ""                 # аддон без образа: ConfigMap с install-into-synth.mjs
  mcpUrl: ""                          # явный URL MCP (иначе собирается из provides.mcp + mcp.port)
  skillsFromConfigMap:                # аддон без образа: файлы скиллов в values
    enabled: false
    files: {}

mcp:
  enabled: true        # контейнер MCP + порт Service
  port: 7101
  tokenSecret:
    create: true       # чарт сам создаёт Secret с токеном (стабилен при upgrade)
    name: ""           # пусто → mcp.tokenSecretName, иначе <fullname>-mcp-token
    key: GATEWAY_MCP_TOKEN
  tokenSecretName: ""  # когда create=false: имя СУЩЕСТВУЮЩЕГО Secret с токеном
  tokenSecretKey: GATEWAY_MCP_TOKEN
```

Установка с авто-установкой ресурсов:

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

### Токен MCP и авторизация записи реестра

MCP-эндпоинт шлюза защищён bearer-токеном, и **Synth-MCP-клиент тоже должен
им авторизоваться** — иначе подключение к `/mcp/<tenant>` получит 401. Поэтому
ядро пробрасывает `headers` из записи реестра, а инсталлятор кладёт туда
`Authorization: Bearer <токен>`.

Источник токена (приоритет):

| Вариант | Как включить | Что происходит |
|---|---|---|
| **чарт создаёт токен** | `mcp.tokenSecret.create=true` | Secret `<fullname>-mcp-token` (ключ `GATEWAY_MCP_TOKEN`) со значением `synth_<43 симв.>`; значение **переиспользуется при `helm upgrade`** (`lookup`) и не удаляется при `helm uninstall` (`helm.sh/resource-policy: keep`) |
| **свой существующий Secret** | `mcp.tokenSecretName=<secret>` (`mcp.tokenSecretKey`) | токен берётся из указанного Secret/ключа (kubectl/SealedSecret/внешний секрет-менеджер) |
| **ключ в `existingSecret`** | `existingSecret=<secret>` с ключом `GATEWAY_MCP_TOKEN` | токен подхватывается через `envFrom`; в hook-Job не пробрасывается (ключ не адресуется явно) |

Токен попадает:

1. в контейнер `mcp` — env `GATEWAY_MCP_TOKEN` (при `create=true`/`tokenSecretName`
   через `secretKeyRef`: значение всегда из нужного ключа, приоритетнее `envFrom`);
2. в **hook-Job** — env `SYNTH_MCP_TOKEN` из того же Secret → инсталлятор пишет
   `config.headers.Authorization` при создании/обновлении записи реестра
   (`POST /mcp/registry`, `PUT /mcp/registry/:id`, `PUT /mcp/servers/:name`).

Значение токена не хранится в `values` и не печатается в логах Job'а; вне
кластера (`helm template`) `lookup` ничего не находит, поэтому при рендере токен
генерируется заново — это нормально, рендер не применяется.

Проверка токена и заголовка записи:

```bash
# токен, который использует контейнер MCP (значение — секрет, не коммитить)
kubectl -n synth get secret synth-gateway-telegram-mcp-token \
  -o jsonpath='{.data.GATEWAY_MCP_TOKEN}' | base64 -d; echo

# токен не меняется при upgrade (lookup видит существующий Secret)
helm upgrade synth-gateway-telegram charts/synth-gateway-telegram -n synth --reuse-values
kubectl -n synth get secret synth-gateway-telegram-mcp-token -o jsonpath='{.metadata.resourceVersion}'; echo

# в записи реестра есть headers.Authorization (ADMIN-ключом инстанса)
curl -s -H "Authorization: Bearer <ADMIN-ключ>" \
  http://synth-backend.synth.svc.cluster.local:5000/api/v2/mcp/registry | grep -o 'Authorization[^,]*'
```

Ротация: удалите Secret и выполните `helm upgrade` — чарт создаст Secret с новым
токеном, а `post-upgrade` Job обновит запись реестра (иначе Synth-MCP-клиент
какое-то время получал бы 401).

### Installer-ключ (Secret)

Токен **не хранится в values** — только имя Secret и ключ в нём; Job подставляет
его через `secretKeyRef` в env `SYNTH_INSTALL_TOKEN` и не печатает в логи.
Пример манифеста — `examples/installer-secret.yaml`:

```bash
kubectl -n synth create secret generic synth-gateway-telegram-installer \
  --from-literal=token='synth_svc_…'
```

Что за ключ: scoped-ключ инстанса (AD-052) для машинной установки ресурсов.
Целевой скоуп — `addons:install` (в ядре добавляется параллельно); пока его нет,
MCP-реестр `PUT`/скиллы в managed гейтятся ролью `ADMIN` — выдайте installer-ключу
роль `ADMIN` (или используйте `SYNTH_API_KEY` инстанса) и сузьте права, когда
скоуп появится.

### Проверка результата

```bash
kubectl -n synth get job synth-gateway-telegram-install
kubectl -n synth logs job/synth-gateway-telegram-install     # [install] … (токен не печатается)

# в инстансе Synth (ключом с правами чтения):
curl -s -H "Authorization: Bearer <ключ>" http://synth-backend:5000/api/v2/mcp/registry
curl -s -H "Authorization: Bearer <ключ>" http://synth-backend:5000/api/v2/skills
```

Ожидаемый лог Job (managed, полный набор):

```text
[install] dry-run: реальные изменения не выполняются          # только с --dry-run
[install] MCP synth-gateway-telegram → http://synth-gateway-telegram.synth.svc.cluster.local:7101/mcp/dev: created
[install] скилл gateway-telegram: created
[install] готово: MCP: created (…/mcp/dev); скилл gateway-telegram: created
```

Локальная проверка инсталлятора без кластера:

```bash
# план (ничего не меняет)
node scripts/install-into-synth.mjs --synth-url http://127.0.0.1:5000/api/v2 \
  --token "$SYNTH_INSTALL_TOKEN" --mcp-token "$SYNTH_MCP_TOKEN" \
  --tenant dev --service-host 127.0.0.1 --dry-run

# standalone: merge mcp.servers в config.yaml + скиллы в {data-dir}/skills
node scripts/install-into-synth.mjs --config ~/.config/synth/config.yaml \
  --data-dir ~/.local/share/synth/data --service-host 127.0.0.1 --tenant dev
```

Инсталлятор принимает `--mcp-token`/`SYNTH_MCP_TOKEN` (bearer MCP-клиентов →
`config.headers.Authorization` записи реестра) и по умолчанию ставит
`enabledByDefault: true` (новые проекты подхватывают сервер; снять —
`--no-enabled-by-default`). Токены в логи не печатаются.

`helm uninstall` удаляет hook-Job, но уже установленные в Synth ресурсы (запись
MCP-реестра, скилл) остаются — это данные инстанса, а не релиза.

## Проверка конфигурации чарта

```bash
# legacy (single-tenant): env GATEWAY_TENANTS_FILE отсутствует
helm template x charts/synth-gateway-telegram | grep -c GATEWAY_TENANTS_FILE   # 0

# multi-tenant: файл подключён
helm template x charts/synth-gateway-telegram \
  --set existingSecret=synth-gateway-telegram-secrets --set tenantsFile.enabled=true \
  | grep -A2 GATEWAY_TENANTS_FILE        # → value: "/etc/gateway/tenants.json"

# чек-сумма pod-шаблона (перекат пода при изменении extraObjects/tenantsFile)
helm template x charts/synth-gateway-telegram \
  --set existingSecret=synth-gateway-telegram-secrets --set tenantsFile.enabled=true \
  | grep -A4 'checksum/extraObjects'      # → spec.template.metadata.annotations

# MCP-контейнер и порт Service
helm template x charts/synth-gateway-telegram --set existingSecret=s \
  | grep -cE 'containerPort: 7101|name: mcp'              # → 4 (контейнер, порт, Service, пробы)
helm template x charts/synth-gateway-telegram --set existingSecret=s --set mcp.enabled=false \
  | grep -c 'containerPort: 7101'                          # → 0

# hook-Job авто-установки (off по умолчанию / on)
helm template x charts/synth-gateway-telegram --set existingSecret=s | grep -c 'kind: Job'   # → 0
helm template x charts/synth-gateway-telegram --set existingSecret=s \
  --set autoInstall.enabled=true --set autoInstall.url=http://synth-backend:5000/api/v2 \
  --set autoInstall.tenant=dev --set autoInstall.installerSecretName=installer \
  | grep -A6 'helm.sh/hook'                                # → post-install,post-upgrade
```
