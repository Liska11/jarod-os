import { defineConfig } from "vitest/config";

// Suites d'intégration U3 (vrais processus, base chiffrée temporaire, aucune donnée réelle) + garde du dépôt (B16) : dans `pnpm test`.
export default defineConfig({ test: { environment: "node", include: ["integration/**/*.test.ts", "repo/**/*.test.ts"], testTimeout: 60_000, fileParallelism: false } });
