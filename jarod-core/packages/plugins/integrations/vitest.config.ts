import { defineConfig } from "vitest/config";

// Les suites « moteur » pilotent un vrai navigateur, le bureau (UIA) et des ports : deux fichiers de test à la fois se disputeraient le même bureau,
// les mêmes profils jetables et les mêmes témoins réseau. Un fichier à la fois dans ce paquet (les autres paquets restent parallèles).
export default defineConfig({ test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 30_000, fileParallelism: false } });
