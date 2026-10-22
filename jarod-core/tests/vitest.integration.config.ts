import { defineConfig } from "vitest/config";

// Suites d'intégration U3 (vrais processus, base chiffrée temporaire, aucune donnée réelle) + garde du dépôt (B16) : dans `pnpm test`.
// `git-env.setup.ts` retire toute variable GIT_* héritée avant chaque fichier (incident du 2026-10-22).
export default defineConfig({ test: { environment: "node", include: ["integration/**/*.test.ts", "repo/**/*.test.ts"], setupFiles: ["repo/git-env.setup.ts"], testTimeout: 60_000, fileParallelism: false } });
