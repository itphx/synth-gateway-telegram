# Как внести вклад в synth-gateway-telegram

Спасибо за интерес к улучшению Telegram-шлюза Synth! Этот репозиторий реализует
**Telegram-шлюз** — внешний сервис-мост (**Gateway**) агентной платформы
[Synth](https://gitverse.ru/itphx/synth).

Английская (каноничная) версия документа: [CONTRIBUTING.md](./CONTRIBUTING.md).

## Модель разработки и pull request'ы

- **Основная разработка ведётся в GitVerse** —
  <https://gitverse.ru/itphx/synth-gateway-telegram> (ветка `master`).
- **GitHub — публичное зеркало** — <https://github.com/itphx/synth-gateway-telegram>.
  Issues и pull request'ы там приветствуются, но мейнтейнер их **не мержит** на
  GitHub: принятые изменения **переносятся cherry-pick'ом в GitVerse**. Держите
  ветку в актуальном состоянии относительно `master`, чтобы она применялась чисто.
- Один PR — одно логическое изменение. Опишите, что и почему сделано.

## Требования

- **Node.js ≥ 22** (см. `engines` в [`package.json`](./package.json)).
- **pnpm** (репозиторий — одиночный pnpm-пакет с закоммиченным lockfile).
- Git.

## Начало работы

```bash
git clone https://gitverse.ru/itphx/synth-gateway-telegram.git
cd synth-gateway-telegram
pnpm install
```

## Проверки

Запускайте всё из корня репозитория перед открытием pull request'а. Имена команд
ниже — точные скрипты из [`package.json`](./package.json):

| Команда | Назначение |
|---|---|
| `pnpm build` | Сборка TypeScript в `dist/` (`tsc -p tsconfig.build.json`) |
| `pnpm typecheck` | Проверка типов без эмита (`tsc --noEmit`) |
| `pnpm lint` | ESLint по `src/` |
| `pnpm test` | Vitest (`vitest run`) |
| `pnpm start` | Запуск шлюза из `dist/` (`node dist/gateway/index.js`) |
| `pnpm clean` | Очистка `dist/` |

Локальная проверка перед пушем:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

## Именование веток

| Префикс | Для чего |
|---|---|
| `feat/*` | Новая функциональность |
| `fix/*` | Исправление багов |
| `docs/*` | Только документация |
| `chore/*` | Инструменты, CI, зависимости, рутина |

## Сообщения коммитов — Conventional Commits

Используйте [Conventional Commits](https://www.conventionalcommits.org/) с
**русским** описанием:

```text
<type>(<scope>): <краткое описание в повелительном наклонении>
```

Допустимые типы: `feat`, `fix`, `docs`, `refactor`, `test`, `ci`, `chore`.
`scope` — необязателен (например, `fix(gateway): …` или `fix(docker): …`).

Примеры:

```text
fix(gateway): устранить повтор доставки при перезапуске поллера
feat(mcp): добавить тул tg_status
docs(deployment): описать деплой через Helm
```

## Подпись коммита (DCO)

Каждый коммит должен быть подписан, подтверждая
[Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "fix(gateway): ..."
```

Строка `Signed-off-by:` обязательна — pull request'ы без неё не принимаются.

## Версионирование

Версия — единый источник истины в трёх местах: `package.json`, `synth.pack` и
`Chart.yaml` Helm-чарта. Не правьте их вручную — используйте

```bash
./scripts/version-bump.sh <X.Y.Z>
```

затем коммит и тег `vX.Y.Z`. Релиз-ноты формирует CI и публикует на странице
Releases (см. [CHANGELOG.md](./CHANGELOG.md)).

## Манифест `synth.pack`

`synth.pack` (JSON в корне репозитория, без расширения в имени) — единый манифест
расширения: объявляет `kind: "gateway"`, `host`, `contracts` и `provides`
(MCP-сервер и скиллы).

- Если меняется **состав** шлюза — добавлен/убран MCP-сервер или скилл, изменены
  `kind`/`host`/`contracts` — обновите `synth.pack` **и** его `version`
  (через `scripts/version-bump.sh`).
- Держите манифест в соответствии с тем, что реально ставит Helm-чарт.

## Документация

- Документация — в `docs/*.md`
  ([gateway.md](./docs/gateway.md), [configuration.md](./docs/configuration.md),
  [deployment.md](./docs/deployment.md)). Обновляйте нужную страницу при изменении
  поведения, конфигурации или деплоя.
- Держите [README.md](./README.md) в соответствии с кодом.
- Документация пишется на **русском** языке.

## Секреты

- **Никогда не коммитьте секреты.** Токены ботов, сервис-ключи Synth, OIDC
  client secret и `tenants.json` должны оставаться вне git: `secrets/`, `certs/`
  и `.env` — в `.gitignore`.
- Примеры манифестов в `examples/` должны содержать **только плейсхолдеры**
  (например, `REPLACE_ME`) — никаких реальных токенов, ключей и сертификатов.
- В проде используйте секрет-менеджер или `SealedSecret`, а не закоммиченные файлы.

## Контакты

- Email: **admin@itphx.ru**
- Telegram: <https://t.me/synth_dev_admin>

Внося вклад, вы соглашаетесь, что ваш вклад распространяется под
[лицензией MIT](./LICENSE).
