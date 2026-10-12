// Câble le sidecar Linear (tools/linear-mcp-server, patch local consigné) dans le réglage `mcpServers` d'un profil.
//
// Depuis packages/cli :
//   ../../node_modules/.bin/tsx src/wire-linear-mcp.ts            → SIMULATION (rien n'est écrit)
//   ../../node_modules/.bin/tsx src/wire-linear-mcp.ts --apply    → écrit dans le profil `default`
//   options : --profile <nom>   --data-dir <dossier>  (dossier de données explicite, clés en mémoire : TESTS seulement)
//
// La clé LINEAR_API_KEY vient de l'environnement, sinon de `.env` à la racine du dépôt (ignoré par git). Elle n'est
// jamais affichée. Écrire dans un profil réel : FERMER l'application Jarod d'abord (une seule écriture SQLite à la fois).
// Fusion : l'entrée nommée `linear` est remplacée, les autres serveurs sont conservés tels quels.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@jarod/contracts";
import { JarodApp, start, stop } from "@jarod/kernel";
import { ProfileManager } from "@jarod/plugin-persona";
import { electronSecretsCipher, electronUserDataDir, memoryKeyStore } from "@jarod/plugin-storage";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER = join(ROOT, "tools", "linear-mcp-server", "node_modules", "linear-mcp-server", "build", "index.js");

/** L'entrée `mcpServers` de Linear : commande ABSOLUE (l'application n'hérite pas forcément du PATH de ce terminal). */
export function linearEntry(apiKey: string, id: string = randomUUID()): McpServerConfig {
  return { id, name: "linear", command: process.execPath, args: [SERVER], env: { LINEAR_API_KEY: apiKey }, enabled: true };
}

/** Remplace l'entrée `linear` (en gardant son id) ou l'ajoute ; les autres serveurs ne bougent pas. */
export function mergeLinear(list: McpServerConfig[], entry: McpServerConfig): McpServerConfig[] {
  const at = list.findIndex((s) => s.name === "linear");
  if (at < 0) return [...list, entry];
  return list.map((s, i) => (i === at ? { ...entry, id: s.id } : s));
}

function readKey(): string {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY.trim();
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return "";
  const m = readFileSync(file, "utf8").replace(/^﻿/, "").match(/^LINEAR_API_KEY=(.*)$/m);
  return (m?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
}

const mask = (list: McpServerConfig[]) => list.map((s) => ({ ...s, env: Object.fromEntries(Object.keys(s.env ?? {}).map((k) => [k, "***"])) }));

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

  if (!existsSync(SERVER)) throw new Error(`Sidecar Linear introuvable : ${SERVER}`);
  const key = readKey();
  if (!key.startsWith("lin_api_")) throw new Error("LINEAR_API_KEY absente ou de forme inattendue (environnement ou .env).");

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
    const settings = (app as unknown as { storage: { settings: { get(k: "mcpServers"): McpServerConfig[]; set(k: "mcpServers", v: McpServerConfig[]): void } } }).storage.settings;
    const before = settings.get("mcpServers");
    const after = mergeLinear(before, linearEntry(key));
    console.log(`Profil : ${explicitDir ? `(dossier ${explicitDir})` : profile}`);
    console.log(`Avant : ${JSON.stringify(mask(before))}`);
    console.log(`Après : ${JSON.stringify(mask(after))}`);
    if (!apply) return void console.log("\nSIMULATION : rien n'a été écrit. Relancez avec --apply (application Jarod fermée).");
    settings.set("mcpServers", after);
    const back = settings.get("mcpServers").find((s) => s.name === "linear");
    if (back?.env?.LINEAR_API_KEY !== key) throw new Error("Relecture différente de ce qui a été écrit.");
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
