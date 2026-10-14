# Развёртывание Telegram-шлюза

> Docker, docker compose, Kubernetes и Helm для add-on'а `synth-gateway-telegram`.
> Переменные и секреты — [configuration.md](configuration.md); границы add-on'а —
> [addon.md](addon.md).

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
  недопустим. Переопределяется `--set strategy.type=RollingUpdate` (осознанно).
- **PVC** (`persistence.enabled=true`) обязателен: без него смещение long-polling
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

Пример Secret — `examples/secret.yaml` (обычный Secret, без Helm-шаблонизации):

```bash
kubectl -n synth apply -f examples/secret.yaml
```

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
```
