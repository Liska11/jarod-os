// `jarod health` (SPECS-P5-CLI.md §3) : l'installation est-elle saine ? LECTURE SEULE : ni verrou, ni migration, ni clé créée, aucun fichier écrit.
// Pas de `ProfileManager` ici : son constructeur crée le dossier des profils (et un profil « default ») — un diagnostic ne crée rien.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ecosystemFlags } from "@jarod/contracts";
import { describeMode, isProcessAlive, readRuntimeLock, readSupervisorStatus } from "@jarod/plugin-agent";
import { DbKeyError, defaultKeyStores, inspectDbFile, isEncryptedDb, type KeyStore, MIGRATIONS } from "@jarod/plugin-storage";

export type HealthStatus = "ok" | "dégradé" | "échec";
export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
}
export interface HealthReport {
  at: string;
  dataRoot: string;
  profile: string | null;
  status: HealthStatus;
  checks: HealthCheck[];
}

export interface HealthOptions {
  dataRoot: string;
  profile?: string;
  /** Magasins de clés consultés (tests) ; par défaut ceux du compte. */
  keyStores?: KeyStore[];
  nodeVersion?: string;
}

const RANK: Record<HealthStatus, number> = { ok: 0, dégradé: 1, échec: 2 };
const worst = (checks: HealthCheck[]): HealthStatus =>
  checks.reduce<HealthStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "ok");
const check = (id: string, label: string, status: HealthStatus, detail: string): HealthCheck => ({ id, label, status, detail });

/** Version du schéma lue contre celle que ce programme attend : en retard = migration au prochain démarrage, en avance = base trop récente. */
export function schemaCheck(userVersion: number, expected: number): HealthCheck {
  if (userVersion === expected) return check("schema", "Schéma", "ok", `version ${userVersion}`);
  if (userVersion < expected)
    return check("schema", "Schéma", "dégradé", `version ${userVersion} sur ${expected} : les migrations s'appliqueront au prochain démarrage (sauvegarde automatique avant)`);
  return check("schema", "Schéma", "échec", `version ${userVersion} : plus récente que ce programme (${expected}) — ne pas l'ouvrir avec cette version`);
}

function listProfiles(root: string): string[] {
  const dir = join(root, "profiles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function activeProfile(root: string, profiles: string[]): string | null {
  try {
    const { active } = JSON.parse(readFileSync(join(root, "profile.json"), "utf8")) as { active?: string };
    if (active && profiles.includes(active)) return active;
  } catch {
    /* première utilisation */
  }
  return profiles[0] ?? null;
}

/** Dossier du profil demandé (ou actif), sans rien créer ; null si introuvable. */
export function profileDirOf(root: string, profile?: string): string | null {
  const profiles = listProfiles(root);
  const name = profile ?? activeProfile(root, profiles);
  return name && profiles.includes(name) ? join(root, "profiles", name) : null;
}

export function findKey(dir: string, stores: KeyStore[]): string | null {
  for (const store of stores) {
    try {
      const key = store.load(dir);
      if (key) return key;
    } catch {
      /* magasin indisponible : le suivant */
    }
  }
  return null;
}

/** Fichier de configuration facultatif d'un worker (`embeddings.json`, `reranker.json`) : absent = ok ; présent = lisible et modèle existant. */
function workerFile(dir: string, file: string, id: string, label: string, extra: string): HealthCheck {
  const path = join(dir, file);
  if (!existsSync(path)) return check(id, label, "ok", `non configuré (${file} absent, facultatif)`);
  let cfg: { modelDir?: unknown; port?: unknown };
  try {
    cfg = JSON.parse(readFileSync(path, "utf8")) as typeof cfg;
  } catch {
    return check(id, label, "dégradé", `${file} illisible (JSON invalide)`);
  }
  if (typeof cfg.modelDir !== "string" || !cfg.modelDir) return check(id, label, "dégradé", `${file} : modelDir manquant`);
  let present = false;
  try {
    present = statSync(cfg.modelDir).isDirectory();
  } catch {
    present = false;
  }
  if (!present) return check(id, label, "dégradé", `${file} : le dossier du modèle est introuvable (${cfg.modelDir})`);
  return check(id, label, "ok", `modèle présent, port ${typeof cfg.port === "number" ? cfg.port : "?"}${extra}`);
}

export function collectHealth(opts: HealthOptions): HealthReport {
  const at = new Date().toISOString();
  const stores = opts.keyStores ?? defaultKeyStores();
  const finish = (profile: string | null, checks: HealthCheck[]): HealthReport => ({
    at,
    dataRoot: opts.dataRoot,
    profile,
    status: worst(checks),
    checks,
  });

  if (!existsSync(opts.dataRoot))
    return finish(null, [check("data", "Données", "échec", `dossier de données introuvable : ${opts.dataRoot}`)]);
  const checks: HealthCheck[] = [check("data", "Données", "ok", opts.dataRoot)];

  const profiles = listProfiles(opts.dataRoot);
  const profile = opts.profile ?? activeProfile(opts.dataRoot, profiles);
  if (!profile || !profiles.includes(profile)) {
    checks.push(check("profile", "Profil", "échec", profile ? `profil inconnu : ${profile}` : "aucun profil"));
    return finish(profile ?? null, checks);
  }
  checks.push(check("profile", "Profil", "ok", profile));
  const dir = join(opts.dataRoot, "profiles", profile);

  // Base : présence, clé, intégrité, version du schéma, réglage ecosystem (lecture seule).
  const dbPath = join(dir, "jarod.db");
  let ecosystem: unknown = null;
  let ecosystemKnown = false;
  if (!existsSync(dbPath)) {
    checks.push(check("database", "Base", "dégradé", "absente (profil jamais ouvert)"));
    checks.push(check("schema", "Schéma", "dégradé", "non vérifié : pas de base"));
  } else {
    const encrypted = isEncryptedDb(dbPath);
    const key = encrypted ? findKey(dir, stores) : null;
    if (encrypted && !key) {
      checks.push(check("database", "Base", "échec", "chiffrée, mais sa clé est introuvable pour ce compte utilisateur"));
      checks.push(check("schema", "Schéma", "dégradé", "non vérifié : base illisible"));
    } else {
      try {
        const r = inspectDbFile(dbPath, key);
        checks.push(check("database", "Base", encrypted ? "ok" : "dégradé", encrypted ? "intègre (quick_check ok), chiffrée" : "intègre, mais NON chiffrée"));
        checks.push(schemaCheck(r.userVersion, MIGRATIONS.length));
        ecosystem = r.ecosystem;
        ecosystemKnown = true;
      } catch (e) {
        const msg = e instanceof DbKeyError ? "clé incorrecte pour cette base" : (e as Error).message.split("\n")[0]!;
        checks.push(check("database", "Base", "échec", `illisible : ${msg}`));
        checks.push(check("schema", "Schéma", "dégradé", "non vérifié : base illisible"));
      }
    }
  }

  // Verrou d'exécution et instance en arrière-plan.
  const lock = readRuntimeLock(dir);
  if (!lock) checks.push(check("lock", "Verrou", "ok", "libre"));
  else if (isProcessAlive(lock.pid)) checks.push(check("lock", "Verrou", "ok", `tenu par ${describeMode(lock.mode)} (pid ${lock.pid})`));
  else checks.push(check("lock", "Verrou", "dégradé", `périmé : laissé par un processus disparu (pid ${lock.pid})`));

  const sup = readSupervisorStatus(opts.dataRoot);
  if (!sup.state) checks.push(check("instance", "Instance en arrière-plan", "ok", "aucune"));
  else if (sup.stale) checks.push(check("instance", "Instance en arrière-plan", "dégradé", `fichier d'état périmé (pid ${sup.state.pid} disparu)`));
  else if (sup.stopping) checks.push(check("instance", "Instance en arrière-plan", "dégradé", `en cours d'arrêt (pid ${sup.state.pid})`));
  else checks.push(check("instance", "Instance en arrière-plan", "ok", `en marche : ${sup.state.mode}, pid ${sup.state.pid}`));

  // Workers facultatifs.
  checks.push(workerFile(dir, "embeddings.json", "embeddings", "Embeddings", ""));
  const eco = ecosystemFlags(ecosystem);
  const mode = !ecosystemKnown ? ", mode inconnu (base non lue)" : eco.reranker === "off" ? ", drapeau éteint" : `, mode ${eco.rerankMode}`;
  checks.push(workerFile(dir, "reranker.json", "reranker", "Reranker", mode));

  checks.push(check("node", "Node", "ok", opts.nodeVersion ?? process.version));
  return finish(profile, checks);
}

export const healthExitCode = (r: HealthReport): number => (r.status === "ok" ? 0 : 1);

export function renderHealth(r: HealthReport): string {
  const mark: Record<HealthStatus, string> = { ok: "[ok]     ", dégradé: "[dégradé]", échec: "[ÉCHEC]  " };
  return [
    `Santé de l'installation — ${r.status}${r.profile ? ` (profil ${r.profile})` : ""}`,
    ...r.checks.map((c) => `${mark[c.status]} ${c.id.padEnd(10)} ${c.label} : ${c.detail}`),
  ].join("\n");
}
