/**
 * Administration des permissions (autonomie configurable, 2026-10-21) : UNE seule autorité, la liste `settings.permissionsRules` lue par le garde.
 * Ce module ne décide rien de plus que le garde : il valide une liste (le bridge et la commande `jarod permissions` passent par la même
 * validation), la décrit, explique une décision, et PRÉPARE un ajout, une révocation ou une réinitialisation — avec les affaiblissements à faire
 * confirmer par l'utilisateur. Écrire reste le travail d'un canal de l'utilisateur (confirmation native du bureau, commande tapée au terminal) ;
 * aucun outil de l'agent n'appelle ces fonctions pour écrire.
 */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { PermissionRule } from "@jarod/contracts";
import { type CallScope, type Resolution, ruleSpent, rulesWeakenings, scopeWords } from "./guard.js";

/**
 * La cible d'une règle qui est un chemin absolu, ramenée à son chemin RÉEL : les outils de fichiers donnent au garde des chemins réels
 * (`operationTargets`, une jonction ne fait pas sortir du dossier autorisé). Sans cela, une règle écrite avec un nom court (« RUNNER~1 »), un
 * lien ou une jonction ne couvrait jamais l'appel et l'accord était redemandé. Seuls les dossiers COMPLETS avant le premier joker sont résolus
 * (le plus proche qui existe) ; le reste du motif est gardé tel quel. Une cible qui n'est pas un chemin (hôte, motif) est rendue inchangée.
 */
export function canonicalTarget(target: string): string {
  if (!isAbsolute(target)) return target;
  const star = target.indexOf("*");
  const fixed = star < 0 ? target : target.slice(0, star);
  const cut = star < 0 ? target.length : Math.max(fixed.lastIndexOf("\\"), fixed.lastIndexOf("/")) + 1;
  const head = target.slice(0, cut);
  if (!head) return target;
  const rest: string[] = [];
  let cur = resolve(head);
  for (;;) {
    try {
      const real = join(realpathSync.native(cur), ...rest.reverse());
      if (real.toLowerCase() === resolve(head).toLowerCase()) return target;
      return real + (/[\\/]$/.test(head) ? (real.includes("\\") ? "\\" : "/") : "") + target.slice(cut);
    } catch {
      const up = dirname(cur);
      if (up === cur) return target;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

/** Plafond des règles de permissions de l'utilisateur : au-delà, c'est une liste qu'aucun écran ne peut montrer. */
export const MAX_PERMISSION_RULES = 200;
/** Une autorisation temporaire dure au plus 30 jours : au-delà, c'est une règle permanente qui ne dit pas son nom. */
export const MAX_TEMPORARY_MS = 30 * 24 * 3_600_000;
/** Un `tool` de règle : un nom d'outil, un segment de famille ou le joker `*`. Ni espace ni caractère de contrôle (AV2-008). */
export const ruleToolOk = (s: string): boolean => /^[A-Za-z0-9_./*-]+$/.test(s);
const RULE_KEYS = ["tool", "decision", "target", "expiresAt", "autonomous", "operation", "session", "uses", "id", "note", "createdAt", "by"] as const;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f]/;

type Bad = (key: string, why: string) => never;
const defaultBad: Bad = (key, why) => {
  throw new Error(`[oneai] réglage « ${key} » : ${why}`);
};

/** La clé qui distingue deux règles : l'ordre compte, une règle n'apparaît qu'une fois. */
export const ruleKey = (r: PermissionRule): string => `${r.tool}${scopeWords(r)}`;

/**
 * Valide une liste de règles telle qu'un écran ou une commande l'envoie, et rend la liste NORMALISÉE (champs connus seulement). Lève au premier
 * défaut, avec `bad(clé, raison)` : un patch à moitié valide n'écrit rien.
 */
export function normalizeRules(v: unknown, now: number, bad: Bad = defaultBad): PermissionRule[] {
  if (!Array.isArray(v)) return bad("permissionsRules", "liste de règles attendue");
  if (v.length > MAX_PERMISSION_RULES) return bad("permissionsRules", `au plus ${MAX_PERMISSION_RULES} règles`);
  const seen = new Set<string>();
  const ids = new Set<string>();
  return v.map((raw, i) => {
    const at = `permissionsRules[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad(at, "objet attendu");
    const extra = Object.keys(raw).filter((k) => !(RULE_KEYS as readonly string[]).includes(k));
    if (extra.length) bad(at, `clé(s) inconnue(s) : ${extra.join(", ")}`);
    const parsed = PermissionRule.safeParse(raw);
    if (!parsed.success) return bad(at, parsed.error.issues[0]!.message);
    const r = parsed.data;
    const tool = r.tool.trim();
    if (tool !== r.tool || tool.length > 64) bad(`${at}.tool`, "nom d'outil borné à 64 caractères, sans espace autour");
    if (!ruleToolOk(tool)) bad(`${at}.tool`, "nom d'outil, segment de famille ou « * » (lettres, chiffres, . _ / -)");
    // Cockpit, lot 2 : une cible (motif, `*` = toute suite) et une échéance (autorisation temporaire), optionnelles.
    if (r.target !== undefined && (r.target !== r.target.trim() || CONTROL.test(r.target))) bad(`${at}.target`, "cible sans espace autour ni caractère de contrôle");
    if (r.expiresAt !== undefined && (r.expiresAt <= now || r.expiresAt > now + MAX_TEMPORARY_MS)) bad(`${at}.expiresAt`, "échéance dans le futur, à 30 jours au plus");
    if (r.operation !== undefined && !/^[A-Za-z0-9_.*:-]+$/.test(r.operation)) bad(`${at}.operation`, "opération : lettres, chiffres, . _ * : -");
    if (r.session !== undefined && !/^[A-Za-z0-9_-]+$/.test(r.session)) bad(`${at}.session`, "identifiant de conversation : lettres, chiffres, _ et -");
    if (r.note !== undefined && CONTROL.test(r.note)) bad(`${at}.note`, "note sans caractère de contrôle");
    // Le garde ne retire une utilisation qu'à une exécution ACCORDÉE : un refus ou une demande « à N utilisations » ne s'épuiserait jamais.
    if (r.uses !== undefined && r.decision !== "allow") bad(`${at}.uses`, "un nombre d'utilisations borne une autorisation : seulement avec allow");
    if (r.id !== undefined) {
      if (ids.has(r.id)) bad(`${at}.id`, `identifiant en double : ${r.id}`);
      ids.add(r.id);
    }
    const key = ruleKey({ ...r, tool });
    if (seen.has(key)) bad(`${at}.tool`, `règle en double : ${key} (l'ordre compte, une règle n'apparaît qu'une fois)`);
    seen.add(key);
    const out: PermissionRule = { tool, decision: r.decision };
    for (const k of RULE_KEYS) if (k !== "tool" && k !== "decision" && r[k] !== undefined) (out as Record<string, unknown>)[k] = r[k];
    return out;
  });
}

/** Un identifiant court pour lister et révoquer une règle (« p-3f9a2c »). */
export const newRuleId = (): string => `p-${randomBytes(3).toString("hex")}`;

const DECISION_WORD = { deny: "refuser", ask: "demander à chaque fois", allow: "autoriser (l'accord des outils sensibles reste demandé)" } as const;

/** Une phrase par règle : décision, périmètre, bornes, état. `n` = position affichée (1 = première, celle qui gagne). */
export function describeRule(r: PermissionRule, n: number, now: number): string {
  const what = r.decision === "allow" && r.autonomous ? "autoriser SANS accord" : DECISION_WORD[r.decision];
  const bounds: string[] = [];
  if (r.expiresAt !== undefined) bounds.push(`jusqu'au ${new Date(r.expiresAt).toLocaleString("fr-FR")}`);
  if (r.uses !== undefined) bounds.push(`${r.uses} utilisation(s) restante(s)`);
  const spent = ruleSpent(r, now);
  return [
    `${n}. ${r.id ?? "(sans id)"} — ${what} « ${r.tool} »${scopeWords(r)}`,
    bounds.length ? ` ; ${bounds.join(", ")}` : "",
    spent ? ` [${spent}, ne joue plus]` : "",
    r.note ? ` — ${r.note}` : "",
    r.by ? ` (par ${r.by === "commande" ? "la commande" : "les réglages"})` : "",
  ].join("");
}

/** Ce que l'explication sait de l'outil (le registre de l'agent) : il existe, il est sensible, il réserve certaines opérations. */
export interface ToolFacts {
  exists: boolean;
  dangerous: boolean;
  /** Une opération réservée que rien n'a accordée (voir `reservedReason`) : la raison, ou null. */
  restricted?: string | null;
  /** Le bouton « Toujours autoriser » est refusé pour cet outil (NEVER_ALWAYS) : la raison, ou null. */
  neverAlways?: string | null;
}

/**
 * Une opération RÉSERVÉE (`ToolDef.restrictedOperations`) que rien n'a accordée : la raison, ou null. Il faut une règle de l'utilisateur qui
 * couvre l'appel — le joker « * » sans opération ne compte pas (une règle large posée pour autre chose n'ouvre pas une opération réservée).
 */
export function reservedReason(res: Resolution, operation: string | null, reserved: Readonly<Record<string, string>> | undefined): string | null {
  const why = operation !== null && reserved && Object.hasOwn(reserved, operation) ? reserved[operation]! : null;
  if (!why) return null;
  const explicit = res.source === "règle" && !(res.rule?.tool === "*" && res.rule.operation === undefined);
  return explicit ? null : why;
}

const quote = (s: string) => (/^[A-Za-z0-9_.:*\\/-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** La commande que l'UTILISATEUR taperait pour accorder ce périmètre (jamais exécutée par Jarod). */
export function grantCommand(tool: string, call: CallScope, autonomous: boolean): string {
  const parts = ["jarod permissions add", autonomous ? "auto" : "allow", tool];
  if (call.targets && call.targets.length === 1) parts.push("--cible", quote(call.targets[0]!));
  if (typeof call.operation === "string") parts.push("--operation", quote(call.operation));
  if (autonomous) parts.push("--duree", "1j");
  return parts.join(" ");
}

/**
 * Pourquoi le garde rend cette décision pour cet appel, en clair : « je sais faire, mais cette permission manque » plutôt que « je ne sais pas ».
 * `res` vient de `ToolGate.resolve` (ou `resolveWith`) ; `facts` du registre.
 */
export function explainResolution(tool: string, call: CallScope, res: Resolution, facts: ToolFacts, now = Date.now()): { verdict: "refusé" | "accord demandé" | "autorisé sans accord" | "autorisé"; why: string; howTo?: string } {
  if (!facts.exists) return { verdict: "refusé", why: `Aucun outil « ${tool} » n'est déclaré : ce n'est pas une permission qui manque, la capacité n'existe pas (ou elle est désactivée).` };
  const rule = res.rule ? ` (règle ${res.rule.id ?? `n° ${(res.index ?? 0) + 1}`} : ${describeRule(res.rule, (res.index ?? 0) + 1, now).replace(/^\d+\. /, "")})` : "";
  if (res.decision === "deny") {
    return {
      verdict: "refusé",
      why: `Je sais faire « ${tool} », mais une règle de permissions le refuse${rule}.`,
      howTo: `L'utilisateur peut révoquer cette règle (jarod permissions revoke ${res.rule?.id ?? (res.index ?? 0) + 1}) ou placer une autorisation avant elle (${grantCommand(tool, call, false)}).`,
    };
  }
  if (facts.restricted) {
    return {
      verdict: "refusé",
      why: `Je sais faire « ${tool} » avec l'opération « ${String(call.operation)} », mais elle est réservée à une permission explicite que personne n'a accordée : ${facts.restricted}.`,
      howTo: `L'utilisateur peut l'accorder : ${grantCommand(tool, call, false)}`,
    };
  }
  if (res.autonomous) return { verdict: "autorisé sans accord", why: `Autorisé sans accord dans ce périmètre${rule}.` };
  if (res.decision === "ask" || facts.dangerous) {
    const reason = res.decision === "ask" ? `une règle demande l'accord${rule}` : "c'est un outil sensible : l'accord est demandé à chaque appel";
    return {
      verdict: "accord demandé",
      why: `Je sais faire « ${tool} » ; ${reason}.`,
      howTo: `Pour l'autonomie dans un périmètre borné, l'utilisateur peut taper : ${grantCommand(tool, call, true)}${facts.neverAlways ? ` (le bouton « Toujours autoriser » reste refusé pour cet outil : ${facts.neverAlways} ; une règle bornée est la voie prévue)` : ""}.`,
    };
  }
  return { verdict: "autorisé", why: `Autorisé${res.source === "règle" ? rule : " (outil déclaré, sans accord requis)"}.` };
}

/** Ce que l'utilisateur demande d'ajouter, avant validation. */
export interface GrantInput {
  tool: string;
  decision: "allow" | "ask" | "deny";
  autonomous?: boolean;
  target?: string;
  operation?: string;
  session?: string;
  /** Durée en ms à partir de maintenant ; absente = permanente. */
  durationMs?: number;
  uses?: number;
  note?: string;
  /** Accepter une autonomie SANS aucune borne (ni cible, ni opération, ni conversation, ni durée, ni nombre) : choix explicite. */
  broad?: boolean;
  /** `start` (défaut) : la règle passe avant les autres et gagne ; `end` : après. */
  position?: "start" | "end";
  /** Le canal de l'utilisateur qui écrit : la commande tapée au terminal (défaut) ou l'écran Réglages. */
  by?: "commande" | "réglages";
}

export interface Plan {
  rules: PermissionRule[];
  /** Ce que l'utilisateur doit lire avant de confirmer : la règle, puis ce qui s'ouvre. */
  summary: string[];
  weakenings: string[];
}

/** Prépare l'ajout d'une règle : validation complète (la même que l'écran), périmètre affiché, affaiblissements à confirmer. */
export function planGrant(current: readonly PermissionRule[], input: GrantInput, now: number): Plan {
  if (input.autonomous && input.decision !== "allow") throw new Error("« auto » = autoriser sans accord : seulement avec allow");
  const bounded = input.target !== undefined || input.operation !== undefined || input.session !== undefined || input.durationMs !== undefined || input.uses !== undefined;
  if (input.autonomous && !bounded && !input.broad) {
    throw new Error(
      `Autonomie sans aucune borne pour « ${input.tool} » : précisez --cible, --operation, --session, --duree ou --utilisations, ou confirmez le choix large avec --large.`,
    );
  }
  if (input.durationMs !== undefined && !(input.durationMs > 0 && input.durationMs <= MAX_TEMPORARY_MS)) throw new Error("durée : de 1 minute à 30 jours");
  const rule: PermissionRule = {
    tool: input.tool,
    decision: input.decision,
    ...(input.autonomous ? { autonomous: true as const } : {}),
    ...(input.target !== undefined ? { target: canonicalTarget(input.target) } : {}),
    ...(input.operation !== undefined ? { operation: input.operation } : {}),
    ...(input.session !== undefined ? { session: input.session } : {}),
    ...(input.durationMs !== undefined ? { expiresAt: now + input.durationMs } : {}),
    ...(input.uses !== undefined ? { uses: input.uses } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    id: newRuleId(),
    createdAt: now,
    by: input.by ?? "commande",
  };
  // Une règle de même périmètre est REMPLACÉE (une seule règle par périmètre) ; les échues et épuisées sont retirées au passage.
  const kept = current.filter((r) => ruleKey(r) !== ruleKey(rule) && !ruleSpent(r, now));
  const rules = normalizeRules(input.position === "end" ? [...kept, rule] : [rule, ...kept], now);
  const replaced = current.find((r) => ruleKey(r) === ruleKey(rule));
  const summary = [
    `Règle : ${describeRule(rule, input.position === "end" ? rules.length : 1, now).replace(/^\d+\. /, "")}`,
    input.position === "end" ? "Placée après les règles existantes : une règle plus haut qui couvre le même appel gagne." : "Placée en tête : elle gagne sur les règles existantes pour ce périmètre.",
    ...(replaced ? [`Remplace : ${describeRule(replaced, current.indexOf(replaced) + 1, now).replace(/^\d+\. /, "")}`] : []),
    ...(rule.autonomous ? ["Restent actifs : interrupteur Internet, mode Plan, emplacements protégés, garde du shell, journal d'audit, annulation."] : []),
  ];
  const weakenings = rulesWeakenings(current, rules);
  for (const w of replaced ? longerBounds(replaced, rule) : []) if (!weakenings.includes(w)) weakenings.push(w);
  return { rules, summary, weakenings };
}

/** La position d'une règle désignée par identifiant ou par position (1 = première) ; lève si elle n'existe pas. */
function indexOfRule(current: readonly PermissionRule[], ref: string): number {
  const n = /^\d+$/.test(ref) ? Number(ref) - 1 : current.findIndex((r) => r.id === ref);
  if (n < 0 || !current[n]) throw new Error(`Aucune règle « ${ref} » (voir jarod permissions list)`);
  return n;
}

/**
 * Une autorisation qui garde son niveau mais dont la borne s'allonge (plus d'utilisations, échéance plus lointaine ou retirée) donne aussi plus
 * de pouvoir : `rulesWeakenings` compare des niveaux, ceci compare les bornes d'une même règle.
 */
export function longerBounds(before: PermissionRule, next: PermissionRule): string[] {
  if (next.decision !== "allow" || before.decision !== "allow") return [];
  const name = `règle « ${next.tool} »${scopeWords(next)}`;
  const out: string[] = [];
  if (before.uses !== undefined && (next.uses === undefined || next.uses > before.uses)) out.push(`${name} : ${next.uses === undefined ? "nombre d'utilisations retiré" : `${before.uses} → ${next.uses} utilisation(s)`}`);
  if (before.expiresAt !== undefined && (next.expiresAt === undefined || next.expiresAt > before.expiresAt)) out.push(`${name} : ${next.expiresAt === undefined ? "devient permanente" : "échéance repoussée"}`);
  if (!before.autonomous && next.autonomous) out.push(`${name} : devient « sans accord »`);
  return out;
}

/** Ce qu'une modification change d'une règle existante ; `null` retire la borne (cible, opération, conversation, échéance, nombre, note). */
export interface RuleChange {
  decision?: "allow" | "ask" | "deny";
  autonomous?: boolean;
  target?: string | null;
  operation?: string | null;
  session?: string | null;
  /** Nouvelle durée à partir de maintenant ; `null` = permanente. */
  durationMs?: number | null;
  uses?: number | null;
  note?: string | null;
  broad?: boolean;
  by?: "commande" | "réglages";
}

/**
 * Prépare la modification d'une règle EN PLACE (même position, même identifiant, même date de création) : mêmes contrôles qu'un ajout — une
 * autonomie sans borne exige le choix large explicite, la durée reste dans les 30 jours — et les affaiblissements à confirmer.
 */
export function planUpdate(current: readonly PermissionRule[], ref: string, change: RuleChange, now: number): Plan {
  const n = indexOfRule(current, ref);
  const before = current[n]!;
  const next: PermissionRule = { ...before, id: before.id ?? newRuleId(), by: change.by ?? before.by ?? "commande" };
  const set = <K extends "target" | "operation" | "session" | "uses" | "note">(k: K, v: PermissionRule[K] | null | undefined) => {
    if (v === undefined) return;
    if (v === null) delete next[k];
    else next[k] = v;
  };
  if (change.decision !== undefined) next.decision = change.decision;
  if (change.autonomous !== undefined) {
    if (change.autonomous) next.autonomous = true;
    else delete next.autonomous;
  }
  if (next.decision !== "allow") delete next.autonomous;
  set("target", typeof change.target === "string" ? canonicalTarget(change.target) : change.target);
  set("operation", change.operation);
  set("session", change.session);
  set("uses", change.uses);
  set("note", change.note);
  if (change.durationMs === null) delete next.expiresAt;
  else if (change.durationMs !== undefined) {
    if (!(change.durationMs > 0 && change.durationMs <= MAX_TEMPORARY_MS)) throw new Error("durée : de 1 minute à 30 jours");
    next.expiresAt = now + change.durationMs;
  }
  const bounded = next.target !== undefined || next.operation !== undefined || next.session !== undefined || next.expiresAt !== undefined || next.uses !== undefined;
  if (next.autonomous && !bounded && !change.broad) {
    throw new Error(`Autonomie sans aucune borne pour « ${next.tool} » : précisez une cible, une opération, une conversation, une durée ou un nombre d'utilisations, ou confirmez le choix large.`);
  }
  const rules = normalizeRules(
    current.map((r, i) => (i === n ? next : r)),
    now,
  );
  return {
    rules,
    summary: [`Avant : ${describeRule(before, n + 1, now).replace(/^\d+\. /, "")}`, `Après : ${describeRule(next, n + 1, now).replace(/^\d+\. /, "")}`],
    weakenings: [...rulesWeakenings(current, rules), ...longerBounds(before, next)],
  };
}

/** Prépare le déplacement d'une règle (la première qui couvre un appel gagne : monter une autorisation au-dessus d'un refus l'affaiblit). */
export function planMove(current: readonly PermissionRule[], ref: string, to: number, now: number): Plan {
  const n = indexOfRule(current, ref);
  const dest = Math.max(0, Math.min(current.length - 1, to - 1));
  const rules = [...current];
  const [moved] = rules.splice(n, 1);
  rules.splice(dest, 0, moved!);
  return { rules: normalizeRules(rules, now), summary: [`Déplacer en position ${dest + 1} : ${describeRule(moved!, n + 1, now).replace(/^\d+\. /, "")}`], weakenings: rulesWeakenings(current, rules) };
}

/** Prépare la révocation d'une règle, par identifiant ou par position (1 = première). Lève si elle n'existe pas. */
export function planRevoke(current: readonly PermissionRule[], ref: string, now: number): Plan {
  const n = indexOfRule(current, ref);
  const target = current[n]!;
  const rules = current.filter((_, i) => i !== n);
  return { rules, summary: [`Révoquer : ${describeRule(target, n + 1, now).replace(/^\d+\. /, "")}`], weakenings: rulesWeakenings(current, rules) };
}

/**
 * Rejoue un plan préparé sur `base` contre la liste RELUE juste avant d'écrire (`fresh`). Pendant la confirmation (code au terminal, boîte
 * native), le garde a pu retirer une utilisation : le compteur relu l'emporte pour toute règle dont le plan ne change pas le nombre — une
 * écriture ne rend jamais une utilisation consommée. Si des règles ont été ajoutées, retirées ou modifiées autrement entre-temps (un autre
 * écran, la commande), rien n'est écrit : lève, l'utilisateur relit et recommence.
 */
export function rebaseRules(base: readonly PermissionRule[], fresh: readonly PermissionRule[], planned: readonly PermissionRule[]): PermissionRule[] {
  const sansUses = (r: PermissionRule) => JSON.stringify({ ...r, uses: undefined });
  if (base.length !== fresh.length || base.some((r, i) => sansUses(r) !== sansUses(fresh[i]!))) {
    throw new Error("Les règles ont changé pendant la confirmation (un autre écran ou la commande) : rien n'a été écrit, relisez-les et recommencez.");
  }
  const key = (r: PermissionRule) => r.id ?? sansUses(r);
  const before = new Map(base.map((r) => [key(r), r]));
  const now = new Map(fresh.map((r) => [key(r), r]));
  return planned.map((r) => {
    const b = before.get(key(r));
    const f = now.get(key(r));
    return b && f && r.uses !== undefined && r.uses === b.uses && f.uses !== undefined && f.uses !== b.uses ? { ...r, uses: f.uses } : r;
  });
}

/** Prépare la réinitialisation : toutes les règles de l'utilisateur retirées (retour au registre : outils sensibles avec accord). */
export function planReset(current: readonly PermissionRule[], now: number): Plan {
  return {
    rules: [],
    summary: [`Retirer les ${current.length} règle(s) :`, ...current.map((r, i) => `  ${describeRule(r, i + 1, now)}`), "Ensuite : chaque outil déclaré est permis, les outils sensibles demandent l'accord à chaque appel."],
    weakenings: rulesWeakenings(current, []),
  };
}
