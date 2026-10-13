#!/usr/bin/env bash
#
# version-bump.sh — синхронизирует версию add-on'а в трёх местах:
#   - package.json            (version)
#   - addon.json              (version)
#   - charts/.../Chart.yaml   (version + appVersion)
#
# Версия — единый источник истины: git-тег vX.Y.Z. Перед созданием тега запустите
# этот скрипт, закоммитьте и поставьте тег; CI возьмёт версию из тега.
#
# Использование:
#   ./scripts/version-bump.sh 0.2.0
set -euo pipefail

cd "$(dirname "$0")/.."

NEW="${1:-}"
if [ -z "$NEW" ]; then
  echo "Использование: $0 <X.Y.Z[-pre]>" >&2
  exit 1
fi

if ! printf '%s' "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "Некорректная версия: $NEW (ожидается SemVer, например 0.2.0 или 0.2.0-rc.1)" >&2
  exit 1
fi

NEW="$NEW" node -e "
const fs = require('fs');
const v = process.env.NEW;
for (const f of ['package.json', 'addon.json']) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = v;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
console.log('Обновлено: package.json, addon.json → ' + v);
"

NEW="$NEW" node -e "
const fs = require('fs');
const v = process.env.NEW;
const p = 'charts/synth-gateway-telegram/Chart.yaml';
let y = fs.readFileSync(p, 'utf8');
y = y.replace(/^version:.*\$/m, 'version: ' + v);
y = y.replace(/^appVersion:.*\$/m, 'appVersion: \"' + v + '\"');
fs.writeFileSync(p, y);
console.log('Обновлено: ' + p + ' → ' + v);
"

echo "Готово. Дальше: git add/commit, затем тег v$NEW."
