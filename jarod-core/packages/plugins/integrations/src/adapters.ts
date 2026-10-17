/**
 * Intégrations externes : chaque dépôt entre par un ADAPTATEUR versionné, déclaré ici, jamais par un code qui
 * ouvrirait un second canal d'exécution à côté de `executeGuardedTool`.
 *
 * Ce que `checkAdapter` impose (testé sur tout le registre) :
 *  - licence INFORMATIONNELLE (décision du 2026-10-17 : application strictement personnelle, jamais redistribuée
 *    ni offerte en service réseau) : le registre trace la provenance et la licence vérifiée à une date, et classe
 *    la licence (permissive / copyleft / inconnue) sans rien rejeter sur ce critère. Les NOTICE d'origine sont
 *    conservées dans docs/THIRD-PARTY-NOTICES.md ;
 *  - version épinglée (une étiquette ou un commit, jamais « latest ») ;
 *  - un repli explicite quand l'intégration échoue ;
 *  - `execution` ne peut valoir que « none » ou « via-guarded-tool » : un adaptateur ne s'exécute pas lui-même ;
 *  - benchmark d'abord : un adaptateur marqué sensible à la performance ne passe en `enforce` qu'avec un
 *    résultat de mesure enregistré ;
 *  - un filtre qui peut bloquer ne passe en `enforce` qu'avec un taux de faux positifs MESURÉ sous le seuil.
 */

export type AdapterMode = "disabled" | "observe" | "enforce";
export type AdapterStatus = "planned" | "adapter-ready" | "integrated" | "rejected" | "reference-only";

export interface AdapterManifest {
  id: string;
  repo: string;
  wave: "A" | "B" | "C" | "D" | "R" | "E";
  /** SPDX tel que vérifié sur le dépôt (voir `licenseCheckedAt`). */
  license: string;
  licenseCheckedAt: string;
  adapterVersion: string;
  /** Étiquette ou commit du composant externe. `null` tant que rien n'est embarqué (statut planned/rejected). */
  pinned: string | null;
  status: AdapterStatus;
  mode: AdapterMode;
  fallback: string | null;
  execution: "none" | "via-guarded-tool";
  perfSensitive: boolean;
  benchmark?: { ref: string; measuredAt: string };
  falsePositive?: { rate: number; corpus: string; measuredAt: string };
  notes?: string;
}

export class AdapterPolicyError extends Error {}

/** Licences permissives connues. Information de traçabilité : ne rejette plus rien. */
export const PERMISSIVE_LICENSES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "MPL-2.0", "MIT-0"]);
export const COPYLEFT_PATTERN = /(^|[^A-Z])(AGPL|SSPL|GPL|LGPL|BUSL|Commons-Clause)/i;
export type LicenseClass = "permissive" | "copyleft" | "unknown";

export function classifyLicense(license: string): LicenseClass {
  if (COPYLEFT_PATTERN.test(license)) return "copyleft";
  return PERMISSIVE_LICENSES.has(license) ? "permissive" : "unknown";
}
export const MAX_FALSE_POSITIVE_RATE = 0.02;

export function checkAdapter(m: AdapterManifest): string[] {
  const problems: string[] = [];
  const bad = (why: string) => problems.push(`${m.id} : ${why}`);

  if (m.status === "rejected") {
    if (m.mode !== "disabled") bad("un dépôt rejeté doit être « disabled »");
    if (m.pinned !== null) bad("un dépôt rejeté n'a rien d'épinglé");
    return problems;
  }
  if (!m.license) bad("licence non renseignée (provenance à tracer)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.licenseCheckedAt)) bad("date de vérification de la licence absente");
  if (m.execution !== "none" && m.execution !== "via-guarded-tool") bad(`execution « ${String(m.execution)} » : seule la porte unique est permise`);
  if (m.status === "integrated" || m.status === "adapter-ready") {
    if (!m.pinned || /^(latest|main|master|\*)$/i.test(m.pinned)) bad("version non épinglée");
    if (!m.fallback) bad("aucun repli déclaré");
  }
  if (m.mode === "enforce") {
    if (m.perfSensitive && !m.benchmark) bad("enforce sans benchmark enregistré (benchmark d'abord)");
    if (!m.falsePositive) bad("enforce sans taux de faux positifs mesuré");
    else if (m.falsePositive.rate > MAX_FALSE_POSITIVE_RATE) bad(`faux positifs ${m.falsePositive.rate} > ${MAX_FALSE_POSITIVE_RATE}`);
  }
  if (m.mode !== "disabled" && m.status === "planned") bad("un dépôt seulement prévu ne peut pas être actif");
  return problems;
}

export function assertAdapters(list: AdapterManifest[]): void {
  const ids = new Set<string>();
  const problems: string[] = [];
  for (const m of list) {
    if (ids.has(m.id)) problems.push(`${m.id} : doublon`);
    ids.add(m.id);
    problems.push(...checkAdapter(m));
  }
  if (problems.length) throw new AdapterPolicyError(problems.join("\n"));
}

const CHECKED = "2026-10-17";
const row = (
  id: string,
  repo: string,
  wave: AdapterManifest["wave"],
  license: string,
  status: AdapterStatus,
  notes: string,
  extra: Partial<AdapterManifest> = {},
): AdapterManifest => ({
  id,
  repo,
  wave,
  license,
  licenseCheckedAt: CHECKED,
  adapterVersion: "0.0.0",
  pinned: null,
  status,
  mode: "disabled",
  fallback: null,
  execution: "none",
  perfSensitive: false,
  notes,
  ...extra,
});

/** Le registre : l'état RÉEL de chaque dépôt du prompt maître au 2026-10-17. */
export const REGISTRY: AdapterManifest[] = [
  row("A1", "microsoft/mxc", "A", "MIT", "planned", "confinement des scripts générés et des outils MCP non approuvés ; vérifier l'exigence de version de Node avant embarquement"),
  row("A2", "sigstore/cosign", "A", "Apache-2.0", "integrated", "intégré en 0a (clé publique committée) ; chaîne CI à vérifier seulement si les secrets existent (réservé à l'humain)", { pinned: "cle-publique-committee", fallback: "refus de mise à jour non signée", adapterVersion: "1.0.0" }),
  row("A3", "microsoft/RAMPART", "A", "MIT", "adapter-ready", "les 7 scénarios obligatoires tournent contre la porte unique avec un faux modèle (agent/test/adversarial.test.ts) ; le dépôt lui-même n'est pas embarqué", { pinned: "scenarios-internes-v1", fallback: "suite interne seule", adapterVersion: "1.0.0" }),
  row("A4", "StackOneHQ/defender", "A", "Apache-2.0", "adapter-ready", "observateur d'injections en mode OBSERVATION (aucun blocage) avec détecteur de base et harnais de mesure des faux positifs ; le paquet n'est pas encore branché", { pinned: "observateur-base-v1", mode: "observe", fallback: "aucun filtre (comportement actuel)", adapterVersion: "1.0.0" }),
  row("A5", "promptfoo/promptfoo", "A", "MIT", "planned", "suite d'évaluation comportementale ; campagnes dans la sandbox dédiée seulement"),
  row("B1", "huggingface/transformers.js", "B", "Apache-2.0", "planned", "embeddings dans le paquet installé ; exige l'accord avant téléchargement du modèle, poids épinglés, test depuis l'installation empaquetée"),
  row("B2", "asg017/sqlite-vec", "B", "Apache-2.0", "planned", "PoC de compatibilité avec better-sqlite3-multiple-ciphers obligatoire ; repli MemoryVectorIndex"),
  row("B3", "docling-project/docling", "B", "MIT", "planned", "sidecar Python derrière le seam documentParser ; licences des modèles optionnels à auditer séparément"),
  row("B4", "panva/oauth4webapi", "B", "MIT", "planned", "McpOAuthManager : jetons dans le coffre uniquement"),
  row("B5", "microsoft/markitdown", "B", "MIT", "planned", "parsing ; extensions OCR autorisées (PyMuPDF, AGPL, informationnel) ; à brancher dans le sidecar Python"),
  row("C1", "snakers4/silero-vad", "C", "MIT", "planned", "VAD entre capture et Whisper"),
  row("C2", "k2-fsa/sherpa-onnx", "C", "Apache-2.0", "planned", "processus natif séparé, protocole local, aucun audio vers le cloud par défaut"),
  row("C3", "data-privacy-stack/presidio", "C", "MIT", "planned", "détection de PII avant tout envoi cloud ; couche supplémentaire, jamais une garantie absolue"),
  row("D1", "FlaUI/FlaUI", "D", "MIT", "planned", "sidecar .NET limité à 7 opérations sémantiques ; jamais d'exécution arbitraire"),
  row("D2", "pywinauto/pywinauto", "D", "BSD-3-Clause", "planned", "alternative UIA si FlaUI est insuffisant, mêmes contraintes"),
  row("D3", "microsoft/winget-cli", "D", "MIT", "planned", "identifiants exacts seulement ; jamais une ligne construite par un modèle"),
  row("R1", "modelcontextprotocol/typescript-sdk", "R", "MIT", "planned", "LICENSE en transition MIT → Apache-2.0 (contributions mixtes) : les deux sont permissives, à ré-examiner à l'embarquement ; dépendance directe du noyau"),
  row("R2", "microsoft/playwright", "R", "Apache-2.0", "reference-only", "tests E2E ; jamais le profil Chrome personnel"),
  row("R3", "open-telemetry/opentelemetry-js", "R", "Apache-2.0", "adapter-ready", "épurateur d'attributs (liste blanche : identifiants, durées, tailles, statuts, catégories d'erreur) ; le SDK n'est pas encore branché", { pinned: "epurateur-v1", fallback: "aucune télémétrie", adapterVersion: "1.0.0" }),
  row("R4", "temporalio/temporal", "R", "MIT", "reference-only", "concepts seulement (activités idempotentes, historique rejouable) → version SQLite minimale à écrire ; pas de serveur Temporal"),
  row("E1", "pinokiocomputer/pinokio", "E", "MIT", "adapter-ready", "phase 6B : moteur de recettes déterministe (recipes/), importeur de scripts JSON simples ; réécriture du comportement observé, aucune ligne de pinokiod reprise. Coexiste avec le moteur embarqué de l'ADR-022, sans le remplacer ni le modifier", { pinned: "pinokio@8.2.0-comportement-observe", fallback: "moteur Pinokio embarqué (ADR-022) pour les scripts hors sous-ensemble", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("E2", "browser-use/browser-harness", "E", "MIT", "planned", "QUESTION DE POSTURE pour l'humain : l'agent doit-il toucher le navigateur CONNECTÉ de l'utilisateur ? Aucun branchement avant la réponse"),
  row("X1", "linshenkx/prompt-optimizer", "E", "AGPL-3.0-only", "planned", "AGPL-3.0 (LICENSE vérifiée) : intégrable si pertinent depuis la révision de la politique (usage strictement personnel) ; NOTICE à conserver"),
  row("X2", "harness/harness", "E", "Apache-2.0", "rejected", "verdict déjà rendu : aucun cas d'usage"),
];
