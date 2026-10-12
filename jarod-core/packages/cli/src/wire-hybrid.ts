// Allume la recherche hybride (dense + FTS5) d'un profil : le drapeau `ecosystem.hybrid` et RIEN d'autre (SPECS-P5-HYBRID.md §2.3, Q5).
//
// Depuis packages/cli :
//   ../../node_modules/.bin/tsx src/wire-hybrid.ts            → SIMULATION (rien n'est écrit)
//   ../../node_modules/.bin/tsx src/wire-hybrid.ts --apply    → écrit le drapeau du profil `default`
//   option : --profile <nom>
//
// Application Jarod FERMÉE (la base du profil est écrite). Ouvrir le profil migre la base (table FTS5 des passages, sauvegarde horodatée dans
// `<profil>/backups/` prise avant) : la première ouverture avec ce code reconstruit l'index lexical des passages déjà indexés.
// Ne touche ni au reranker ni à son mode, ni aux autres drapeaux. Jamais d'écriture sans relecture identique.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { ProfileManager } from "@jarod/plugin-persona";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";

/** Les drapeaux résultants : `hybrid` allumé, toutes les autres clés rendues telles quelles. */
export function applyHybridFlag<E extends object>(eco: E): E & { hybrid: "on" } {
  return { ...eco, hybrid: "on" };
}

/** Ce que ferait l'outil, sans rien écrire. */
export function planHybrid(eco: object): { before: "on" | "off"; after: "on"; changes: boolean } {
  const before = (eco as { hybrid?: unknown }).hybrid === "on" ? "on" : "off";
  return { before, after: "on", changes: before !== "on" };
}

function dataRoot(env: NodeJS.ProcessEnv): string {
  if (env.JAROD_HOME) return env.JAROD_HOME;
  const appData = process.platform === "win32" ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming")) : join(homedir(), ".config");
  return join(appData, "Jarod-One", "data");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const profile = argv.includes("--profile") ? argv[argv.indexOf("--profile") + 1]! : "default";
  const profiles = new ProfileManager(dataRoot(process.env));
  if (!profiles.list().includes(profile)) throw new Error(`Profil inconnu : ${profile}`);
  const dir = profiles.dirFor(profile);
  const app = new JarodApp({ plugins: { storage: { dataDir: dir, cipher: electronSecretsCipher(electronUserDataDir(process.env)) } } } as never);
  const started = await start(app);
  try {
    type Settings = { get(k: "ecosystem"): Record<string, unknown>; get(k: "rag"): { enabled?: boolean }; set(k: string, v: unknown): void };
    const settings = (app as unknown as { storage: { settings: Settings } }).storage.settings;
    const eco = settings.get("ecosystem");
    const plan = planHybrid(eco);
    console.log(`Profil : ${profile}`);
    console.log(`hybrid : ${plan.before} → ${plan.after}${plan.changes ? "" : " (déjà allumé : rien à faire)"}`);
    if (settings.get("rag").enabled !== true) console.log("ATTENTION : `rag.enabled` est faux dans ce profil ; la recherche hybride ne sert que le RAG.");
    if (!apply) return void console.log("\nSIMULATION : rien n'a été écrit. Relancez avec --apply (application Jarod FERMÉE).");
    if (!plan.changes) return;
    const next = applyHybridFlag(eco);
    settings.set("ecosystem", next);
    const back = settings.get("ecosystem");
    if (back.hybrid !== "on" || JSON.stringify({ ...back, hybrid: 0 }) !== JSON.stringify({ ...eco, hybrid: 0 })) throw new Error("Relecture différente de ce qui a été écrit.");
    console.log("\nÉCRIT et relu à l'identique : hybrid = on, aucune autre clé changée.");
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
