#!/usr/bin/env node
// Lanceur : exécute le CLI TypeScript via tsx (le bundle esbuild de la source arrive avec la release, P4).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const r = spawnSync(process.execPath, [tsx, join(here, "..", "src", "main.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
