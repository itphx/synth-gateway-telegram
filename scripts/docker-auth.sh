#!/usr/bin/env bash
#
# docker-auth.sh — готовит DOCKER_CONFIG/config.json для kaniko (реестр gitverse.ru)
# из токена GV_TOKEN. Используется в release-пайплайне (джоба `docker`), чтобы
# kaniko мог пушить образ в публичный реестр GitVerse.
#
# Переменные окружения:
#   GV_TOKEN      — токен GitVerse с правом на container registry (обязателен)
#   DOCKER_CONFIG — каталог конфигурации Docker (по умолчанию: $PWD/.docker)
#
# Секрет не печатается в лог: в config.json попадает base64-пара «владелец:токен».
set -euo pipefail

: "${GV_TOKEN:?GV_TOKEN не задан}"
OWNER="${GV_OWNER:-itphx}"
REGISTRY="${GV_REGISTRY:-gitverse.ru}"
CONFIG_DIR="${DOCKER_CONFIG:-$PWD/.docker}"

mkdir -p "$CONFIG_DIR"

AUTH="$(printf '%s' "$OWNER:$GV_TOKEN" | base64 -w0)"
printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$REGISTRY" "$AUTH" > "$CONFIG_DIR/config.json"
chmod 600 "$CONFIG_DIR/config.json"

echo "Docker-авторизация записана: $CONFIG_DIR/config.json (реестр $REGISTRY, пользователь $OWNER)"
