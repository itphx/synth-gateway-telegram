# ============================================================================
# Образ Telegram-шлюза Synth (add-on).
# Multi-stage: сборка одного пакета → тонкий runtime с prod-зависимостями.
# Базовый образ — node:22-alpine (как у прочих сервисов Synth).
# ============================================================================

# --- Этап 1: сборка ---
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /src

# Сначала манифесты — слой установки зависимостей кэшируется при правках кода.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# tsconfig + исходники и сборка (tsc → dist/).
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# --- Этап 2: runtime ---
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

ENV NODE_ENV=production
WORKDIR /app

# Только prod-зависимости пакета.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Собранный код сервиса.
COPY --from=builder /src/dist ./dist

# Артефакты авто-установки (hook-Job чарта `autoInstall`): манифест `provides`,
# референсный инсталлятор и скиллы. Нужны образу, даже когда сервис не запускается
# (аддон «только MCP/скиллы»): `node scripts/install-into-synth.mjs …`.
COPY addon.json ./
COPY scripts/install-into-synth.mjs ./scripts/
COPY skills ./skills

# Права в образе не должны зависеть от режимов в git/чек-ауте: в рабочей копии
# файлы могут иметь групповой режим (`-rw-rw----`, каталоги `drwxrws---` —
# umask 002 / setgid-каталоги), а `COPY` сохраняет права как есть. Тогда под
# (uid 1000, не root) не читает их → `EACCES open '/app/scripts/install-into-synth.mjs'`
# в hook-Job. Даём всем на чтение (`a+r`) и на обход каталогов (`X` — только
# каталоги/уже исполняемые файлы); владелец остаётся root, uid 1000 хватает
# прав на чтение. `dist` — из builder-стадии (там права зависят от umask сборки).
RUN chmod -R a+rX /app/addon.json /app/skills /app/scripts /app/dist \
 && chmod a+r /app/package.json /app/pnpm-lock.yaml

# JSON-хранилище (offset/дедуп/привязки чатов; монтируется volume'ом).
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=7100
ENV GATEWAY_DATA_DIR=/var/lib/synth-gateway/data

VOLUME ["/var/lib/synth-gateway/data"]
EXPOSE 7100

ENTRYPOINT ["node", "dist/gateway/index.js"]
