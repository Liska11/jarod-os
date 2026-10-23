/**
 * Garde de permissions unifié, fail-closed, first-match-wins.
 * Portage de SANK-AI `src/core/runtime/agent-host.mjs:36-56` (PermissionGuard « Anew », licence MIT,
 * © 2026 SankAi contributors) : mêmes règles de correspondance (nom exact, `_`/`/` équivalents,
 * segment `fs` → `fs_*`, joker `*`), même défaut (aucune règle → deny).
 *
 * Adaptation Jarod : la chaîne effective est `règles utilisateur` → `outil déclaré au registre →
 * allow` → `* → deny`. Un outil que personne n'a déclaré ne s'exécute jamais ; un `allow` laisse
 * ensuite jouer les gardes existants (approbation des outils sensibles, mode Plan, shell-guard).
 * Les règles utilisateur sont PERSISTÉES (`settings.permissionsRules`) et relues à chaud : elles
 * n'ont donc pas besoin d'être fournies à la construction du service.
 *
 * Autonomie configurable (2026-10-21) : une règle `allow` marquée `autonomous` dispense de l'accord, mais SEULEMENT dans son périmètre — outil,
 * cible(s), opération, conversation, échéance, nombre d'utilisations. Elle ne lève ni l'interrupteur Internet, ni le mode Plan, ni un refus
 * placé avant elle, ni le garde propre à l'outil (emplacements protégés, processus critiques, garde du shell).
 */
import type { PermissionDecision, PermissionRule } from "@jarod/contracts";
import type { SettingsService } from "@jarod/plugin-storage";

const norm = (s: string) => String(s).toLowerCase().replace(/[_/]/g, "");
/** Clé de `Settings` où vivent les règles de l'utilisateur (relues à chaud, jamais un secret). */
export const RULES_SETTINGS_KEY = "permissionsRules" as const;
/** Ce que vaut une règle absente : le registre décide (`allow` si l'outil y est déclaré), sinon refus. */
export const DECLARED_FALLBACK: PermissionDecision = "allow";

/** Du plus fermé au plus ouvert : sert à dire si un jeu de règles AFFAIBLIT le précédent. `auto` = `allow` sans accord. */
const RANK = { deny: 0, ask: 1, allow: 2, auto: 3 } as const;
type Level = keyof typeof RANK;

/**
 * Cockpit, lot 2 : la cible d'un appel (`ToolDef.targetOf`) couverte par le motif d'une règle. `*` = n'importe quelle suite ; tout le reste
 * est pris à la lettre ; casse ignorée ; `/` et `\` équivalents (un chemin Windows s'écrit des deux façons). Le motif couvre TOUTE la cible.
 */
export function targetMatches(pattern: string, target: string): boolean {
  const canon = (s: string) => s.toLowerCase().replace(/\\/g, "/");
  const re = canon(pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`, "s").test(canon(target));
}

/**
 * Le contexte d'un appel, pour les règles à périmètre. Pour `targets` et `operation` : une valeur = connue ; `null` = l'outil n'a pas su la
 * dire (un deny ou ask qui la vise s'applique, un allow ne joue pas) ; absent = pas de contexte d'appel (vue d'ensemble : un deny ou ask qui la
 * vise vaut « demander », un allow ne joue pas). Plusieurs cibles (un lot de fichiers) : un allow ne joue que s'il les couvre TOUTES, un deny
 * ou un ask dès qu'il en couvre une.
 */
export interface CallScope {
  targets?: readonly string[] | null;
  operation?: string | null;
  /** La conversation (ou mission) de l'appel : une règle bornée à une conversation ne joue que pour elle. */
  session?: string;
}

/** Ce que le garde a décidé, et pourquoi : la règle qui a joué (avec sa position), ou le repli. */
export interface Resolution {
  decision: PermissionDecision;
  /** Vrai seulement quand une règle `allow` + `autonomous` a joué : l'accord de l'outil n'est pas demandé. */
  autonomous: boolean;
  rule?: PermissionRule;
  /** La position de la règle dans la liste (0 = première). */
  index?: number;
  source: "règle" | "registre" | "défaut";
}

/** Une règle qui ne joue plus : échue, ou dont les utilisations sont épuisées. */
export function ruleSpent(r: PermissionRule, now: number): "échue" | "épuisée" | null {
  if (r.expiresAt !== undefined && r.expiresAt <= now) return "échue";
  if (r.uses !== undefined && r.uses <= 0) return "épuisée";
  return null;
}

type Fit = "yes" | "no" | "ask";
const DOTDOT = /(^|[\\/])\.\.([\\/]|$)/;
/** Un motif face aux valeurs d'un appel, selon que la règle ouvre (`allow`) ou ferme (`deny`, `ask`). */
function fit(pattern: string | undefined, values: readonly string[] | null | undefined, opens: boolean): Fit {
  if (pattern === undefined) return "yes";
  if (values === undefined) return opens ? "no" : "ask";
  if (values === null || values.length === 0) return opens ? "no" : "yes";
  // Une valeur qui remonte (`..`) ne satisfait jamais une règle qui ouvre : `D:\demo\..\x` ressemble à `D:\demo\*` sans y être.
  if (opens) return values.every((v) => !DOTDOT.test(v) && targetMatches(pattern, v)) ? "yes" : "no";
  return values.some((v) => targetMatches(pattern, v)) ? "yes" : "no";
}

export class PermissionGuard {
  private rules: readonly PermissionRule[] = [];

  constructor(
    rules: readonly PermissionRule[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.rules = [...rules];
  }

  /** Remplace les règles EN PLACE (relecture à chaud : les portails déjà distribués suivent). */
  setRules(rules: readonly PermissionRule[]): void {
    this.rules = [...rules];
  }

  /** Les règles en vigueur (copie : l'appelant ne peut pas les modifier par effet de bord). */
  getRules(): readonly PermissionRule[] {
    return [...this.rules];
  }

  /**
   * La première règle qui couvre l'outil dans ce contexte d'appel, ou null. Une règle échue ou épuisée ne joue pas ; une règle bornée à une
   * conversation ne joue que pour elle. Voir `CallScope` pour les cibles et l'opération.
   */
  resolveRule(toolName: string, call: CallScope = {}): (Resolution & { source: "règle" }) | null {
    const seg = String(toolName).split(/[_/]/)[0]!.toLowerCase();
    const now = this.now();
    for (const [index, r] of this.rules.entries()) {
      if (ruleSpent(r, now)) continue;
      if (r.session !== undefined && r.session !== call.session) continue;
      const covers = r.tool === "*" || r.tool === toolName || norm(r.tool) === norm(toolName) || norm(r.tool) === norm(seg);
      if (!covers) continue;
      const opens = r.decision === "allow";
      const op = call.operation === undefined ? undefined : call.operation === null ? null : [call.operation];
      const fits = [fit(r.target, call.targets, opens), fit(r.operation, op, opens)];
      if (fits.includes("no")) continue;
      const decision: PermissionDecision = fits.includes("ask") ? "ask" : r.decision;
      return { decision, autonomous: decision === "allow" && r.autonomous === true, rule: r, index, source: "règle" };
    }
    return null;
  }

  /**
   * La décision de la première règle qui couvre l'outil (et sa cible), ou null si aucune ne le couvre. Une règle échue (`expiresAt`) ne joue pas.
   *
   * `target` : une chaîne = la cible résolue de l'appel ; `null` = cible INCONNUE (l'outil n'a pas su la dire) : un deny ou ask ciblé
   * s'applique tel quel, un allow ciblé ne joue pas (fail-closed) ; absent = pas de contexte d'appel (vue d'ensemble, écran) : un deny ou
   * ask ciblé vaut « demander » (l'outil n'est pas interdit partout), un allow ciblé ne joue pas.
   */
  match(toolName: string, target?: string | null): PermissionDecision | null {
    return this.resolveRule(toolName, { targets: target === undefined ? undefined : target === null ? null : [target] })?.decision ?? null;
  }

  /** Décision seule (sémantique SANK-AI) : aucune règle → deny. */
  decide(toolName: string, target?: string | null): PermissionDecision {
    return this.match(toolName, target) ?? "deny";
  }
}

/** Ce que consulte l'agent avant tout appel d'outil (`executeGuardedTool`). `target` : voir `PermissionGuard.match`. */
export interface ToolGate {
  decide(toolName: string, target?: string | null): PermissionDecision;
  /** La décision dans le contexte complet de l'appel, avec la règle qui a joué (autonomie, explication d'un refus). */
  resolve?(toolName: string, call: CallScope): Resolution;
  /** Un appel accordé par une règle à nombre d'utilisations vient d'être exécuté : en retirer une. */
  consume?(rule: PermissionRule): void;
}

/** Charge les règles depuis le storage (`settings.permissionsRules`) ; toute lecture en échec vaut « aucune règle ». */
export function loadRulesFromStorage(settings: SettingsService): readonly PermissionRule[] {
  try {
    const raw = settings.get(RULES_SETTINGS_KEY);
    return Array.isArray(raw) ? [...(raw as PermissionRule[])] : [];
  } catch {
    return [];
  }
}

/** Règles utilisateur, puis « déclaré au registre → allow », puis `* → deny` (fail-closed). */
export function resolveWith(guard: PermissionGuard, declared: (toolName: string) => boolean, toolName: string, call: CallScope): Resolution {
  const hit = guard.resolveRule(toolName, call);
  if (hit) return hit;
  return declared(toolName) ? { decision: DECLARED_FALLBACK, autonomous: false, source: "registre" } : { decision: "deny", autonomous: false, source: "défaut" };
}

/** Règles utilisateur, puis « déclaré au registre → allow », puis `* → deny` (fail-closed). */
export function unifiedGate(guard: PermissionGuard, declared: (toolName: string) => boolean): ToolGate {
  return {
    decide: (name, target) => guard.match(name, target) ?? (declared(name) ? DECLARED_FALLBACK : "deny"),
    resolve: (name, call) => resolveWith(guard, declared, name, call),
  };
}

const levelOf = (r: Resolution | null, fb: PermissionDecision): Level => (r ? (r.autonomous ? "auto" : r.decision) : fb);
const LEVEL_WORD: Record<Level, string> = { deny: "deny", ask: "ask", allow: "allow", auto: "allow sans accord" };

/**
 * Les affaiblissements qu'un nouveau jeu de règles introduit par rapport au précédent (phrases prêtes à
 * afficher), ou `[]` si le changement ne fait que durcir ou ne change rien. Sert à exiger la confirmation
 * native AVANT d'écrire — jamais un diff textuel.
 *
 * Deux axes, parce que la décision d'un nom est `première règle qui le couvre`, ou le repli du registre :
 *  - chaque nom d'outil des DEUX jeux, éprouvé avec les DEUX replis possibles (`allow` si l'outil est
 *    déclaré au registre, `deny` sinon) — la seule façon de voir un changement qui ne joue que sur les
 *    outils non déclarés ;
 *  - la règle générale `*`, qui décide tout ce qu'aucun nom ne couvre.
 * Une règle à périmètre (cible, opération, conversation) s'éprouve aussi DANS son périmètre ; « allow sans accord » est plus ouvert que « allow ».
 */
export function rulesWeakenings(before: readonly PermissionRule[], after: readonly PermissionRule[]): string[] {
  const a = new PermissionGuard(before);
  const b = new PermissionGuard(after);
  const out: string[] = [];
  /** Ce que le nom rend avec ce repli (`fb`) avant et après ; la phrase s'il devient plus permissif, sinon null. */
  const line = (subject: string, name: string, fb: PermissionDecision, call: CallScope): string | null => {
    const old = levelOf(a.resolveRule(name, call), fb);
    const next = levelOf(b.resolveRule(name, call), fb);
    if (RANK[next] <= RANK[old]) return null;
    return `${subject} : « ${LEVEL_WORD[old]} » devient « ${LEVEL_WORD[next]} »${fb === "deny" ? " pour un outil que le registre ne déclare pas" : ""}`;
  };
  // Sans périmètre : évalué comme une cible et une opération INCONNUES (lecture stricte) — un refus ciblé reste un refus, il n'affaiblit rien.
  const unknown: CallScope = { targets: null, operation: null };
  for (const name of new Set([...before, ...after].map((r) => r.tool).filter((t) => t !== "*"))) {
    for (const fb of ["allow", "deny"] as const) {
      const l = line(`règle « ${name} »`, name, fb, unknown);
      if (l) {
        out.push(l);
        break; // une phrase par nom : le repli qui montre le changement suffit
      }
    }
  }
  // Cockpit, lot 2 : une règle à périmètre s'éprouve DANS son périmètre (le motif pris comme valeur) — un allow ciblé nouveau, même temporaire,
  // est un affaiblissement pour ce périmètre.
  const probes = new Map<string, { r: PermissionRule; call: CallScope }>();
  for (const r of [...before, ...after]) {
    if (!scoped(r)) continue;
    const call: CallScope = { targets: r.target !== undefined ? [r.target] : null, operation: r.operation ?? null, ...(r.session !== undefined ? { session: r.session } : {}) };
    probes.set(`${r.tool}\u0000${r.target ?? ""}\u0000${r.operation ?? ""}\u0000${r.session ?? ""}`, { r, call });
  }
  for (const { r, call } of probes.values()) {
    const name = r.tool === "*" ? "outil" : r.tool;
    for (const fb of ["allow", "deny"] as const) {
      const l = line(`règle « ${r.tool} »${scopeWords(r)}`, name, fb, call);
      if (l) {
        out.push(l);
        break;
      }
    }
  }
  const starOf = (rules: readonly PermissionRule[]): Level | null => {
    const r = rules.find((x) => x.tool === "*" && !scoped(x));
    return r ? (r.decision === "allow" && r.autonomous ? "auto" : r.decision) : null;
  };
  for (const fb of ["allow", "deny"] as const) {
    const old = starOf(before) ?? fb;
    const next = starOf(after) ?? fb;
    if (RANK[next] <= RANK[old]) continue;
    out.push(`règle générale « * » : « ${LEVEL_WORD[old]} » devient « ${LEVEL_WORD[next]} »${fb === "deny" ? " pour un outil que le registre ne déclare pas" : ""}`);
    break;
  }
  return out;
}

/** Une règle bornée par une cible, une opération ou une conversation. */
const scoped = (r: PermissionRule) => r.target !== undefined || r.operation !== undefined || r.session !== undefined;

/** « sur « D:\demo\* », opération « subtitles », conversation « abc » » : le périmètre d'une règle, pour une phrase. */
export function scopeWords(r: PermissionRule): string {
  const parts: string[] = [];
  if (r.target !== undefined) parts.push(`sur « ${r.target} »`);
  if (r.operation !== undefined) parts.push(`opération « ${r.operation} »`);
  if (r.session !== undefined) parts.push(`conversation « ${r.session} »`);
  return parts.length ? ` ${parts.join(", ")}` : "";
}
