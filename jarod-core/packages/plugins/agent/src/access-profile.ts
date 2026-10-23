/**
 * V-09 — les préréglages de profil d'accès, AU-DESSUS des règles (docs/PERMISSIONS-AUTONOMIE.md, « Profils d'accès ») :
 *  - `ask`     Demander      : chaque appel demande l'accord, lectures comprises ; ni « Toujours autoriser », ni autonomie par règle ;
 *  - `approve` M'approuver   : les outils sensibles demandent, les lectures revues passent ; l'interrupteur global « sans demander » est ignoré ;
 *  - `full`    Plein         : rien ne demande, sauf les LIMITES DURES et ce qu'une règle « demander » impose ;
 *  - `custom`  Personnalisé  : exactement le comportement réglé à la main (interrupteur global, « Toujours autoriser », règles). Défaut : un
 *                              profil existant ne change pas de comportement.
 *
 * LIMITES DURES : les outils qui ont perdu « Toujours autoriser » (`NEVER_ALWAYS`, décisions de l'utilisateur) demandent l'accord à chaque appel
 * sous TOUS les préréglages, Plein compris. Seule une règle explicite, bornée et confirmée par la personne (allow + autonomous) peut en dispenser :
 * c'est un geste par outil et par périmètre, jamais l'effet d'un préréglage. Personnalisé garde ce que la personne a réglé.
 *
 * Aucun profil ne lève ce qui est hors de l'accord : refus de règle, opérations réservées, interrupteur Internet, mode Plan, garde propre à
 * l'outil (emplacements protégés, processus critiques, garde du shell), journal, tâche et annulation. L'agent ne peut pas changer de profil :
 * aucun outil n'écrit les réglages, et passer à un profil plus permissif demande la confirmation native.
 */
import { NEVER_ALWAYS } from "./never-always.js";

export type AccessProfile = "ask" | "approve" | "full" | "custom";

export const ACCESS_PROFILES: readonly AccessProfile[] = ["ask", "approve", "full", "custom"];

/** Les limites dures : aucune préréglage ne les lève. */
export const HARD_LIMITS: ReadonlySet<string> = NEVER_ALWAYS;

export function isAccessProfile(value: unknown): value is AccessProfile {
  return typeof value === "string" && (ACCESS_PROFILES as readonly string[]).includes(value);
}

export interface ApprovalFacts {
  profile: AccessProfile;
  tool: string;
  dangerous: boolean;
  /** La décision du garde de permissions pour cet appel (`deny` est traité avant, et refuse sous tout profil). */
  verdict: "allow" | "ask";
  autoApproveTools: boolean;
  /** « Toujours autoriser » pour cet outil (déjà filtré par `NEVER_ALWAYS`). */
  alwaysAllowed: boolean;
}

/** Vrai si l'appel doit passer par la demande d'accord (après les refus, avant l'exécution). */
export function needsApproval(f: ApprovalFacts): boolean {
  if (f.verdict === "ask") return true;
  switch (f.profile) {
    case "ask":
      return true;
    case "approve":
      return f.dangerous && !f.alwaysAllowed;
    case "full":
      return HARD_LIMITS.has(f.tool);
    case "custom":
      return f.dangerous && !f.autoApproveTools && !f.alwaysAllowed;
  }
}

/** Une règle « sans accord » (allow + autonomous) joue-t-elle sous ce profil ? Pas sous Demander, qui demande tout. */
export function autonomyHonoured(profile: AccessProfile): boolean {
  return profile !== "ask";
}

/**
 * Le pouvoir que le profil laisse à l'agent, pour savoir si un changement AFFAIBLIT (et demande la confirmation native). Personnalisé vaut ce
 * qu'il règle : Plein si l'interrupteur global est allumé, sinon M'approuver.
 */
export function profilePower(profile: AccessProfile, autoApproveTools: boolean): number {
  switch (profile) {
    case "ask":
      return 0;
    case "approve":
      return 1;
    case "full":
      return 2;
    case "custom":
      return autoApproveTools ? 2 : 1;
  }
}
