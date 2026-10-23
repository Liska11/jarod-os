// `jarod permissions` — l'interface d'administration LOCALE des permissions de l'agent (autonomie configurable, 2026-10-21).
//
// Une seule autorité : la liste `settings.permissionsRules` du profil, celle que lit le garde (plugin-permissions) et qu'édite l'écran Réglages.
// Le bureau en cours d'exécution relit cette liste à chaque décision : un changement fait ici vaut pour l'appel suivant, sans redémarrage.
//
// Lire (`list`, `explain`) est libre. ÉCRIRE (`add`, `revoke`, `reset`) exige l'utilisateur au clavier : un terminal interactif, la portée
// affichée, puis un code tiré au hasard à retaper. Le shell de l'agent (`run_shell`) n'a pas de terminal et porte `JAROD_AGENT_SHELL` : l'agent
// ne peut pas s'accorder de droits par cette commande. Un texte lu dans une page, un fichier ou un résultat d'outil n'est jamais une autorisation.
import { randomInt } from "node:crypto";
import type { PermissionRule } from "@jarod/contracts";
import {
  describeRule,
  explainResolution,
  type GrantInput,
  PermissionGuard,
  type Plan,
  planGrant,
  planMove,
  planReset,
  planRevoke,
  planUpdate,
  rebaseRules,
  type Resolution,
  resolveWith,
  type ToolFacts,
} from "@jarod/plugin-permissions";

export interface PermissionsStore {
  read(): PermissionRule[];
  write(rules: PermissionRule[]): void;
}

export interface PermissionsIO {
  out(line: string): void;
  err(line: string): void;
  /** stdin ET stdout sont un terminal : quelqu'un est au clavier. */
  interactive: boolean;
  /** Lancé depuis le shell de l'agent (`JAROD_AGENT_SHELL`). */
  agentShell: boolean;
  prompt(question: string): Promise<string>;
  now(): number;
  /** Le code à retaper (tiré au hasard ; injecté en test). */
  code(): string;
}

export interface ToolsView {
  /** L'outil est déclaré au registre de l'agent (et donc permis sans règle). */
  declared(name: string): boolean;
  /** Ce que le registre sait de l'outil ; `res` sert à dire si une opération réservée est accordée (`reservedReason`). */
  facts(name: string, operation: string | null, res: Resolution): ToolFacts;
}

export const PERMISSIONS_HELP = `jarod permissions — autorisations de l'agent (une seule liste : Réglages › Agent et sécurité)

  jarod permissions list [--json]                    Règles en vigueur, dans l'ordre (la première qui couvre un appel gagne)
  jarod permissions explain <outil> [--cible C] [--operation O] [--session S]
                                                     Ce que le garde déciderait pour cet appel, et pourquoi
  jarod permissions add <allow|auto|ask|deny> <outil> [--cible C] [--operation O] [--session S]
                        [--duree 30m|8h|7j] [--utilisations N] [--note T] [--position debut|fin] [--large]
                                                     auto = autoriser SANS accord dans ce périmètre ; --large accepte une autonomie sans borne
  jarod permissions edit <id|n°> [allow|auto|ask|deny] [--cible C] [--operation O] [--session S] [--duree 8h|permanente]
                        [--utilisations N|aucune] [--note T] [--large]
                                                     Modifie une règle en place (« aucune » retire la borne)
  jarod permissions move <id|n°> <position>          Change l'ordre (la première règle qui couvre un appel gagne)
  jarod permissions revoke <id|n°>                   Retire une règle
  jarod permissions reset                            Retire toutes les règles (retour : outils sensibles avec accord)

Écrire demande un terminal interactif et un code à retaper. Les actions déjà lancées ne sont pas touchées : une révocation n'interrompt
pas une action en cours (l'écran Tâches l'annule), une autorisation nouvelle ne relance rien.`;

/** Un code de confirmation de six chiffres. */
export const confirmationCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** « 30m », « 8h », « 7j » (ou « 7d ») → millisecondes ; lève sinon. */
export function parseDuration(raw: string): number {
  const m = /^(\d{1,4})\s*(m|min|h|j|d)$/i.exec(raw.trim());
  if (!m) throw new Error(`durée illisible : « ${raw} » (exemples : 30m, 8h, 7j)`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return n * (unit === "h" ? 3_600_000 : unit === "j" || unit === "d" ? 86_400_000 : 60_000);
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function permissionsCommand(
  positional: string[],
  flags: Record<string, string | boolean>,
  store: PermissionsStore,
  tools: ToolsView,
  io: PermissionsIO,
): Promise<number> {
  const [sub = "list", ...rest] = positional;
  const now = io.now();
  try {
    if (sub === "help") {
      io.out(PERMISSIONS_HELP);
      return 0;
    }
    if (sub === "list") {
      const rules = store.read();
      if (flags.json) {
        io.out(JSON.stringify(rules, null, 2));
        return 0;
      }
      io.out(rules.length ? "Règles de l'utilisateur (la première qui couvre un appel gagne) :" : "Aucune règle de l'utilisateur.");
      rules.forEach((r, i) => io.out(`  ${describeRule(r, i + 1, now)}`));
      io.out("Sans règle : un outil déclaré est permis ; un outil sensible demande l'accord à chaque appel ; un outil inconnu est refusé.");
      return 0;
    }
    if (sub === "explain") {
      const tool = rest[0];
      if (!tool) throw new Error("outil manquant : jarod permissions explain <outil>");
      const target = str(flags.cible);
      const operation = str(flags.operation) ?? null;
      const session = str(flags.session);
      const call = { targets: target ? [target] : null, operation, ...(session ? { session } : {}) };
      const res = resolveWith(new PermissionGuard(store.read(), () => now), tools.declared, tool, call);
      const e = explainResolution(tool, call, res, tools.facts(tool, operation, res), now);
      io.out(`${tool}${target ? ` sur « ${target} »` : ""}${operation ? `, opération « ${operation} »` : ""} : ${e.verdict}`);
      io.out(`  ${e.why}`);
      if (e.howTo) io.out(`  ${e.howTo}`);
      return 0;
    }
    let plan: Plan;
    const base = store.read();
    if (sub === "add") {
      const [kind, tool] = rest;
      if (!kind || !["allow", "auto", "ask", "deny"].includes(kind) || !tool) throw new Error("usage : jarod permissions add <allow|auto|ask|deny> <outil> [options]");
      const uses = str(flags.utilisations);
      if (uses !== undefined && !/^\d{1,6}$/.test(uses)) throw new Error("--utilisations : un entier positif");
      const position = str(flags.position);
      if (position !== undefined && position !== "debut" && position !== "fin") throw new Error("--position : debut ou fin");
      const duree = str(flags.duree);
      const input: GrantInput = {
        tool,
        decision: kind === "auto" ? "allow" : (kind as GrantInput["decision"]),
        ...(kind === "auto" ? { autonomous: true } : {}),
        ...(str(flags.cible) ? { target: str(flags.cible)! } : {}),
        ...(str(flags.operation) ? { operation: str(flags.operation)! } : {}),
        ...(str(flags.session) ? { session: str(flags.session)! } : {}),
        ...(duree ? { durationMs: parseDuration(duree) } : {}),
        ...(uses !== undefined ? { uses: Number(uses) } : {}),
        ...(str(flags.note) ? { note: str(flags.note)! } : {}),
        ...(flags.large === true ? { broad: true } : {}),
        ...(position === "fin" ? { position: "end" as const } : {}),
      };
      if (!tools.declared(tool) && tool !== "*" && kind !== "deny") io.out(`Attention : aucun outil « ${tool} » n'est déclaré pour l'instant (famille, outil d'une extension non chargée ?).`);
      plan = planGrant(base, input, now);
    } else if (sub === "edit") {
      const [ref, kind] = rest;
      if (!ref) throw new Error("usage : jarod permissions edit <id|n°> [allow|auto|ask|deny] [options] (voir jarod permissions list)");
      if (kind !== undefined && !["allow", "auto", "ask", "deny"].includes(kind)) throw new Error("décision : allow, auto, ask ou deny");
      const uses = str(flags.utilisations);
      if (uses !== undefined && uses !== "aucune" && !/^\d{1,6}$/.test(uses)) throw new Error("--utilisations : un entier positif, ou « aucune »");
      const duree = str(flags.duree);
      // « aucune » retire la borne ; une option absente garde la valeur actuelle.
      const opt = (v: string | undefined) => (v === undefined ? undefined : v === "aucune" ? null : v);
      plan = planUpdate(
        base,
        ref,
        {
          ...(kind ? { decision: kind === "auto" ? "allow" : (kind as "allow" | "ask" | "deny"), autonomous: kind === "auto" } : {}),
          ...(opt(str(flags.cible)) !== undefined ? { target: opt(str(flags.cible))! } : {}),
          ...(opt(str(flags.operation)) !== undefined ? { operation: opt(str(flags.operation))! } : {}),
          ...(opt(str(flags.session)) !== undefined ? { session: opt(str(flags.session))! } : {}),
          ...(opt(str(flags.note)) !== undefined ? { note: opt(str(flags.note))! } : {}),
          ...(duree !== undefined ? { durationMs: duree === "permanente" || duree === "aucune" ? null : parseDuration(duree) } : {}),
          ...(uses !== undefined ? { uses: uses === "aucune" ? null : Number(uses) } : {}),
          ...(flags.large === true ? { broad: true } : {}),
          by: "commande",
        },
        now,
      );
    } else if (sub === "move") {
      const [ref, to] = rest;
      if (!ref || !to || !/^\d{1,3}$/.test(to)) throw new Error("usage : jarod permissions move <id|n°> <position> (1 = première)");
      plan = planMove(base, ref, Number(to), now);
    } else if (sub === "revoke") {
      if (!rest[0]) throw new Error("usage : jarod permissions revoke <id|n°> (voir jarod permissions list)");
      plan = planRevoke(base, rest[0], now);
    } else if (sub === "reset") {
      plan = planReset(base, now);
    } else {
      io.err(`Sous-commande inconnue : ${sub}\n\n${PERMISSIONS_HELP}`);
      return 2;
    }
    for (const l of plan.summary) io.out(l);
    if (plan.weakenings.length) {
      io.out("Ce changement donne plus de pouvoir à l'agent :");
      for (const w of plan.weakenings) io.out(`  • ${w}`);
    }
    // Le canal de l'utilisateur : un terminal, un code à retaper. Ni le shell de l'agent, ni un script sans terminal.
    if (io.agentShell) {
      io.err("Refusé : cette commande est lancée depuis le shell de l'agent. Un changement de permission vient de l'utilisateur, jamais de l'agent.");
      return 3;
    }
    if (!io.interactive) {
      io.err("Refusé : un changement de permission se confirme dans un terminal interactif (code à retaper). Rien n'a changé.");
      return 3;
    }
    const code = io.code();
    const typed = await io.prompt(`Pour confirmer, tapez ${code} (Entrée seule = annuler) : `);
    if (typed.trim() !== code) {
      io.out("Annulé : rien n'a changé.");
      return 1;
    }
    // Relue juste avant d'écrire : une utilisation consommée pendant la confirmation n'est pas rendue ; un autre changement annule.
    store.write(rebaseRules(base, store.read(), plan.rules));
    io.out("Enregistré. S'applique aux appels suivants, y compris dans le bureau ouvert.");
    io.out("Les actions déjà lancées ne sont pas touchées : une révocation n'interrompt pas une action en cours (l'écran Tâches l'annule).");
    return 0;
  } catch (e) {
    io.err(`Erreur : ${(e as Error).message.replace(/^\[oneai\] /, "")}`);
    return 2;
  }
}
