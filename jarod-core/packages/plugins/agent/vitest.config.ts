import { defineConfig } from "vitest/config";

// Les suites `*.engine.test.ts` pilotent un vrai bureau (FlaUI, fenêtres fabriquées, premier plan) ou des moteurs externes : deux d'entre elles à la fois
// se disputent le premier plan et l'une échoue (« la fenêtre n'a pas pu passer au premier plan »). Elles tournent donc UN FICHIER À LA FOIS ; les tests
// sans moteur restent en parallèle. Les deux projets ne tournent PAS en même temps (`npm test` les enchaîne) : mesuré, la charge des tests sans moteur
// suffit à faire échouer l'amenée au premier plan d'une fenêtre fabriquée.
const common = { environment: "node" as const, testTimeout: 30_000 };

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { ...common, name: "unit", include: ["test/**/*.test.ts"], exclude: ["test/**/*.engine.test.ts"] } },
      { extends: true, test: { ...common, name: "engines", include: ["test/**/*.engine.test.ts"], fileParallelism: false } },
    ],
  },
});
