// Interrupteur Internet de Jarod (docs/NETWORK-POLICY.md du dépôt) : côté noyau.
//
// Le shell possède `network-policy.json` et en passe le chemin par JAROD_NETWORK_POLICY. Le noyau le relit à chaque connexion
// (un `stat` ; le contenu n'est relu que s'il a changé) : une bascule s'applique à la connexion suivante, sans redémarrage.
// Même décision que `apps/desktop/shared/network-policy.ts` (aucun des deux ne peut importer l'autre) ; les deux fichiers de
// test portent les mêmes cas.
//
// Trois couches :
//   1. `installNetworkGuard` : toute connexion TCP de ce processus (fetch/undici, http, https, tls, WebSocket) passe par
//      `net.Socket.prototype.connect` ; une connexion refusée échoue avant le moindre octet, avec le code JAROD_OFFLINE.
//   2. `toolVerdict` : la porte des outils (`executeGuardedTool`) refuse ce qui sort par Internet, et ce qui lance un programme
//      que Jarod ne peut pas couper du réseau (run_shell, serveurs MCP), sauf exception explicite « commandes locales ».
//   3. Les enfants (`run_shell`, `ssh`…) ne sont PAS isolés du réseau par le noyau : c'est pourquoi la couche 2 les refuse.
import { existsSync, readFileSync, statSync, watchFile } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NetworkPolicy {
  version: 1;
  internet: boolean;
  remoteMachines: boolean;
  remoteHosts: string[];
  localCommands: boolean;
}

export const DEFAULT_POLICY: NetworkPolicy = { version: 1, internet: true, remoteMachines: false, remoteHosts: [], localCommands: false };
export const CAUTIOUS_POLICY: NetworkPolicy = { version: 1, internet: false, remoteMachines: false, remoteHosts: [], localCommands: false };
export const OFFLINE_CODE = "JAROD_OFFLINE";

const HOST = /^[a-z0-9]([a-z0-9.:-]{0,251}[a-z0-9])?$/;

export class OfflineError extends Error {
  readonly code = OFFLINE_CODE;
  constructor(what: string) {
    super(`Internet désactivé pour Jarod : ${what} n'est pas autorisé. Réactivez-le dans la barre du haut.`);
  }
}

/** `null` (pas de fichier) : défaut ; tout le reste de mal formé : prudent (Internet coupé). */
export function parsePolicy(text: string | null): NetworkPolicy {
  if (text === null) return { ...DEFAULT_POLICY };
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || raw.version !== 1 || typeof raw.internet !== "boolean") return { ...CAUTIOUS_POLICY };
    const hosts = Array.isArray(raw.remoteHosts)
      ? raw.remoteHosts.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase()).filter((h) => HOST.test(h))
      : [];
    return { version: 1, internet: raw.internet, remoteMachines: raw.remoteMachines === true, remoteHosts: [...new Set(hosts)].slice(0, 64), localCommands: raw.localCommands === true };
  } catch {
    return { ...CAUTIOUS_POLICY };
  }
}

export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) h = h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : undefined);
  return h.replace(/\.$/, "");
}

export function isLoopback(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "0.0.0.0" || h === "::") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

export type HostVerdict = "loopback" | "internet" | "remote" | "blocked";

export function decideHost(policy: NetworkPolicy, host: string): HostVerdict {
  if (isLoopback(host)) return "loopback";
  if (policy.internet) return "internet";
  if (policy.remoteMachines && policy.remoteHosts.includes(normalizeHost(host))) return "remote";
  return "blocked";
}

/** Lecteur du fichier de politique, relu seulement quand sa date ou sa taille change. Fichier absent ou illisible : prudent. */
export function policyReader(file: string): () => NetworkPolicy {
  let stamp = "";
  let cached: NetworkPolicy = { ...CAUTIOUS_POLICY };
  return () => {
    let next: string;
    try {
      const st = statSync(file);
      next = `${st.mtimeMs}:${st.size}`;
    } catch {
      // Le shell écrit le fichier avant de lancer le noyau : son absence est une anomalie, lue prudemment.
      stamp = "";
      cached = { ...CAUTIOUS_POLICY };
      return cached;
    }
    if (next !== stamp) {
      try {
        cached = parsePolicy(readFileSync(file, "utf8"));
      } catch {
        cached = { ...CAUTIOUS_POLICY };
      }
      stamp = next;
    }
    return cached;
  };
}

/** Cible d'un appel `connect`, ou null pour un tube nommé / socket Unix (pas de réseau). */
export function connectTarget(args: unknown[]): string | null {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "string" && !/^\d+$/.test(first)) return null;
  if (typeof first === "number" || typeof first === "string") return typeof args[1] === "string" && args[1] ? args[1] : "localhost";
  if (first && typeof first === "object") {
    const o = first as { path?: unknown; host?: unknown };
    if (typeof o.path === "string" && o.path) return null;
    return typeof o.host === "string" && o.host ? o.host : "localhost";
  }
  return "localhost";
}

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;
let original: Connect | null = null;
/** Connexions ouvertes hors boucle locale : coupées si la politique ne les permet plus (flux, keep-alive). */
const open = new Map<net.Socket, string>();

/** Ferme les connexions ouvertes que `allowed` ne permet plus. Rend leur nombre. */
export function cutDisallowed(allowed: (host: string) => boolean): number {
  let cut = 0;
  for (const [socket, host] of open) {
    if (!allowed(host)) {
      open.delete(socket);
      socket.destroy(new OfflineError(`la connexion à ${host}`));
      cut++;
    }
  }
  return cut;
}

/** Pose la garde une fois ; `allowed(host)` est consulté à chaque connexion. */
export function installNetworkGuard(allowed: (host: string) => boolean): void {
  if (original) return;
  const base = net.Socket.prototype.connect as unknown as Connect;
  original = base;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const host = connectTarget(args);
    if (host !== null && !allowed(host)) {
      const error = new OfflineError(`la connexion à ${host}`);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    if (host !== null && !isLoopback(host)) {
      open.set(this, host);
      this.once("close", () => open.delete(this));
    }
    return base.apply(this, args);
  } as typeof net.Socket.prototype.connect;
}

/** Tests seulement. */
export function uninstallNetworkGuard(): void {
  if (original) {
    net.Socket.prototype.connect = original as unknown as typeof net.Socket.prototype.connect;
    original = null;
    open.clear();
  }
}

// ── Politique active du processus ─────────────────────────────────────────────

let active: (() => NetworkPolicy) | null = null;

/** Branche le lecteur du fichier (gateway) ; sans lui (CLI, tests), tout est permis comme avant l'interrupteur. */
export function setActivePolicy(reader: (() => NetworkPolicy) | null): void {
  active = reader;
}

export function activePolicy(): NetworkPolicy {
  return active ? active() : { ...DEFAULT_POLICY };
}

/**
 * Point d'entrée du gateway : si JAROD_NETWORK_POLICY désigne le fichier du shell, sa politique devient celle du processus et la garde
 * des sockets est posée. Rend vrai si la politique est appliquée.
 */
export function applyNetworkPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = env.JAROD_NETWORK_POLICY?.trim();
  if (!file) return false;
  const read = policyReader(file);
  const allowed = (host: string) => decideHost(read(), host) !== "blocked";
  setActivePolicy(read);
  installNetworkGuard(allowed);
  // Une bascule vers « coupé » ferme aussi ce qui était déjà ouvert (réponse de modèle en cours, attente longue d'une messagerie).
  watchFile(file, { interval: 500, persistent: false }, () => cutDisallowed(allowed));
  return true;
}

/**
 * Le fichier de politique que doit suivre un point d'entrée AUTONOME (`jarod serve`, `jarod ask`, MCP, ACP : lancés sans le shell) :
 * celui que nomme `JAROD_NETWORK_POLICY`, sinon celui du shell installé sur la machine (`JAROD_OS_CONFIG_DIR`, puis `%APPDATA%\Jarod-OS\config`).
 * Aucun fichier trouvé : null, c'est-à-dire pas d'interrupteur configuré (Internet permis, comme avant). Un fichier TROUVÉ mais illisible
 * est appliqué prudemment (Internet coupé) par `policyReader`, jamais ignoré.
 */
export function resolvePolicyFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string | null {
  const named = env.JAROD_NETWORK_POLICY?.trim();
  if (named) return named;
  const candidates: string[] = [];
  const configDir = env.JAROD_OS_CONFIG_DIR?.trim();
  if (configDir) candidates.push(join(configDir, "network-policy.json"));
  if (platform === "win32") candidates.push(join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Jarod-OS", "config", "network-policy.json"));
  return candidates.find((f) => existsSync(f)) ?? null;
}

/**
 * Point d'entrée des processus qui ne passent pas par le shell : applique la politique AVANT toute connexion (ouverture du cœur, fournisseurs,
 * passerelles, MCP). Rend le fichier appliqué, ou null. Écrit son chemin dans `env.JAROD_NETWORK_POLICY` pour que les enfants du noyau
 * (qui ne l'héritent que par ce nom, jamais une valeur secrète) sachent qu'une politique est en vigueur.
 */
export function applyNetworkPolicyForEntry(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = resolvePolicyFile(env);
  if (!file) return null;
  env.JAROD_NETWORK_POLICY = file;
  return applyNetworkPolicyFromEnv(env) ? file : null;
}

// ── Outils ────────────────────────────────────────────────────────────────────

/** Outils dont le travail EST d'aller sur Internet : refusés hors ligne. */
const INTERNET_TOOLS = new Set(["web_search", "web_fetch", "http_request", "media_fetch",
  // G10 : télécharge une image de conteneur depuis son registre (la VM a le réseau le temps du téléchargement).
  "linux_prepare", "connected_browser", "skill_hub_install", "skill_hub_search", "pinokio_install", "pinokio_search"]);
/** Outils qui lancent un programme quelconque : Jarod ne peut pas le couper du réseau, refusés hors ligne sauf exception « commandes locales ». */
const PROCESS_TOOLS = new Set(["run_shell"]);

export type ToolNetworkVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Hors ligne, ce qu'un outil a le droit de faire. `source` : origine de l'outil (`mcp` pour un serveur MCP, qui est un programme
 * lancé ou un service distant). Un outil SSH vers une machine configurée passe par la garde des sockets / la règle des machines distantes.
 */
export function toolVerdict(policy: NetworkPolicy, name: string, source?: string): ToolNetworkVerdict {
  if (policy.internet) return { ok: true };
  if (INTERNET_TOOLS.has(name) || name.startsWith("browser_")) {
    return { ok: false, reason: `Internet est désactivé pour Jarod : l'outil ${name} va sur Internet. Ce que l'utilisateur a déjà envoyé n'est pas rappelé ; réactivez Internet dans la barre du haut pour l'utiliser.` };
  }
  if ((PROCESS_TOOLS.has(name) || source === "mcp") && !policy.localCommands) {
    return {
      ok: false,
      reason: `Internet est désactivé pour Jarod, et ${name} lance un programme que Jarod ne peut pas couper du réseau. L'utilisateur peut autoriser les commandes locales hors ligne (barre du haut → Internet).`,
    };
  }
  return { ok: true };
}
