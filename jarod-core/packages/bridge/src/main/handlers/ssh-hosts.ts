/**
 * Hôtes SSH déclarés (SPECS-P5-UI-PARITE.md §3.3) : canaux PROPRES à Jarod `ssh-hosts-list`, `ssh-pick-key`, `ssh-host-add`, `ssh-host-remove`,
 * `ssh-host-test`. L'agent s'en sert par ses outils SSH ; la déclaration ne se faisait que par `/ssh` dans le chat.
 *
 * Mêmes règles que `SshHostsService` : six champs (nom, adresse, utilisateur, port, CHEMIN de clé), aucun mot de passe, aucune phrase de passe,
 * vérification des clés d'hôte toujours active, déclarer ne connecte rien. En plus, ici :
 * - le CHEMIN de la clé privée ne se tape pas : il vient de la boîte « Ouvrir » NATIVE (`ssh-pick-key`), valable pour CE lancement seulement ; un
 *   chemin que le renderer n'a pas fait choisir par la boîte est refusé (comme le dossier de travail) ;
 * - le contenu de la clé n'est jamais lu : seul son chemin traverse ;
 * - `ssh-host-test` lance la commande de TEST fixe du service (`id`, `hostname`, `uname`), jamais une commande saisie, et ne rend que le verdict
 *   et ces trois lignes (jamais l'erreur brute du serveur au-delà de 500 caractères).
 * - `ssh-host-exec-set` lets the AGENT run commands on one host (`remote_exec`, each command confirmed by the person). Turning it on goes
 *   through a NATIVE confirmation that names the machine; turning it off is immediate. The list (`sshExecHosts`) has no other writer.
 */
import { realpathSync } from "node:fs";
import type { SshHostRecord } from "@jarod/contracts";
import type { HandlerContext } from "./context.js";

export interface SshHostsPort {
  list(): SshHostRecord[];
  add(input: { name: string; host: string; username: string; port?: number | string; keyPath: string }): SshHostRecord[];
  remove(id: string): SshHostRecord[];
  test(id: string): Promise<{ ok: boolean; stdout: string; message: string; timedOut: boolean; durationMs: number; hostName: string }>;
  execEnabledIds(): string[];
  setExecEnabled(id: string, enabled: boolean): string[];
}

/** Ce que l'écran voit d'un hôte : tout, sauf rien de secret (il n'y en a pas : le chemin d'une clé n'est pas une clé), plus son réglage d'agent. */
export type SshHostView = SshHostRecord & { agentExec: boolean };

export function createSshHostHandlers(ctx: HandlerContext) {
  const hosts = (): SshHostsPort => {
    const h = ctx.kernel().sshHosts;
    if (!h) throw new Error("[oneai] hôtes SSH indisponibles (plugin-tools désactivé)");
    return h;
  };
  /** Clés choisies dans la boîte native pendant CE lancement (chemins réels). */
  const picked = new Set<string>();

  const real = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };

  const view = (rows: SshHostRecord[]): SshHostView[] => {
    const on = new Set(hosts().execEnabledIds());
    return rows.map((r) => ({ ...r, agentExec: on.has(r.id) }));
  };

  return {
    "ssh-hosts-list": (): SshHostView[] => (ctx.kernel().sshHosts ? view(hosts().list()) : []),

    /** Boîte « Ouvrir » native ; rend le chemin choisi (retenu pour ce lancement) ou null si annulée. */
    "ssh-pick-key": async (): Promise<string | null> => {
      if (!ctx.shell.pickFile) throw new Error("[oneai] boîte « Ouvrir » native indisponible, refusé");
      const file = await ctx.shell.pickFile({ title: "Clé privée SSH", filters: [{ name: "Clé privée", extensions: ["*"] }] });
      if (!file) return null;
      picked.add(real(file));
      return file;
    },

    "ssh-host-add": (input: unknown): SshHostView[] => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("[oneai] ssh : déclaration attendue");
      const o = input as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => !["name", "host", "username", "port", "keyPath"].includes(k));
      if (extra.length) throw new Error(`[oneai] ssh : champ(s) non accepté(s) : ${extra.join(", ")} (jamais de mot de passe ni d'option)`);
      for (const k of ["name", "host", "username", "keyPath"]) if (typeof o[k] !== "string") throw new Error(`[oneai] ssh : « ${k} » : texte attendu`);
      if (o.port !== undefined && typeof o.port !== "number" && typeof o.port !== "string") throw new Error("[oneai] ssh : « port » : nombre attendu");
      if (!picked.has(real(o.keyPath as string))) {
        throw new Error("[oneai] ssh : clé non choisie dans la boîte « Ouvrir » (le chemin d'une clé ne se tape pas : utilisez « Choisir la clé… »)");
      }
      return view(hosts().add({ name: o.name as string, host: o.host as string, username: o.username as string, keyPath: o.keyPath as string, ...(o.port === undefined ? {} : { port: o.port as number | string }) }));
    },

    "ssh-host-remove": (id: unknown): SshHostView[] => {
      if (typeof id !== "string" || !id) throw new Error("[oneai] ssh : identifiant attendu");
      return view(hosts().remove(id));
    },

    /** Agent commands on one host: on after a native confirmation naming the machine, off at once. Rend la liste. */
    "ssh-host-exec-set": async (id: unknown, enabled: unknown): Promise<SshHostView[]> => {
      if (typeof id !== "string" || !id || typeof enabled !== "boolean") throw new Error("[oneai] ssh : (id: string, enabled: boolean) attendu");
      if (enabled) {
        const host = hosts().list().find((r) => r.id === id);
        if (!host) throw new Error("[oneai] ssh : hôte non déclaré");
        if (!ctx.shell.confirm) throw new Error("[oneai] ssh : confirmation native indisponible, refusé");
        const ok = await ctx.shell.confirm(
          `Laisser l'agent exécuter des commandes sur « ${host.name} » ?`,
          `${host.username}@${host.host}:${host.port}\n\nL'agent pourra PROPOSER des commandes pour cette machine. Chacune vous sera montrée telle quelle, avec la machine, et ne s'exécutera qu'après « Autoriser une fois ». ` +
            "Aucun « toujours autoriser ». Refusé si l'interrupteur Internet bloque la machine ou si sa clé d'hôte n'est pas approuvée. Chaque tentative est écrite au journal de contrôle.",
          "Autoriser les commandes",
        );
        if (!ok) throw new Error("[oneai] ssh : refusé par l'utilisateur");
      }
      hosts().setExecEnabled(id, enabled);
      return view(hosts().list());
    },

    /** La commande de TEST fixe : verdict et sortie (`id`, `hostname`, `uname`) ; aucune commande saisie ne passe par ici. */
    "ssh-host-test": async (id: unknown): Promise<{ ok: boolean; output: string; message: string; durationMs: number }> => {
      if (typeof id !== "string" || !id) throw new Error("[oneai] ssh : identifiant attendu");
      const r = await hosts().test(id);
      return { ok: r.ok, output: r.stdout.slice(0, 500), message: r.ok ? "" : (r.timedOut ? "délai dépassé" : r.message).slice(0, 500), durationMs: r.durationMs };
    },
  };
}
