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
 */
import type { PermissionDecision, PermissionRule } from "@jarod/contracts";
import type { SettingsService } from "@jarod/plugin-storage";

const norm = (s: string) => String(s).toLowerCase().replace(/[_/]/g, "");
/** Clé de `Settings` où vivent les règles de l'utilisateur (relues à chaud, jamais un secret). */
export const RULES_SETTINGS_KEY = "permissionsRules" as const;
/** Ce que vaut une règle absente : le registre décide (`allow` si l'outil y est déclaré), sinon refus. */
export const DECLARED_FALLBACK: PermissionDecision = "allow";

/** Du plus fermé au plus ouvert : sert à dire si un jeu de règles AFFAIBLIT le précédent. */
const RANK: Record<PermissionDecision, number> = { deny: 0, ask: 1, allow: 2 };

export class PermissionGuard {
  private rules: readonly PermissionRule[] = [];

  constructor(rules: readonly PermissionRule[] = []) {
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

  /** La décision de la première règle qui couvre l'outil, ou null si aucune ne le couvre. */
  match(toolName: string): PermissionDecision | null {
    const seg = String(toolName).split(/[_/]/)[0]!.toLowerCase();
    for (const r of this.rules) {
      if (r.tool === "*") return r.decision;
      if (r.tool === toolName) return r.decision;
      if (norm(r.tool) === norm(toolName)) return r.decision;
      if (norm(r.tool) === norm(seg)) return r.decision;
    }
    return null;
  }

  /** Décision seule (sémantique SANK-AI) : aucune règle → deny. */
  decide(toolName: string): PermissionDecision {
    return this.match(toolName) ?? "deny";
  }
}

/** Ce que consulte l'agent avant tout appel d'outil (`executeGuardedTool`). */
export interface ToolGate {
  decide(toolName: string): PermissionDecision;
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
export function unifiedGate(guard: PermissionGuard, declared: (toolName: string) => boolean): ToolGate {
  return { decide: (name) => guard.match(name) ?? (declared(name) ? DECLARED_FALLBACK : "deny") };
}

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
 */
export function rulesWeakenings(before: readonly PermissionRule[], after: readonly PermissionRule[]): string[] {
  const a = new PermissionGuard(before);
  const b = new PermissionGuard(after);
  const out: string[] = [];
  /** Ce que le nom rend avec ce repli (`fb`) avant et après ; la phrase s'il devient plus permissif, sinon null. */
  const line = (subject: string, name: string, fb: PermissionDecision): string | null => {
    const old = a.match(name) ?? fb;
    const next = b.match(name) ?? fb;
    if (RANK[next] <= RANK[old]) return null;
    return `${subject} : « ${old} » devient « ${next} »${fb === "deny" ? " pour un outil que le registre ne déclare pas" : ""}`;
  };
  for (const name of new Set([...before, ...after].map((r) => r.tool).filter((t) => t !== "*"))) {
    for (const fb of ["allow", "deny"] as const) {
      const l = line(`règle « ${name} »`, name, fb);
      if (l) {
        out.push(l);
        break; // une phrase par nom : le repli qui montre le changement suffit
      }
    }
  }
  const starOf = (rules: readonly PermissionRule[]) => rules.find((r) => r.tool === "*")?.decision ?? null;
  for (const fb of ["allow", "deny"] as const) {
    const old = starOf(before) ?? fb;
    const next = starOf(after) ?? fb;
    if (RANK[next] <= RANK[old]) continue;
    out.push(`règle générale « * » : « ${old} » devient « ${next} »${fb === "deny" ? " pour un outil que le registre ne déclare pas" : ""}`);
    break;
  }
  return out;
}
