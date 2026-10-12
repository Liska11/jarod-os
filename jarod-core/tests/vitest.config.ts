import { defineConfig } from "vitest/config";

// Les gates lisent des données réelles (backup-db) et attendent une minute de cron : jamais dans `pnpm test`.
export default defineConfig({ test: { environment: "node", include: ["gates/**/*.test.ts", "bench/**/*.test.ts"], testTimeout: 180_000, fileParallelism: false } });
