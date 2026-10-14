# ============================================================================
# Образ Telegram-шлюза Synth (класс Gateway).
# Multi-stage: сборка одного пакета → тонкий runtime с prod-зависимостями.
# Базовый образ — node:22-alpine (как у прочих сервисов Synth).
#
# Почему prod-зависимости едут чанками из отдельной стадии.
# Слой `pnpm install --prod` в runtime весит ~188 МБ (в сжатом виде ~58 МБ),
# хотя сам `node_modules` занимает ~15 МБ: в слой попадают кэш метаданных pnpm
# (~100 МБ) и скачанный pnpm нативный бинарник (~55 МБ). Реестр GitVerse
# отклоняет загрузку такого blob'а (`PATCH …/blobs/uploads/…` → `413 Request
# Entity Too Large`); базовый слой образа (~53 МБ в сжатом виде) проходит.
# Поэтому prod-зависимости ставятся в отдельной стадии (`deps` — её слои в
# реестр не пушатся), а в runtime переносится только готовый `node_modules`,
# разложенный на несколько небольших COPY-слоёв (тот же приём, что в
# `synth/docker/Dockerfile`). Итог: ~15 МБ зависимостей, разбитые на слои
# ≤ ~5 МБ несжатых вместо одного слоя на 188 МБ.
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

# --- Этап 2: prod-зависимости ---
# Раскладка pnpm: реальные файлы лежат в `node_modules/.pnpm/<pkg>@<ver>/…`,
# а top-level имена пакетов и зависимости внутри `.pnpm` — относительные
# симлинки (`…/.pnpm/<pkg>@<ver>/node_modules/<dep>
#   -> ../../<dep>@<ver>/node_modules/<dep>`), resolution идёт от каталога
# пакета. Поэтому режем чанки только внутри `.pnpm`, а собираем их обратно в
# тот же путь `node_modules/.pnpm/` — взаимное расположение и относительные
# ссылки сохраняются.
FROM node:22-alpine AS deps

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /deps

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Раскладываем записи `.pnpm` по чанкам по первому символу имени (для
# scope-пакетов `@scope+name@ver` — по символу после `@`): каждая группа
# станет отдельным COPY-слоем runtime. Top-level `node_modules` (симлинки
# пакетов, `.modules.yaml`, scope-каталоги, `.bin` если появится) и всё, что не
# попало в диапазоны, уезжают в отдельные чанки — `find` не фильтрует по
# списку имён, так что ничего не теряется.
RUN set -eux; \
    P=/deps/node_modules/.pnpm; \
    T=/deps/node_modules; \
    mkdir -p /chunks/pnpm-1 /chunks/pnpm-2 /chunks/pnpm-3 \
             /chunks/pnpm-4 /chunks/pnpm-5 /chunks/pnpm-6 \
             /chunks/pnpm-rest /chunks/top; \
    find "$P" -mindepth 1 -maxdepth 1 -name '[a-f0-9]*' -exec mv {} /chunks/pnpm-1/ +; \
    find "$P" -mindepth 1 -maxdepth 1 -name '[g-p]*'    -exec mv {} /chunks/pnpm-2/ +; \
    find "$P" -mindepth 1 -maxdepth 1 -name '[q-z]*'    -exec mv {} /chunks/pnpm-3/ +; \
    find "$P" -mindepth 1 -maxdepth 1 -name '@[a-f]*'   -exec mv {} /chunks/pnpm-4/ +; \
    find "$P" -mindepth 1 -maxdepth 1 -name '@[g-p]*'   -exec mv {} /chunks/pnpm-5/ +; \
    find "$P" -mindepth 1 -maxdepth 1 -name '@[q-z]*'   -exec mv {} /chunks/pnpm-6/ +; \
    find "$P" -mindepth 1 -maxdepth 1 -exec mv {} /chunks/pnpm-rest/ +; \
    find "$T" -mindepth 1 -maxdepth 1 ! -name .pnpm -exec mv {} /chunks/top/ +; \
    rmdir "$P"; \
    du -sh /chunks/*

# --- Этап 3: runtime ---
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

ENV NODE_ENV=production
WORKDIR /app

# Манифесты нужны и рантайму: `dist` — ESM, и без `"type": "module"` из
# package.json Node трактует `.js` как CommonJS.
COPY package.json pnpm-lock.yaml ./

# Prod-зависимости: чанки из стадии `deps` — каждый COPY даёт небольшой слой.
COPY --from=deps /chunks/top/ /app/node_modules/
COPY --from=deps /chunks/pnpm-1/ /app/node_modules/.pnpm/
COPY --from=deps /chunks/pnpm-2/ /app/node_modules/.pnpm/
COPY --from=deps /chunks/pnpm-3/ /app/node_modules/.pnpm/
COPY --from=deps /chunks/pnpm-4/ /app/node_modules/.pnpm/
COPY --from=deps /chunks/pnpm-5/ /app/node_modules/.pnpm/
COPY --from=deps /chunks/pnpm-6/ /app/node_modules/.pnpm/
COPY --from=deps /chunks/pnpm-rest/ /app/node_modules/.pnpm/

# Собранный код сервиса.
COPY --from=builder /src/dist ./dist

# Артефакты авто-установки (hook-Job чарта `autoInstall`): манифест `provides`,
# референсный инсталлятор и скиллы. Нужны образу, даже когда сервис не запускается
# (аддон «только MCP/скиллы»): `node scripts/install-into-synth.mjs …`.
COPY synth.pack ./
COPY scripts/install-into-synth.mjs ./scripts/
COPY skills ./skills

# Права в образе не должны зависеть от режимов в git/чек-ауте: в рабочей копии
# файлы могут иметь групповой режим (`-rw-rw----`, каталоги `drwxrws---` —
# umask 002 / setgid-каталоги), а `COPY` сохраняет права как есть. Тогда под
# (uid 1000, не root) не читает их → `EACCES open '/app/scripts/install-into-synth.mjs'`
# в hook-Job. Даём всем на чтение (`a+r`) и на обход каталогов (`X` — только
# каталоги/уже исполняемые файлы); владелец остаётся root, uid 1000 хватает
# прав на чтение. `dist` — из builder-стадии (там права зависят от umask сборки),
# а `node_modules` едет из реестра npm (режимы 644/755) — выравнивать не нужно.
RUN chmod -R a+rX /app/synth.pack /app/skills /app/scripts /app/dist \
 && chmod a+r /app/package.json /app/pnpm-lock.yaml

# JSON-хранилище (offset/дедуп/привязки чатов; монтируется volume'ом).
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=7100
ENV GATEWAY_DATA_DIR=/var/lib/synth-gateway/data

VOLUME ["/var/lib/synth-gateway/data"]
EXPOSE 7100

ENTRYPOINT ["node", "dist/gateway/index.js"]
