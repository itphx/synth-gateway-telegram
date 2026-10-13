#!/usr/bin/env bash
#
# publish-chart.sh — lint, упаковка и публикация Helm-чарта Telegram-шлюза в
# нативный Helm-реестр GitVerse (не OCI). Используется в release-пайплайне
# (джоба `helm`), а также пригоден для локальной проверки.
#
# Переменные окружения:
#   GV_TOKEN      — токен GitVerse с правом на Helm-реестр (обязателен)
#   VERSION       — версия релиза без префикса v (обязательна)
#   HELM_BIN      — путь к helm (по умолчанию: ./linux-amd64/helm)
#   CHART_DIR     — каталог чарта (по умолчанию: charts/synth-gateway-telegram)
#   CHART_NAME    — имя чарта (по умолчанию: synth-gateway-telegram)
#   OUT_DIR       — каталог артефактов (по умолчанию: dist/helm)
#   HELM_REGISTRY — базовый URL Helm-реестра (по умолчанию: https://gitverse.ru/api/packages/itphx/helm)
#   DRY_RUN       — 1: упаковать, но не загружать
#
# Успех загрузки — HTTP 201 (для нового чарта) / 200. Значения токена в git не хранить.
set -euo pipefail

cd "$(dirname "$0")/.."

HELM_BIN="${HELM_BIN:-./linux-amd64/helm}"
CHART_DIR="${CHART_DIR:-charts/synth-gateway-telegram}"
CHART_NAME="${CHART_NAME:-synth-gateway-telegram}"
OUT_DIR="${OUT_DIR:-dist/helm}"
HELM_REGISTRY="${HELM_REGISTRY:-https://gitverse.ru/api/packages/itphx/helm}"
DRY_RUN="${DRY_RUN:-0}"

: "${VERSION:?VERSION не задан}"
[ -x "$HELM_BIN" ] || command -v "$HELM_BIN" >/dev/null 2>&1 || {
  echo "helm не найден: $HELM_BIN" >&2
  exit 1
}

echo "Чарт: $CHART_DIR; версия: $VERSION; helm: $HELM_BIN"

echo "[1/3] Lint"
"$HELM_BIN" lint "$CHART_DIR"

echo "[2/3] Упаковка"
mkdir -p "$OUT_DIR"
"$HELM_BIN" package "$CHART_DIR" \
  --version "$VERSION" \
  --app-version "$VERSION" \
  --destination "$OUT_DIR"

TGZ="$OUT_DIR/$CHART_NAME-$VERSION.tgz"
[ -f "$TGZ" ] || { echo "Не найден артефакт: $TGZ" >&2; exit 1; }
echo "Артефакт: $TGZ"

if [ "$DRY_RUN" = "1" ]; then
  echo "[3/3] DRY_RUN=1 — загрузка пропущена"
  exit 0
fi

: "${GV_TOKEN:?GV_TOKEN не задан (нужен для публикации чарта)}"

OWNER="${GV_OWNER:-itphx}"

echo "[3/3] Публикация → $HELM_REGISTRY/api/charts"
curl -fsS --user "$OWNER:$GV_TOKEN" -X POST \
  --upload-file "$TGZ" \
  -w "HTTP %{http_code}\n" \
  "$HELM_REGISTRY/api/charts"
