# Third-party notices

This project is distributed under the [MIT License](./LICENSE). It depends on
third-party packages, each of which is distributed under its own license. Direct
runtime dependencies are listed below.

> The resolved versions come from the committed `pnpm-lock.yaml`. For the complete
> and authoritative dependency tree, including transitive dependencies, see
> [`pnpm-lock.yaml`](./pnpm-lock.yaml) and run `pnpm licenses list`.

## Direct runtime dependencies

| Package | Declared range | Resolved | License |
|---|---|---|---|
| [`@grammyjs/types`](https://github.com/grammyjs/types) | `^5.0.0` | 5.0.0 | MIT |
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | `^1.29.0` | 1.32.1 | MIT |
| [`hono`](https://github.com/honojs/hono) | `^4.9.0` | 4.13.13 | MIT |
| [`https-proxy-agent`](https://github.com/TooTallNate/proxy-agents) | `^9.1.0` | 9.1.0 | MIT |
| [`socks-proxy-agent`](https://github.com/TooTallNate/proxy-agents) | `^10.1.0` | 10.1.0 | MIT |
| [`zod`](https://github.com/colinhacks/zod) | `^3.24.0` | 3.25.76 | MIT |

## Development-only dependencies

The following are used for building, linting and testing only and are not part of
the shipped runtime: `typescript`, `eslint` (+ `@eslint/js`, `typescript-eslint`),
`prettier`, `vitest`, `@types/node`. All are licensed under MIT (with
`typescript-eslint` components under MIT and `eslint` under MIT). See
[`pnpm-lock.yaml`](./pnpm-lock.yaml) for exact versions.

## Notes

- The gateway talks to the **Telegram Bot API** at runtime, but no Telegram client
  library is bundled — requests are made directly with the built-in `fetch`.
- The license of each installed package is also available in its
  `node_modules/<name>/package.json` (`license` field).
- The full license texts of transitive dependencies can be listed with
  `pnpm licenses list --long`.
- The text of this project's own license is in [`LICENSE`](./LICENSE) (English)
  and [`LICENSE.ru.md`](./LICENSE.ru.md) (Russian translation).
