# Add-on Synth: границы и основания

> Краткая выжимка. Полные архитектурные решения — в основном репозитории Synth:
> <https://gitverse.ru/itphx/synth> (AD-086, AD-089, AD-090).
> Этот репозиторий — реализация первого add-on'а, Telegram-шлюза.

## Что такое add-on

**Add-on** — внешний сервис-надстройка: отдельный процесс/контейнер со своим
репозиторием, релизным циклом, образами и деплоем. Он общается с Synth
исключительно по **публичным контрактам**: API v2, MCP и внешние события (AD-089).

Классы расширений Synth разведены жёстко (AD-090) и не смешиваются:

| Класс | Что запускается | Носитель | Доступ к internals |
|---|---|---|---|
| **Plugin** | код **в процессе core** | JS-бандл через Extension API | да (под permission-слоем) |
| **Add-on** | **внешний сервис** в своём процессе | образ + compose/Helm | **нет** |
| **Declarative** | ничего (данные) | файлы контента (скиллы, агенты, MCP-серверы, маршруты) | нет |

## Границы Telegram-шлюза

- ✅ внешний сервис: long-polling Telegram → нормализация → `POST /api/v2/events`;
  обратная доставка ответов агента через SSE;
- ❌ не плагин: не монтируется в процесс core, точек расширения Extension API
  (хуки, `ToolRegistry`, `ProviderFactory`, UI-слоты) не имеет;
- ❌ нет прямого доступа к internals ядра (`FileStore`, `GatewayProvider`, сессии
  в обход API);
- ⚠️ **LLM внутрь сервиса не тянется**: понимание/генерацию делает движок Synth,
  шлюз — детерминированный транспорт событий.

## Точки интеграции

- **API v2** (`/api/v2`): `POST /events`, `GET /events` (SSE), `/events/bindings*`,
  `/sessions*`; аутентификация — scoped service-key `synth_svc_…` (AD-052).
- **MCP** (stdio, bin `synth-gateway-tg`): инструменты `tg_*` для агента;
  неймспейс в Synth — `synth-gateway-telegram_<tool>`.
- **Внешние события** (AD-089): тело `{ source, type, payload, identity, dedupKey }`;
  стабильный `dedupKey` обязателен.

Детали конфигурации — [configuration.md](configuration.md), развёртывание —
[deployment.md](deployment.md).

## Совместимость

Манифест `addon.json` в корне фиксирует `name`/`version`/`kind: "addon"`/`host` и
диапазоны контрактов `apiV2`/`events`/`mcp` (semver). `host` и `contracts`
проверяются при подключении к инстансу Synth.
