#!/usr/bin/env node
// Тонкая обёртка: логика — в `src/installer/install.ts` (собирается в dist).
// Запуск (в образе add-on'а): `node scripts/install-into-synth.mjs --synth-url … --token …`
import { main } from '../dist/installer/install.js';

process.exitCode = await main(process.argv.slice(2), process.env);
