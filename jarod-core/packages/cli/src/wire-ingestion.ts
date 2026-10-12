// Active l'ingestion de documents (PDF, Office, HTML) dans un profil : les trois chemins ABSOLUS des workers dans le
// réglage `rag` et `ecosystem.documentParser = "docling"` (PHASE-5 « Ingestion », DECISIONS 2026-09-30 / 2026-10-01).
//
// Depuis packages/cli :
//   ../../node_modules/.bin/tsx src/wire-ingestion.ts            → SIMULATION (rien n'est écrit)
//   ../../node_modules/.bin/tsx src/wire-ingestion.ts --apply    → écrit dans le profil `default`
//   options : --profile <nom>   --data-dir <dossier>  (dossier de données explicite, clés en mémoire : TESTS seulement)
//
// Ne touche PAS à `rag.enabled` ni aux autres clés de `rag` et d'`ecosystem` : seuls les quatre champs ci-dessus changent.
// Les chemins sont vérifiés (existence) avant toute écriture. Écrire dans un profil réel : FERMER l'application Jarod d'abord.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EcosystemFlags } from "@jarod/contracts";
import { JarodApp, start, stop } from "@jarod/kernel";
import { ProfileManager } from "@jarod/plugin-persona";
import { electronSecretsCipher, electronUserDataDir, memoryKeyStore } from "@jarod/plugin-storage";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface IngestionPaths {
  doclingPython: string;
  doclingWorker: string;
  pdfiumWorker: string;
}

/** Les trois chemins du dépôt (venv Docling, worker Docling, worker pdfium), absolus. */
export function ingestionPaths(root: string = ROOT): IngestionPaths {
  return {
    doclingPython: join(root, "tools", "docling-venv", "Scripts", "python.exe"),
    doclingWorker: join(root, "sidecars", "docling-worker", "docling-worker.py"),
    pdfiumWorker: join(root, "sidecars", "pdfium-worker", "pdfium-worker.py"),
  };
}

/** Réglages résultants : seuls les trois chemins et `documentParser` changent, tout le reste est rendu tel quel. */
export function applyIngestion<R extends object, E extends object>(rag: R, ecosystem: E, paths: IngestionPaths): { rag: R & IngestionPaths; ecosystem: E & Pick<EcosystemFlags, "documentParser"> } {
  return { rag: { ...rag, ...paths }, ecosystem: { ...ecosystem, documentParser: "docling" } };
}

function dataRoot(env: NodeJS.ProcessEnv): string {
  if (env.JAROD_HOME) return env.JAROD_HOME;
  const appData = process.platform === "win32" ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming")) : join(homedir(), ".config");
  return join(appData, "Jarod-One", "data");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const opt = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const profile = opt("--profile") ?? "default";
  const explicitDir = opt("--data-dir");

  const paths = ingestionPaths();
  for (const [k, p] of Object.entries(paths)) if (!existsSync(p)) throw new Error(`Chemin introuvable (${k}) : ${p}`);

  let storage: Record<string, unknown>;
  if (explicitDir) storage = { dataDir: explicitDir, keyStores: [memoryKeyStore()] };
  else {
    const root = dataRoot(process.env);
    if (!existsSync(root)) throw new Error(`Aucune donnée Jarod-One dans ${root}.`);
    const profiles = new ProfileManager(root);
    if (!profiles.list().includes(profile)) throw new Error(`Profil inconnu : ${profile}`);
    storage = { dataDir: profiles.dirFor(profile), cipher: electronSecretsCipher(electronUserDataDir(process.env)) };
  }

  const app = new JarodApp({ plugins: { storage } } as never);
  const started = await start(app);
  try {
    type Settings = { get(k: "rag"): Record<string, unknown>; get(k: "ecosystem"): Record<string, unknown>; set(k: string, v: unknown): void };
    const settings = (app as unknown as { storage: { settings: Settings } }).storage.settings;
    const rag = settings.get("rag");
    const eco = settings.get("ecosystem");
    const next = applyIngestion(rag, eco, paths);
    const view = (r: Record<string, unknown>, e: Record<string, unknown>) => ({
      "rag.enabled": r.enabled,
      "rag.doclingPython": r.doclingPython,
      "rag.doclingWorker": r.doclingWorker,
      "rag.pdfiumWorker": r.pdfiumWorker,
      "ecosystem.documentParser": e.documentParser,
    });
    console.log(`Profil : ${explicitDir ? `(dossier ${explicitDir})` : profile}`);
    console.log(`Avant : ${JSON.stringify(view(rag, eco), null, 1)}`);
    console.log(`Après : ${JSON.stringify(view(next.rag, next.ecosystem), null, 1)}`);
    if (rag.enabled !== true) console.log("\nATTENTION : `rag.enabled` est faux dans ce profil ; cet outil ne l'allume pas (décision à part).");
    if (!apply) return void console.log("\nSIMULATION : rien n'a été écrit. Relancez avec --apply (application Jarod fermée).");
    settings.set("rag", next.rag);
    settings.set("ecosystem", next.ecosystem);
    const backRag = settings.get("rag");
    const backEco = settings.get("ecosystem");
    if (backEco.documentParser !== "docling" || (Object.keys(paths) as (keyof IngestionPaths)[]).some((k) => backRag[k] !== paths[k])) throw new Error("Relecture différente de ce qui a été écrit.");
    console.log("\nÉCRIT et relu à l'identique.");
  } finally {
    await stop(started);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
