// Contrôle partagé avant d'ouvrir le cœur pour un serveur lancé par un AUTRE programme (`jarod mcp`, `jarod acp`) : aucune migration n'est
// jamais lancée dans ce contexte (SPECS-P5-MCP.md Q6, SPECS-P5-ACP.md §3). Lecture seule (même ouverture que `jarod health`).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DbKeyError, defaultKeyStores, inspectDbFile, isEncryptedDb, type KeyStore, MIGRATIONS } from "@jarod/plugin-storage";
import { findKey, profileDirOf, schemaCheck } from "./health.js";

export type Preflight = { ok: true; profile: string; dir: string } | { ok: false; message: string };

/** Avant tout : aucune migration n'est jamais lancée depuis un serveur appelé par un autre agent (Q6). */
export function profilePreflight(opts: { dataRoot: string; profile?: string; keyStores?: KeyStore[]; command?: string }): Preflight {
  const who = opts.command ?? "jarod mcp";
  if (!existsSync(opts.dataRoot)) return { ok: false, message: `Aucune donnée Jarod-One trouvée dans ${opts.dataRoot}. Lancez l'application une première fois, ou définissez JAROD_HOME.` };
  const dir = profileDirOf(opts.dataRoot, opts.profile);
  if (!dir) return { ok: false, message: opts.profile ? `Profil inconnu : ${opts.profile}` : "Aucun profil." };
  const profile = dir.split(/[\\/]/).pop()!;
  const dbPath = join(dir, "jarod.db");
  if (!existsSync(dbPath)) return { ok: false, message: `Le profil « ${profile} » n'a pas de base : lancez l'application une première fois.` };
  const encrypted = isEncryptedDb(dbPath);
  const key = encrypted ? findKey(dir, opts.keyStores ?? defaultKeyStores()) : null;
  if (encrypted && !key) return { ok: false, message: "La base est chiffrée et sa clé est introuvable pour ce compte utilisateur." };
  try {
    const r = inspectDbFile(dbPath, key);
    const c = schemaCheck(r.userVersion, MIGRATIONS.length);
    if (c.status !== "ok")
      return { ok: false, message: `Schéma de la base différent (version ${r.userVersion}, attendue ${MIGRATIONS.length}) : ${who} ne migre jamais. Ouvrez l'application (migration avec sauvegarde) ou utilisez la version de Jarod qui correspond.` };
  } catch (e) {
    return { ok: false, message: e instanceof DbKeyError ? "Clé incorrecte pour cette base." : `Base illisible : ${(e as Error).message.split("\n")[0]}` };
  }
  return { ok: true, profile, dir };
}
