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
  row("A1", "microsoft/mxc", "A", "MIT", "adapter-ready", "confinement des scripts générés et des outils MCP non approuvés ; vérifier l'exigence de version de Node avant embarquement ; TESTÉ contre MXC réel (ProcessContainer) : écriture hors zone, lecture d'un dossier interdit, réseau et délai tenus ; mesuré : ui.disable=true empêche node de démarrer, et node doit être lancé avec --preserve-symlinks. BRANCHÉ à run_shell (2026-10-17) comme mécanisme `mxc` du garde du shell, essayé après jarod-sandbox, actif seulement si JAROD_MXC_RUNNER et JAROD_MXC_SDK sont réglés (lanceur sidecars/mxc-run) ; testé par l'outil run_shell : écriture dans la zone, hors zone refusée avec témoin, secrets du coffre non transmis donc refusés ; mesuré : la commande interne dir de cmd est refusée, node et PowerShell listent", { pinned: "@microsoft/mxc-sdk@1.0.1", fallback: "run_shell avec isolation workspace (jarod-sandbox 3.1/3.2)", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("A2", "sigstore/cosign", "A", "Apache-2.0", "integrated", "intégré en 0a (clé publique committée) ; chaîne CI à vérifier seulement si les secrets existent (réservé à l'humain)", { pinned: "cle-publique-committee", fallback: "refus de mise à jour non signée", adapterVersion: "1.0.0" }),
  row("A3", "microsoft/RAMPART", "A", "MIT", "adapter-ready", "les 7 scénarios obligatoires tournent contre la porte unique avec un faux modèle (agent/test/adversarial.test.ts) ; le dépôt lui-même n'est pas embarqué", { pinned: "scenarios-internes-v1", fallback: "suite interne seule", adapterVersion: "1.0.0" }),
  row("A4", "StackOneHQ/defender", "A", "Apache-2.0", "adapter-ready", "observateur d'injections en mode OBSERVATION (aucun blocage) avec détecteur de base et harnais de mesure des faux positifs ; le paquet n'est pas encore branché", { pinned: "observateur-base-v1", mode: "observe", fallback: "aucun filtre (comportement actuel)", adapterVersion: "1.0.0" }),
  row("A5", "promptfoo/promptfoo", "A", "MIT", "adapter-ready", "suite d'évaluation comportementale ; campagnes dans la sandbox dédiée seulement ; TESTÉ : la configuration exportée est exécutée par promptfoo réel (fournisseur echo, hors ligne)", { pinned: "promptfoo@0.124.1", fallback: "suite interne runSuite (sans promptfoo)", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("B1", "huggingface/transformers.js", "B", "Apache-2.0", "adapter-ready", "embeddings dans le paquet installé ; exige l'accord avant téléchargement du modèle, poids épinglés, test depuis l'installation empaquetée ; TESTÉ avec le moteur réel : poids épinglés SHA-256, altération d'un octet refusée, aucun téléchargement sans accord, vecteurs sémantiques 384 dimensions. Reste : preuve depuis l'installation empaquetée", { pinned: "@huggingface/transformers@4.3.1 + Xenova/all-MiniLM-L6-v2@751bff3", fallback: "moteur OpenVINO existant (plugins/embeddings)", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("B2", "asg017/sqlite-vec", "B", "Apache-2.0", "adapter-ready", "PoC de compatibilité avec better-sqlite3-multiple-ciphers obligatoire ; repli MemoryVectorIndex ; TESTÉ : PoC d'ABI réel dans better-sqlite3-multiple-ciphers 13.0.3, base en clair ET chiffrée", { pinned: "sqlite-vec@0.1.9", fallback: "MemoryIndex exact en mémoire", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("B3", "docling-project/docling", "B", "MIT", "adapter-ready", "sidecar Python derrière le seam documentParser ; licences des modèles optionnels à auditer séparément ; TESTÉ avec Docling réel (docx, pptx, xlsx, html, pdf natif) ; le CLI docling exige la pile complète, un script de conversion natif le remplace ; profil sans modèle : PDF sans titres ni tableaux ; profil COMPLET (PyTorch) testé aussi : titre et tableau d'un PDF reconnus", { pinned: "docling-slim@2.140.0 (profil sans PyTorch)", fallback: "analyseur builtin du plugin rag", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("B4", "panva/oauth4webapi", "B", "MIT", "adapter-ready", "McpOAuthManager : jetons dans le coffre uniquement ; TESTÉ contre oauth4webapi réel (défi PKCE identique, validation de redirection) et un serveur de jetons HTTP local", { pinned: "oauth4webapi@3.8.8", fallback: "aucun OAuth : les serveurs MCP à jeton statique restent possibles", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("B5", "microsoft/markitdown", "B", "MIT", "adapter-ready", "parsing ; extensions OCR autorisées (PyMuPDF, AGPL, informationnel) ; à brancher dans le sidecar Python ; TESTÉ avec markitdown réel (HTML, PDF avec --use-plugins) ; sortie nettoyée des caractères invisibles", { pinned: "markitdown@0.1.8 + pymupdf@1.28.2", fallback: "analyseur builtin du plugin rag", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("C1", "snakers4/silero-vad", "C", "MIT", "adapter-ready", "VAD entre capture et Whisper ; TESTÉ avec le modèle ONNX réel sur de la parole synthétisée : segment dans la bonne zone, silence et bruit blanc ignorés", { pinned: "silero-vad@v5.1.2 (silero_vad.onnx sha256 2623a295…)", fallback: "énergie RMS (energyScorer)", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("C2", "k2-fsa/sherpa-onnx", "C", "Apache-2.0", "adapter-ready", "processus natif séparé, protocole local, aucun audio vers le cloud par défaut ; TESTÉ avec le modèle réel hors ligne (parole synthétisée) ; le moteur ne rend pas de confiance ; moteur distant refusé par défaut", { pinned: "sherpa-onnx@1.13.8 + zipformer-en-20M-2023-02-17", fallback: "Whisper existant", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("C3", "data-privacy-stack/presidio", "C", "MIT", "adapter-ready", "détection de PII avant tout envoi cloud ; couche supplémentaire, jamais une garantie absolue ; TESTÉ contre Presidio réel : ce que la couche locale masque est reconnu par Presidio ; l'union masque aussi noms et lieux ; Presidio est anglais seulement dans ce profil", { pinned: "presidio-analyzer@2.2.364 + en_core_web_sm@3.8.0", fallback: "couche locale maskPii (regex + clés de contrôle)", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("D1", "FlaUI/FlaUI", "D", "MIT", "adapter-ready", "sidecar .NET limité à 7 opérations sémantiques ; jamais d'exécution arbitraire ; TESTÉ sur une fenêtre WinForms fabriquée : saisie, clic, lecture, champ protégé jamais rempli", { pinned: "FlaUI.UIA3@5.0.0 (sidecar .NET)", fallback: "pywinauto (D2)", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("D2", "pywinauto/pywinauto", "D", "BSD-3-Clause", "adapter-ready", "alternative UIA si FlaUI est insuffisant, mêmes contraintes ; TESTÉ sur la même fenêtre fabriquée ; politique de gouvernance commune (processus permis/interdits, accord par action, débit)", { pinned: "pywinauto@0.6.9", fallback: "FlaUI (D1)", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("D3", "microsoft/winget-cli", "D", "MIT", "adapter-ready", "identifiants exacts seulement ; jamais une ligne construite par un modèle ; TESTÉ avec winget réel en lecture seule (show, search, list) ; aucune installation lancée par les tests", { pinned: "winget@v1.29.380 (version de la machine)", fallback: "aucun : sans winget, indisponible", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("R1", "modelcontextprotocol/typescript-sdk", "R", "MIT", "adapter-ready", "LICENSE en transition MIT → Apache-2.0 (contributions mixtes) : les deux sont permissives, à ré-examiner à l'embarquement ; dépendance directe du noyau ; TESTÉ contre un serveur construit avec le SDK officiel : aperçu avant activation, épinglage, rug-pull retenu, désactivation après 3 échecs. Le SDK n'est qu'une dépendance de test", { pinned: "@modelcontextprotocol/sdk@1.32.1", fallback: "client MCP existant (McpClient)", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("R2", "microsoft/playwright", "R", "Apache-2.0", "integrated", "tests E2E ; jamais le profil Chrome personnel ; TESTÉ : 8 tests e2e sur le shell construit, profil jetable ; mutation-testés", { pinned: "@playwright/test (devDependency de apps/desktop)", fallback: "tests unitaires seuls", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("R3", "open-telemetry/opentelemetry-js", "R", "Apache-2.0", "adapter-ready", "épurateur d'attributs (liste blanche : identifiants, durées, tailles, statuts, catégories d'erreur) ; le SDK n'est pas encore branché", { pinned: "epurateur-v1", fallback: "aucune télémétrie", adapterVersion: "1.0.0" }),
  row("R4", "temporalio/temporal", "R", "MIT", "adapter-ready", "concepts seulement (activités idempotentes, historique rejouable) → version SQLite minimale à écrire ; pas de serveur Temporal ; TESTÉ sur SQLite réel : reprise depuis une AUTRE connexion sans rejouer les activités terminées, plafond d'échecs, masquage", { pinned: "concepts-temporal-v1 (durable.ts)", fallback: "exécution sans historique", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("E1", "pinokiocomputer/pinokio", "E", "MIT", "adapter-ready", "phase 6B : moteur de recettes déterministe (recipes/), importeur de scripts JSON simples ; réécriture du comportement observé, aucune ligne de pinokiod reprise. Coexiste avec le moteur embarqué de l'ADR-022, sans le remplacer ni le modifier", { pinned: "pinokio@8.2.0-comportement-observe", fallback: "moteur Pinokio embarqué (ADR-022) pour les scripts hors sous-ensemble", execution: "via-guarded-tool", adapterVersion: "1.0.0" }),
  row("E2", "browser-use/browser-harness", "E", "MIT", "planned", "POSTURE décidée par l'humain (2026-10-17) : le navigateur connecté est permis, avec un accord explicite PAR OPÉRATION (lectures comprises) et un journal (opération, hôte, résultat — jamais l'adresse complète, le contenu ni le texte saisi). Contrat et politique testés avec un moteur simulé (liste blanche obligatoire, liste noire prioritaire, jamais de champ de mot de passe, aucune opération cookies/stockage/profil). Statut « prévu » tant que le moteur browser-harness n'est ni installé, ni épinglé, ni testé (contrat dans impl/browser.ts) : aucun branchement à un outil ni à l'interface"),
  row("X1", "linshenkx/prompt-optimizer", "E", "AGPL-3.0-only", "planned", "AGPL-3.0 (LICENSE vérifiée) : intégrable si pertinent depuis la révision de la politique (usage strictement personnel) ; NOTICE à conserver"),
  row("X2", "harness/harness", "E", "Apache-2.0", "rejected", "verdict déjà rendu : aucun cas d'usage"),
];
