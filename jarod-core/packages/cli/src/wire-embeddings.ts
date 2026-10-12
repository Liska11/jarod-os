// Pose `<profil>/embeddings.json` : le modèle d'embeddings et le port FIXE du worker isolé (SPECS-P5-EMBEDDINGS.md §3.1, §3.7).
//
// Depuis packages/cli :
//   ../../node_modules/.bin/tsx src/wire-embeddings.ts            → SIMULATION (rien n'est écrit)
//   ../../node_modules/.bin/tsx src/wire-embeddings.ts --apply    → écrit le fichier dans le profil `default`
//   options : --profile <nom>   --port <n> (défaut 8920)   --model-dir <dossier absolu> (défaut tools/ov-bge-m3-int8 du dépôt)
//
// Aucun noyau n'est démarré (le fichier est lu par l'application au lancement) : application Jarod fermée, puis relancée. Le
// worker ne démarre ensuite que si `rag.enabled` est vrai. Un fichier existant est sauvegardé en `.bak` avant d'être remplacé.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileManager } from "@jarod/plugin-persona";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Port FIXE proposé par la spec (Q2) : libre aujourd'hui ; 8910 est celui de whisper. */
export const DEFAULT_EMBEDDINGS_PORT = 8920;

export interface EmbeddingsFile {
  modelDir: string;
  port: number;
}

/** La configuration à écrire ; refuse un port hors 1–65535 (ou non entier) et un dossier non absolu. */
export function embeddingsConfigFor(o: { port?: number; modelDir?: string } = {}): EmbeddingsFile {
  const port = o.port ?? DEFAULT_EMBEDDINGS_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port invalide : ${port} (entier de 1 à 65535 attendu)`);
  const modelDir = o.modelDir ?? join(ROOT, "tools", "ov-bge-m3-int8");
  if (!isAbsolute(modelDir)) throw new Error(`le dossier du modèle doit être un chemin absolu : ${modelDir}`);
  return { modelDir, port };
}

/** Null si le dossier est un modèle OpenVINO exporté lisible ; sinon la raison. */
export function checkEmbeddingsModel(modelDir: string): string | null {
  if (!existsSync(modelDir)) return `dossier du modèle introuvable : ${modelDir}`;
  if (!existsSync(join(modelDir, "openvino_model.xml"))) return `openvino_model.xml absent de ${modelDir} (export optimum-cli attendu)`;
  return null;
}

export function writeEmbeddingsFile(profileDir: string, cfg: EmbeddingsFile, apply: boolean): { written: boolean; path: string; backup: string | null } {
  const path = join(profileDir, "embeddings.json");
  if (!apply) return { written: false, path, backup: null };
  mkdirSync(profileDir, { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.bak`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return { written: true, path, backup };
}

function dataRoot(env: NodeJS.ProcessEnv): string {
  if (env.JAROD_HOME) return env.JAROD_HOME;
  const appData = process.platform === "win32" ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming")) : join(homedir(), ".config");
  return join(appData, "Jarod-One", "data");
}

function main(): void {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const opt = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const profile = opt("--profile") ?? "default";
  const portArg = opt("--port");
  const modelArg = opt("--model-dir");
  const cfg = embeddingsConfigFor({ ...(portArg !== undefined ? { port: Number(portArg) } : {}), ...(modelArg !== undefined ? { modelDir: modelArg } : {}) });
  const problem = checkEmbeddingsModel(cfg.modelDir);
  if (problem) throw new Error(problem);

  const root = dataRoot(process.env);
  if (!existsSync(root)) throw new Error(`Aucune donnée Jarod-One dans ${root}.`);
  const profiles = new ProfileManager(root);
  if (!profiles.list().includes(profile)) throw new Error(`Profil inconnu : ${profile}`);
  const result = writeEmbeddingsFile(profiles.dirFor(profile), cfg, apply);
  console.log(`Profil : ${profile}`);
  console.log(`Fichier : ${result.path}${existsSync(result.path) && !apply ? " (existe déjà : sera sauvegardé en .bak)" : ""}`);
  console.log(`Contenu : ${JSON.stringify(cfg)}`);
  if (!apply) return void console.log("\nSIMULATION : rien n'a été écrit. Relancez avec --apply (application Jarod fermée).");
  if (result.backup) console.log(`Ancien fichier sauvegardé : ${result.backup}`);
  console.log("\nÉCRIT. Relancez l'application ; le worker ne démarre que si rag.enabled est vrai.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
