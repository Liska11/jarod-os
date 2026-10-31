// Interrupteur « mode 100 % local » de la voix. Réglage hors base chiffrée : `localOnly` dans `<config>/qwen-flash.json` (à côté de `network-policy.json`),
// relu à CHAQUE requête vocale (dictée, synthèse) : le basculer ne demande aucun redémarrage. Absent, illisible ou autre chose que `true` : mode normal
// (chaînes de repli cloud actives). Le fichier est réécrit en gardant tous ses autres champs (autostart, whisper, lfm…).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function voiceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.JAROD_OS_CONFIG_DIR?.trim() || join(env.APPDATA ?? "", "Jarod-OS", "config");
  return join(dir, "qwen-flash.json");
}

export function readLocalOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = voiceConfigPath(env);
  if (!existsSync(path)) return false;
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { localOnly?: unknown }).localOnly === true;
  } catch {
    return false;
  }
}

export function writeLocalOnly(value: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const path = voiceConfigPath(env);
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${path} est illisible : mode 100 % local non modifié (corrigez le fichier d'abord).`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...current, localOnly: value }, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Retire des lignes de journal toute valeur de clé API présente dans l'environnement (garde-fou : une clé n'apparaît jamais dans un journal). */
export function scrubSecrets(line: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = line;
  for (const name of ["GEMINI_API_KEY", "GROQ_API_KEY", "ELEVENLABS_API_KEY"]) {
    const key = env[name]?.trim();
    if (key && key.length >= 8) out = out.split(key).join(`«${name}»`);
  }
  return out;
}
