// Pose le reranker dans un profil : `<profil>/reranker.json` (l'IR à formes statiques et le port FIXE du worker isolé) ET les drapeaux
// `ecosystem` en mode FANTÔME (SPECS-P5-RERANKER.md §2.1, §3, §9 Q1-Q4). Le passage en mode « active » n'est PAS fait ici : c'est une décision
// de l'utilisateur après lecture du rapport fantôme. Le passage (et le retour) se fait par `--mode active|shadow` (SPECS-P5-RERANKER-ACTIVE.md §2) :
// ce mode ne touche que `ecosystem.rerankMode`, jamais `reranker.json` ni les autres drapeaux ; application FERMÉE ; copie du réglage avant écriture.
//
// Depuis packages/cli :
//   ../../node_modules/.bin/tsx src/wire-reranker.ts            → SIMULATION (rien n'est écrit)
//   ../../node_modules/.bin/tsx src/wire-reranker.ts --apply    → écrit le fichier ET les drapeaux du profil `default`
//   options : --profile <nom>   --port <n> (défaut 8930)   --model-dir <dossier absolu> (défaut tools/ov-bge-reranker-int8-b8x512 du dépôt)
//   ../../node_modules/.bin/tsx src/wire-reranker.ts --mode active|shadow            → SIMULATION du changement de mode (rien n'est écrit)
//   ../../node_modules/.bin/tsx src/wire-reranker.ts --mode active|shadow --apply    → écrit `ecosystem.rerankMode` seul (copie `ecosystem-avant-mode-*.json` d'abord)
//
// L'IR figée se produit avant, par `packages/plugins/embeddings/src/make-static-reranker.ts`. Application Jarod FERMÉE (la base du profil
// est écrite), puis relancée : le worker ne démarre que si `rag.enabled` est vrai. Un `reranker.json` existant est sauvegardé en `.bak`.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { JarodApp, start, stop } from "@jarod/kernel";
import { describeMode, isProcessAlive, readRuntimeLock } from "@jarod/plugin-agent";
import { ProfileManager } from "@jarod/plugin-persona";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Port FIXE de la spec (Q3) : libre à la vérification du 2026-10-01 ; 8920 = embeddings, 8910 = whisper. */
export const DEFAULT_RERANKER_PORT = 8930;
/** Candidats reclassés (Q2) et échéance (barre (b) figée dans DECISIONS 2026-10-01) : les seules valeurs que cet outil pose. */
export const DEFAULT_RERANKER_TOP_N = 16;
export const DEFAULT_RERANKER_DEADLINE_MS = 4000;

export interface RerankerFile {
  modelDir: string;
  port: number;
  batch: number;
  maxLength: number;
}

/** La configuration à écrire ; refuse un port hors 1–65535, un lot ou une longueur non entiers, un dossier non absolu. */
export function rerankerConfigFor(o: { port?: number; modelDir?: string; batch?: number; maxLength?: number } = {}): RerankerFile {
  const port = o.port ?? DEFAULT_RERANKER_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port invalide : ${port} (entier de 1 à 65535 attendu)`);
  const batch = o.batch ?? 8;
  if (!Number.isInteger(batch) || batch < 1) throw new Error(`batch invalide : ${batch} (entier positif attendu)`);
  const maxLength = o.maxLength ?? 512;
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error(`maxLength invalide : ${maxLength} (entier positif attendu)`);
  const modelDir = o.modelDir ?? join(ROOT, "tools", "ov-bge-reranker-int8-b8x512");
  if (!isAbsolute(modelDir)) throw new Error(`le dossier du modèle doit être un chemin absolu : ${modelDir}`);
  return { modelDir, port, batch, maxLength };
}

/** Null si le dossier est une IR OpenVINO à formes STATIQUES `batch,maxLength` ; sinon la raison. */
export function checkRerankerModel(modelDir: string, batch: number, maxLength: number): string | null {
  if (!existsSync(modelDir)) return `dossier du modèle introuvable : ${modelDir}`;
  const xmlPath = join(modelDir, "openvino_model.xml");
  if (!existsSync(xmlPath)) return `openvino_model.xml absent de ${modelDir} (export optimum-cli puis make-static-reranker attendus)`;
  const xml = readFileSync(xmlPath, "utf8");
  const shapes = [...xml.matchAll(/<layer\b[^>]*\btype="Parameter"[^>]*>[\s\S]*?<data\b[^>]*\bshape="([^"]*)"/g)].map((m) => m[1]!);
  if (shapes.length === 0) return `aucun paramètre d'entrée dans ${xmlPath}`;
  if (shapes.some((s) => s.includes("?") || s.includes("-1"))) return `IR à formes dynamiques : le NPU la refuse. Figez-la avec packages/plugins/embeddings/src/make-static-reranker.ts (lot ${batch}, longueur ${maxLength}).`;
  const want = `${batch},${maxLength}`;
  const bad = shapes.find((s) => s !== want);
  if (bad) return `IR figée en « ${bad} » mais reranker.json demanderait « ${want} » (lot ${batch}, longueur ${maxLength}) : refaire make-static-reranker ou corriger --batch / --max-length`;
  return null;
}

export function writeRerankerFile(profileDir: string, cfg: RerankerFile, apply: boolean): { written: boolean; path: string; backup: string | null } {
  const path = join(profileDir, "reranker.json");
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

/**
 * Drapeaux résultants : reranker allumé avec son budget COMPLET, mode fantôme si aucun mode n'est posé. Un `rerankMode` déjà posé (même
 * « active ») n'est jamais changé : cet outil n'active pas et ne rétrograde pas. Toutes les autres clés sont rendues telles quelles.
 */
export function applyRerankerFlags<E extends object>(eco: E): E & { reranker: "bge-reranker-v2-m3-npu"; rerankTopN: number; rerankDeadlineMs: number; rerankMode: "shadow" | "active" } {
  const mode = (eco as { rerankMode?: unknown }).rerankMode;
  return {
    ...eco,
    reranker: "bge-reranker-v2-m3-npu",
    rerankTopN: DEFAULT_RERANKER_TOP_N,
    rerankDeadlineMs: DEFAULT_RERANKER_DEADLINE_MS,
    rerankMode: mode === "active" ? "active" : "shadow",
  };
}

// ── Mode du reclassement : `--mode active|shadow` (SPECS-P5-RERANKER-ACTIVE.md §2, Q2) ───────────────────────────────────────────────────
// Un seul réglage change : `ecosystem.rerankMode`. Décision de l'utilisateur, jamais prise par cet outil de lui-même.

export const RERANK_MODES = ["shadow", "active"] as const;
export type RerankMode = (typeof RERANK_MODES)[number];

const isMode = (v: unknown): v is RerankMode => typeof v === "string" && (RERANK_MODES as readonly string[]).includes(v);
const MODES_HINT = "« shadow » ou « active »";

/** Arguments de la ligne de commande. `mode: null` = pas de `--mode` : le comportement d'avant (pose du fichier et des drapeaux). */
export function parseModeArgs(argv: readonly string[]): { mode: RerankMode | null; apply: boolean; profile: string } {
  const opt = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const apply = argv.includes("--apply");
  const profile = opt("--profile") ?? "default";
  if (!argv.includes("--mode")) return { mode: null, apply, profile };
  const value = opt("--mode");
  if (!isMode(value)) throw new Error(`--mode attend ${MODES_HINT} (reçu : ${value === undefined ? "rien" : `« ${value} »`})`);
  for (const other of ["--port", "--model-dir"]) {
    if (argv.includes(other)) throw new Error(`--mode ne se combine pas avec ${other} : il ne change que ecosystem.rerankMode (la pose se fait sans --mode)`);
  }
  return { mode: value, apply, profile };
}

/**
 * Le réglage `ecosystem` avec le seul `rerankMode` changé. Refuse si le reranker n'est pas posé avec son budget complet : activer un
 * reclassement éteint n'aurait aucun effet et cacherait un oubli de pose.
 */
export function setRerankMode<E extends Record<string, unknown>>(eco: E, mode: RerankMode): E & { rerankMode: RerankMode } {
  if (!isMode(mode)) throw new Error(`mode invalide : attendu ${MODES_HINT}`);
  const wired = eco.reranker === "bge-reranker-v2-m3-npu" && typeof eco.rerankTopN === "number" && typeof eco.rerankDeadlineMs === "number";
  if (!wired) throw new Error("le reranker n'est pas posé dans ce profil (drapeau éteint ou budget absent) : lancez d'abord wire-reranker --apply, sans --mode");
  return { ...eco, rerankMode: mode };
}

/** Null si le profil est libre ; sinon la raison (processus VIVANT qui le tient). Un verrou laissé par un processus mort ne compte pas. */
export function liveProfileHolder(dir: string): string | null {
  const lock = readRuntimeLock(dir);
  return lock && isProcessAlive(lock.pid) ? `le profil est tenu par un processus vivant (${describeMode(lock.mode)}, pid ${lock.pid}) : fermez l'application.` : null;
}

/** Copie du réglage `ecosystem` AVANT écriture, dans le dossier du profil ; ne remplace jamais une copie existante. Rend le chemin. */
export function backupEcosystem(dir: string, eco: Record<string, unknown>, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let path = join(dir, `ecosystem-avant-mode-${stamp}.json`);
  for (let n = 2; existsSync(path); n++) path = join(dir, `ecosystem-avant-mode-${stamp}-${n}.json`);
  writeFileSync(path, `${JSON.stringify(eco, null, 2)}\n`, { flag: "wx" });
  return path;
}

export interface ModeSettings {
  get(k: "ecosystem"): Record<string, unknown>;
  set(k: "ecosystem", v: unknown): void;
}

export interface ModeChange {
  /** Le réglage a été ÉCRIT (et relu à l'identique). */
  applied: boolean;
  /** Le mode demandé diffère du mode actuel. */
  changed: boolean;
  before: RerankMode;
  after: RerankMode;
  /** Chemin de la copie d'avant écriture, ou null (simulation, ou rien à changer). */
  backup: string | null;
}

/**
 * Change `ecosystem.rerankMode` et rien d'autre. Ordre : refus si le profil est tenu par un processus vivant (AVANT toute lecture, simulation
 * comprise) → lecture → refus si le reranker n'est pas posé → [simulation : fin] → copie d'avant écriture → écriture → relecture à l'identique.
 * Déjà dans le mode demandé : rien n'est écrit.
 */
export function changeRerankMode(o: { settings: ModeSettings; dir: string; mode: RerankMode; apply: boolean; now?: Date }): ModeChange {
  const held = liveProfileHolder(o.dir);
  if (held) throw new Error(held);
  const eco = o.settings.get("ecosystem");
  const next = setRerankMode(eco, o.mode);
  const before: RerankMode = isMode(eco.rerankMode) ? eco.rerankMode : "shadow";
  const changed = before !== o.mode;
  if (!changed || !o.apply) return { applied: false, changed, before, after: o.mode, backup: null };
  const backup = backupEcosystem(o.dir, eco, o.now);
  o.settings.set("ecosystem", next);
  if (!isDeepStrictEqual(o.settings.get("ecosystem"), next)) throw new Error(`Relecture différente de ce qui a été écrit (copie d'avant : ${backup}).`);
  return { applied: true, changed, before, after: o.mode, backup };
}

function dataRoot(env: NodeJS.ProcessEnv): string {
  if (env.JAROD_HOME) return env.JAROD_HOME;
  const appData = process.platform === "win32" ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming")) : join(homedir(), ".config");
  return join(appData, "Jarod-One", "data");
}

async function runMode(parsed: { mode: RerankMode; apply: boolean; profile: string }): Promise<void> {
  const root = dataRoot(process.env);
  if (!existsSync(root)) throw new Error(`Aucune donnée Jarod-One dans ${root}.`);
  const profiles = new ProfileManager(root);
  if (!profiles.list().includes(parsed.profile)) throw new Error(`Profil inconnu : ${parsed.profile}`);
  const dir = profiles.dirFor(parsed.profile);
  const held = liveProfileHolder(dir); // avant d'ouvrir la base : on ne la touche pas si l'application tourne
  if (held) throw new Error(held);
  const app = new JarodApp({ plugins: { storage: { dataDir: dir, cipher: electronSecretsCipher(electronUserDataDir(process.env)) } } } as never);
  const started = await start(app);
  try {
    const settings = (app as unknown as { storage: { settings: ModeSettings } }).storage.settings;
    const r = changeRerankMode({ settings, dir, mode: parsed.mode, apply: parsed.apply });
    console.log(`Profil : ${parsed.profile}`);
    console.log(`rerankMode : ${r.before} → ${r.after}${r.changed ? "" : " (déjà dans ce mode)"}`);
    if (!r.changed) return void console.log("\nRien à écrire.");
    if (!r.applied) return void console.log("\nSIMULATION : rien n'a été écrit. Relancez avec --apply (application Jarod FERMÉE).");
    console.log(`Copie du réglage d'avant : ${r.backup}`);
    console.log(`\nÉCRIT et relu à l'identique. Mode ${r.after.toUpperCase()}. Seul ecosystem.rerankMode a changé. Relancez l'application.`);
    console.log(r.after === "active" ? "Le classement du reranker est SERVI par rag_search (≈ 3,2 s de plus par recherche) ; retour : --mode shadow --apply." : "Retour au mode fantôme : l'ordre servi est de nouveau celui du dense.");
  } finally {
    await stop(started);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseModeArgs(argv);
  if (parsed.mode) return runMode({ mode: parsed.mode, apply: parsed.apply, profile: parsed.profile });
  const apply = argv.includes("--apply");
  const opt = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const profile = opt("--profile") ?? "default";
  const portArg = opt("--port");
  const modelArg = opt("--model-dir");
  const cfg = rerankerConfigFor({ ...(portArg !== undefined ? { port: Number(portArg) } : {}), ...(modelArg !== undefined ? { modelDir: modelArg } : {}) });
  const problem = checkRerankerModel(cfg.modelDir, cfg.batch, cfg.maxLength);
  if (problem) throw new Error(problem);

  const root = dataRoot(process.env);
  if (!existsSync(root)) throw new Error(`Aucune donnée Jarod-One dans ${root}.`);
  const profiles = new ProfileManager(root);
  if (!profiles.list().includes(profile)) throw new Error(`Profil inconnu : ${profile}`);
  const dir = profiles.dirFor(profile);

  const app = new JarodApp({ plugins: { storage: { dataDir: dir, cipher: electronSecretsCipher(electronUserDataDir(process.env)) } } } as never);
  const started = await start(app);
  try {
    type Settings = { get(k: "rag"): { enabled?: boolean }; get(k: "ecosystem"): Record<string, unknown>; set(k: string, v: unknown): void };
    const settings = (app as unknown as { storage: { settings: Settings } }).storage.settings;
    const eco = settings.get("ecosystem");
    const next = applyRerankerFlags(eco);
    const pick = (e: Record<string, unknown>) => ({ reranker: e.reranker, rerankTopN: e.rerankTopN, rerankDeadlineMs: e.rerankDeadlineMs, rerankMode: e.rerankMode });
    console.log(`Profil : ${profile}`);
    console.log(`Fichier : ${join(dir, "reranker.json")}${existsSync(join(dir, "reranker.json")) && !apply ? " (existe déjà : sera sauvegardé en .bak)" : ""}`);
    console.log(`Contenu : ${JSON.stringify(cfg)}`);
    console.log(`Drapeaux avant : ${JSON.stringify(pick(eco))}`);
    console.log(`Drapeaux après : ${JSON.stringify(pick(next))}`);
    if (settings.get("rag").enabled !== true) console.log("\nATTENTION : `rag.enabled` est faux dans ce profil ; le worker ne démarrera pas tant qu'il l'est (cet outil ne l'allume pas).");
    if (!apply) return void console.log("\nSIMULATION : rien n'a été écrit. Relancez avec --apply (application Jarod FERMÉE).");
    const written = writeRerankerFile(dir, cfg, true);
    if (written.backup) console.log(`Ancien fichier sauvegardé : ${written.backup}`);
    settings.set("ecosystem", next);
    const back = settings.get("ecosystem");
    if (JSON.stringify(pick(back)) !== JSON.stringify(pick(next))) throw new Error("Relecture différente de ce qui a été écrit.");
    console.log("\nÉCRIT et relu à l'identique. Mode FANTÔME : rien ne change pour l'utilisateur ; le classement est journalisé dans <profil>/rerank-shadow.jsonl.");
    console.log("Relancez l'application : le worker compile le modèle en arrière-plan (≈ 90 s sur NPU au premier lancement).");
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
