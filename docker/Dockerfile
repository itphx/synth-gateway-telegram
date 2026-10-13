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

# JSON-хранилище (offset/дедуп/привязки чатов; монтируется volume'ом).
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=7100
ENV GATEWAY_DATA_DIR=/var/lib/synth-gateway/data

VOLUME ["/var/lib/synth-gateway/data"]
EXPOSE 7100

ENTRYPOINT ["node", "dist/gateway/index.js"]
