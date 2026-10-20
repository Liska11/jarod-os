/**
 * Registre vivant des capacités du cockpit — les types.
 *
 * Une CAPACITÉ est ce que l'agent peut dire savoir faire. Elle ne remplace ni l'outil (`ToolRegistry` de plugin-tools, la seule
 * porte d'exécution, `executeGuardedTool`) ni l'adaptateur (`REGISTRY` de ce plugin, la provenance et la licence) : elle les RELIE,
 * et y ajoute ce que ni l'un ni l'autre ne savait dire — l'état opérationnel MAINTENANT, mesuré par une sonde.
 *
 * « Conscience » = connaissance opérationnelle vérifiable : chaque état affiché vient d'une sonde exécutée, jamais d'un document lu.
 */

/** Les états distingués (prompt maître § 3). `unknown` tant qu'aucune sonde n'a tourné. */
export type CapabilityState =
  | "unknown"
  | "not-installed"
  | "installed-unconfigured"
  | "available"
  | "degraded"
  | "blocked-permission"
  | "error";

/**
 * Ce que Jarod sait réellement FAIRE de la capacité. Distinct de l'état : un moteur peut être installé et sain sans que Jarod sache
 * encore le piloter. Ne jamais présenter `detection-only` ou `external-app` comme une intégration agent complète.
 *  - `agent-tool`      : un outil du registre l'exécute (nommé dans `tools`), derrière la porte unique ;
 *  - `skill`           : des instructions chargées à la demande (`load_skill`), sans exécution propre ;
 *  - `detection-only`  : Jarod détecte et diagnostique l'installation ; aucun outil ne l'exécute encore ;
 *  - `external-app`    : une application séparée ; Jarod peut au mieux la détecter (et l'ouvrir par `system_open`).
 */
export type IntegrationLevel = "agent-tool" | "skill" | "detection-only" | "external-app";

export type Risk = "read" | "act" | "mutate" | "destructive";

/** Où le travail a lieu. `remote` = des données quittent la machine ; jamais silencieux. */
export type Locality = "local" | "remote" | "mixed";

export interface CapabilityManifest {
  /** Identifiant stable, `<propriétaire>.<verbe>` (ex. `ghidra.static-analysis`). */
  id: string;
  name: string;
  description: string;
  categories: string[];
  /** Exemples d'intentions en langage courant : servent à la recherche par intention. */
  intents: string[];
  /** Adaptateur propriétaire (`AdapterManifest.id`) ou `builtin`. */
  owner: string;
  /** Les outils du registre qui l'exécutent (vide si aucun). */
  tools: string[];
  integration: IntegrationLevel;
  /** Schémas : d'entrée = celui de l'outil quand il existe ; de sortie = description courte du résultat. */
  input?: Record<string, unknown>;
  output: string;
  risk: Risk;
  sideEffects: string;
  locality: Locality;
  /** Ce qui doit être présent pour que la capacité soit disponible (affiché tel quel). */
  requires: string[];
  timeoutMs: number;
  /** Comment une exécution en cours s'arrête. */
  cancel: string;
  /** Comment le résultat est vérifié — jamais « le code retour était 0 ». */
  verification: string;
  artifacts: string[];
  limits: string[];
  /** Expérimentale : désactivable, jamais présentée comme générale. */
  experimental?: boolean;
}

/** Le résultat d'une sonde : un état, le détail lisible, ce qui a été trouvé. Aucune valeur de secret. */
export interface ProbeResult {
  state: Exclude<CapabilityState, "unknown" | "blocked-permission">;
  detail: string;
  version?: string;
  /** Chemins ou commandes réellement trouvés (preuve). */
  found?: string[];
  /** Ce qui manque, nommément. */
  missing?: string[];
}

export interface CapabilityView extends CapabilityManifest {
  state: CapabilityState;
  detail: string;
  version?: string;
  found?: string[];
  missing?: string[];
  /** Décision de la porte de permissions pour chaque outil (`allow` / `ask` / `deny`), lue à la vérification. */
  permissions: Record<string, "allow" | "ask" | "deny">;
  /** Horodatage de la dernière sonde (ms), `null` si jamais sondée. */
  checkedAt: number | null;
  /** Provenance : dépôt, licence, version épinglée — copiées de l'adaptateur, jamais d'une page web. */
  provenance?: { repo: string; license: string; pinned: string | null; status: string };
}
