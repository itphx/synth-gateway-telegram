#!/usr/bin/env bash
#
# release-notes.sh — формирует тело GitVerse Release в формате output-переменной
# `body` и дописывает его в $GITVERSE_OUTPUT (многострочный heredoc — как требует CI).
# Используется в release-пайплайне (джоба `release`).
#
# Переменная окружения:
#   VERSION — версия релиза без префикса v (обязательна)
set -euo pipefail

: "${VERSION:?VERSION не задан}"
: "${GITVERSE_OUTPUT:?GITVERSE_OUTPUT не задан (запускать из CI)}"

{
  echo 'body<<GVEOF'
  printf 'Релиз Telegram-шлюза Synth (add-on) v%s\n' "$VERSION"
  echo ''
  echo '## Артефакты'
  echo ''
  echo "- Docker: \`gitverse.ru/itphx/synth-gateway-telegram:$VERSION\` (и \`:latest\`)"
  echo "- Helm: \`synth/synth-gateway-telegram\` версия \`$VERSION\`"
  echo ''
  echo '## Установка'
  echo ''
  echo '```bash'
  echo 'helm repo add synth https://gitverse.ru/api/packages/itphx/helm'
  echo 'helm repo update'
  echo "helm install synth-gateway-telegram synth/synth-gateway-telegram --version $VERSION"
  echo "docker pull gitverse.ru/itphx/synth-gateway-telegram:$VERSION"
  echo '```'
  echo 'GVEOF'
} >> "$GITVERSE_OUTPUT"

echo "Тело релиза записано в \$GITVERSE_OUTPUT (версия $VERSION)"
