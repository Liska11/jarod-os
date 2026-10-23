/**
 * Vague G (prompt « plus3 », 2026-10-20) : les 17 dépôts retenus, au même registre que la vague F (une seule source de vérité).
 *
 * Chaque entrée dit l'étape RÉELLE (`stage`) : évalué, testé isolément, intégré, bloqué (avec sa raison), différé… et une sonde mesure
 * l'état sur la machine. Un dépôt seulement évalué rend « non installé » avec sa raison, jamais « disponible ». Les outils de
 * développement et de QA sont marqués `dev-tool` : ils ne sont pas des capacités de l'agent.
 *
 * Les moteurs vivent dans `engines/` (hors dépôt) ; l'application les trouve par une variable dédiée ou par `JAROD_ENGINES_DIR`.
 */
import type { AdapterManifest, IntegrationStage } from "../adapters.js";
import type { CockpitIntegration, Probe } from "./catalog.js";
import { cli, notInstalled, type ProbeHost, program } from "./probe.js";
import type { CapabilityManifest } from "./types.js";

const CHECKED = "2026-10-20";
const FALLBACK = "capacité affichée comme indisponible ; aucune action";

interface GSpec {
  id: string;
  repo: string;
  license: string;
  pinned: string | null;
  stage: IntegrationStage;
  stageReason?: string;
  status?: AdapterManifest["status"];
  execution?: AdapterManifest["execution"];
  fallback?: string;
  notes: string;
}

const g = (s: GSpec): AdapterManifest => ({
  id: s.id,
  repo: s.repo,
  wave: "G",
  stage: s.stage,
  ...(s.stageReason ? { stageReason: s.stageReason } : {}),
  license: s.license,
  licenseCheckedAt: CHECKED,
  adapterVersion: s.status === "adapter-ready" || s.status === "integrated" ? "1.0.0" : "0.0.0",
  pinned: s.pinned,
  status: s.status ?? "planned",
  mode: "disabled",
  fallback: s.fallback ?? FALLBACK,
  execution: s.execution ?? "none",
  perfSensitive: false,
  notes: s.notes,
});

export const PLUS3_ADAPTERS: AdapterManifest[] = [
  g({ id: "G1", repo: "anchore/syft", license: "Apache-2.0", pinned: "v1.54.1 (b254e6d, sha256 zip 8b56e828…)", stage: "tested-isolated", status: "adapter-ready", notes: "OUTIL DE DÉVELOPPEMENT : inventaire (SBOM CycloneDX) du paquet Windows réellement produit (`pnpm run sbom:scan`), complété par les paquets groupés (métafichier esbuild → BUNDLE.json) et les moteurs épinglés (engines.lock) ; comparaison de deux inventaires ; contrôle des modules natifs déclarés. N'est PAS un scan de sécurité. Testé contre Syft réel (4 tests) et sur le paquet du 19/10 : 3 défauts de paquet trouvés (modules natifs absents)." }),
  g({ id: "G2", repo: "open-telemetry/opentelemetry-js", license: "Apache-2.0", pinned: "@opentelemetry/sdk-trace-base@2.11.0 + @opentelemetry/api@1.9.1", stage: "integrated", status: "integrated", fallback: "aucune trace (réglage éteint)", notes: "Traces LOCALES de la boucle réelle : tour → appel au modèle → appel d'outil (attente d'accord, exécution, annulation), fournisseur privé (jamais global), exporteur JSONL écrit ici (rotation, rétention, désactivation), épurateur R3 au début et à l'export ; aucun export réseau. Réglage `localTraces`, éteint par défaut. Testé dans la boucle réelle (5 tests) et sur le SDK réel (6 tests). Prolonge R3." }),
  g({ id: "G3", repo: "ethz-spylab/agentdojo", license: "MIT", pinned: "agentdojo==0.1.35 (engines.lock/agentdojo-requirements.txt, empreintes)", stage: "integrated", status: "adapter-ready", notes: "BANC DE TEST (jamais dans la boucle de l'utilisateur) : les 70 cas du benchmark v1.2 (2 attaques) rejoués contre la boucle RÉELLE avec un modèle qui cède ; issues distinguées (réussie / bloquée par couche / non applicable / tâche échouée). Mesuré : 68 non applicables (pas d'e-mail, de banque ni d'agenda chez Jarod, ou injection sur le texte seul), 2 bloquées à l'accord, 0 réussie ; observateur A4 : 0/70 charges détectées (défaut G3-F1). Complète promptfoo (A5) et A3." }),
  g({ id: "G4", repo: "restic/restic", license: "BSD-2-Clause", pinned: "v0.19.1 (restic_0.19.1_windows_amd64.zip, sha256 da948ad7…, = SHA256SUMS)", stage: "integrated", status: "integrated", notes: "RACCORDÉ à Réglages › Stockage le 2026-10-21 (clé rangée par DPAPI via safeStorage, jamais dans une sauvegarde ni dans la fenêtre ; feuille de récupération écrite par la boîte native ; archivage après chaque sauvegarde réussie ; instantanés, vérification, restauration par le moteur existant ; e2e dans l'application réelle). Module `apps/desktop/electron/restic-backup.ts` SOUS la sauvegarde externe : n'archive qu'un dossier de sauvegarde Jarod COMPLET et revérifié (mêmes exclusions, base sans valeurs du coffre, arrêt cohérent du noyau) ; manifeste Jarod DANS l'instantané (deux formats séparés) ; restauration extraite en dossier temporaire, revérifiée, puis mise en place par `stageRestore`/`swapIn` (état précédent gardé) ; jamais forget/prune/unlock/key ni réinitialisation d'un dépôt ; clé hors des données sauvegardées + feuille de récupération ; aucune migration de l'ancien format ; métadonnées Windows non présumées conservées. Testé contre restic réel (5 tests : déduplication mesurée, restauration, exclusions relues, refus). PAS ENCORE RACCORDÉ à l'écran : de nouveaux canaux IPC attendent BL-01 (contrôle d'émetteur), et le rangement de la clé (DPAPI de la coquille) reste à écrire." }),
  g({ id: "G5", repo: "yt-dlp/yt-dlp", license: "Unlicense", pinned: "2026.08.19 (yt-dlp.exe, sha256 66674953…, = SHA2-256SUMS de la release)", stage: "integrated", status: "adapter-ready", execution: "via-guarded-tool", notes: "Outil de l'agent `media_fetch` : métadonnées, sous-titres (originaux ; automatiques seulement sur demande, toujours dits automatiques) ou audio d'UNE vidéo, rangés dans `.jarod-media/` du dossier de travail. Outil Internet (INTERNET_TOOLS : refusé hors ligne avant tout accord), accord à chaque appel, cible = l'hôte ; jamais de cookies ni de configuration lue ; hôtes privés refusés ; requête jamais reprise ; durée, taille et espace disque bornés ; progression et annulation. Le programme yt-dlp n'est pas coupé du réseau par une barrière (X-04) : la porte décide qu'il ne démarre pas. Testé contre yt-dlp réel sur un serveur local fabriqué (7 tests) et dans la boucle réelle (2)." }),
  g({ id: "G6", repo: "mostlygeek/llama-swap", license: "MIT", pinned: "v262 (079c35a, sha256 zip fae48594…, = checksums de la release)", stage: "evaluated", notes: "MESURÉ (banc test/engines/llama-swap.engine.test.ts, serveurs factices). Bascule à la demande, réponse en cours préservée pendant une bascule, déchargement après inactivité (ttl), aucun orphelin. RÉEXAMEN 2026-10-21 (recadrage de l'utilisateur), configuré comme Jarod le ferait : `-listen 127.0.0.1:<port>` + `apiKeys` → llama-swap ET ses modèles n'écoutent que sur 127.0.0.1 (mesuré) ; sans clé, TOUT répond 401, administration comprise (/running, /unload, /logs, /ui, /upstream) ; CORS `*` (v262) sans danger tant que la clé est exigée (une page étrangère sans clé : 401) ; groupe sans bascule = deux modèles servis en même temps (mesuré) ; lance nvidia-smi de lui-même (mesuré, machine NVIDIA). L'écoute sur toutes les interfaces n'était qu'un défaut corrigeable. DÉCISION : pas de remplacement du gestionnaire actuel (llama.cpp installé et vérifié, préréglages, LM Studio, hotswap ; même GPU : deux superviseurs se disputeraient la mémoire) ; FOURNISSEUR OPTIONNEL justifié pour deux usages distincts — plusieurs modèles en mémoire à la fois (groupes) et moteurs que Jarod ne gère pas (vLLM, whisper-server, serveurs d'images) derrière une adresse unique — branché par le fournisseur « Personnalisé (compatible OpenAI) » existant, clé dans le coffre, sans nouveau code. REPRIS NATIVEMENT le 2026-10-21 dans le gestionnaire de Jarod (local-models.ts) : une bascule attend la fin de la réponse en cours (sinon refusée après 5 min, jamais coupée) ; déchargement après inactivité (idleUnloadMinutes, éteint par défaut, seulement ce que Jarod a chargé)." }),
  g({ id: "G7", repo: "CursorTouch/Windows-MCP", license: "MIT", pinned: "windows-mcp==0.8.7 (venv Python 3.14, engines.lock/windows-mcp-requirements.txt, empreintes)", stage: "evaluated", notes: "BANC (test/engines/windows-mcp.engine.test.ts, MCP stdio réel, AUCUNE action de bureau jouée). Catalogue complet : 20 outils dont PowerShell, Registry, FileSystem, Process, Clipboard, Scrape. RÉEXAMEN 2026-10-21 (recadrage de l'utilisateur) : `--tools` garde EXACTEMENT les outils choisis (mesuré : un outil écarté répond « Unknown tool ») ; ANONYMIZED_TELEMETRY=false → aucune requête sortante (témoin PostHog ET proxy HTTP(S)) et aucun identifiant persistant (mesuré). Profil retenu, ce que Jarod n'a pas déjà : DisplayInventory, WaitFor, Wait, Move (glisser-déposer), MultiSelect (sélection multiple) ; perception à part : Screenshot, Snapshot (capture et arbre de TOUT l'écran). Écartés : PowerShell, FileSystem, Process, App (doublons d'outils gardés par Jarod), Scrape (contournerait les gardes de web_fetch), Shortcut (Win+R, Alt+Tab : hors de toute fenêtre), Click, Type, Scroll, MultiEdit (desktop_control les fait, bornés à une fenêtre), Registry (sans emplacements protégés : à faire en outil natif), Clipboard (lirait des mots de passe copiés), Notification (sans apport). DÉCISION : FOURNISSEUR OPTIONNEL par le mécanisme MCP existant (chaque outil sensible : accord à chaque appel, refusé hors ligne sans « commandes locales »), JAMAIS le contrôleur principal (D1 FlaUI : fenêtre comme cible de règle, premier plan et point constatés). Limites : coordonnées d'écran absolues (aucune fenêtre comme cible de règle), vrai bureau, Python 3.14 + venv." }),
  g({ id: "G8", repo: "reladraw/reladraw", license: "Apache-2.0 (code ; le nom et le logo exclus)", pinned: "0.16.0 (npm, aucune dépendance ; engines.lock/node/reladraw, intégrité sha512-wf7OVpTH…)", stage: "integrated", status: "adapter-ready", execution: "via-guarded-tool", notes: "Lot C (2026-10-21). PAS un second outil : diagram_export (F5) accepte maintenant une source .reladraw — un texte où l'on PLACE les éléments (« right of », « below », arêtes légendées), mis en page par le moteur, à côté du .html de diagram-design écrit à la main. Rendu dans un processus Node À PART sous le modèle de permissions (lecture : moteur et source ; écriture : un dossier temporaire ; aucun processus enfant) — mesuré : une écriture ailleurs est refusée. Déclaration XML ajoutée, SVG vérifié (preuve de l'export), source gardée dans l'artefact ; une erreur de syntaxe est rendue avec sa ligne. Testé contre le moteur réel (3 tests)." }),
  g({ id: "G9", repo: "modelcontextprotocol/inspector", license: "MIT (transition vers Apache-2.0 ; SPDX NOASSERTION)", pinned: "@modelcontextprotocol/inspector@2.9.0 (engines.lock/node/mcp-inspector)", stage: "tested-isolated", status: "adapter-ready", notes: "OUTIL DE DÉVELOPPEMENT à la demande (`pnpm run mcp:inspect`) : bouclage, jeton par instance (absent de l'URL et de la sortie), secrets en mémoire (sinon Inspector écrit dans le trousseau Windows), profil redirigé dans un dossier temporaire, port occupé jamais libéré de force, arrêt de SA seule instance ; lecture de catalogue (tools/resources/prompts) sans méthode d'appel. Testé contre Inspector réel et le serveur du SDK officiel (4 tests)." }),
  g({ id: "G10", repo: "smol-machines/smolvm", license: "Apache-2.0", pinned: "1.30.1 (smolvm-1.30.1-windows-x86_64.zip, sha256 f3cc430c… = condensat GitHub ; engines/smolvm)", stage: "integrated", status: "adapter-ready", execution: "via-guarded-tool", notes: "Outils de l'agent linux_prepare (outil Internet : télécharge l'image, puis réseau coupé), linux_run, linux_reset (impl/smolvm.ts), sur une machine que Jarod possède (« jarod »). MESURÉ (banc réel, machine de test supprimée) : noyau 6.18.55, Alpine 3.24.2 ; WHP DÉJÀ active ; Mode développeur activé par l'utilisateur (liens symboliques du système Linux) ; sur Windows 10.0.26300, une socket AF_UNIX ne se connecte pas sous AppData\\Local ni Roaming (WSAEINVAL, reproduit hors smolvm en .NET ; Temp, Packages, profil et D: fonctionnent) → %LOCALAPPDATA%\\smolvm est une JONCTION vers engines/smolvm-data ; l'image se télécharge DANS la VM, une VM éphémère la retélécharge : machine persistante, créée avec réseau puis update --no-net ; réseau coupé : aucune sortie ; dossier de travail en lecture seule (écriture refusée) ou en écriture (opération réservée) ; code de retour transmis ; délai respecté ; 2 vCPU / 1 Gio (≈ 1,1 Go hôte au lieu de ≈ 6), machine arrêtée après chaque commande. Distinct de Sandboxie (applications Windows) et de jarod-sandbox (AppContainer)." }),
  g({ id: "G11", repo: "bytedance/UI-TARS-desktop", license: "Apache-2.0", pinned: null, stage: "deferred", stageReason: "exige un modèle de vision (téléchargement volumineux ou fournisseur distant) et apporte sa propre boucle d'agent ; banc commun du 2026-10-20 : FlaUI reste le chemin principal, UI-TARS seulement comme perception si un besoin visuel apparaît", notes: "Perception visuelle et boucle agentique complètes : au mieux une capacité spécialisée (perception), jamais un second orchestrateur." }),
  g({ id: "G12", repo: "Louis-CFM/coucou", license: "MIT (code) ; nom Coucou, personnage Mochi et sons © Louis Raillé", pinned: "idée seulement — aucun code ni ressource repris (README de main consulté le 2026-10-21)", stage: "integrated", status: "integrated", notes: "Lot C (2026-10-21). IDÉE reprise, aucun code copié, ni le nom, ni Mochi, ni les sons : la MINI-FENÊTRE du shell (apps/desktop/electron/mini-window.ts, public/mini.html) — un îlot en haut de l'écran qui dit ce que fait Jarod (conversations qui répondent, sous-agents) et ce qui attend une réponse (accord, question), même fenêtre principale cachée ; allumée depuis le menu de l'icône (préférence miniWindow, éteinte par défaut). ÉCART voulu avec Coucou : LECTURE SEULE — tant que BL-01 n'est pas entièrement levé, aucune nouvelle surface ne donne d'accord ; un clic ramène la fenêtre principale, où l'on répond. Sa page et son preload sont à part (il ne fait que RECEVOIR) ; le résumé vient de la fenêtre principale par un seul canal, accepté d'elle seule et re-validé (textes bornés, jamais le texte d'une demande de secret ou de mot de passe). Testé : 6 unitaires, 1 de bout en bout dans l'application réelle (profil jetable)." }),
  g({ id: "G13", repo: "osquery/osquery", license: "Apache-2.0 OR GPL-2.0-only (au choix)", pinned: "5.23.1 (osqueryi, zip windows_x86_64, sha256 7bd41105…, Authenticode LF Projects valide)", stage: "integrated", status: "adapter-ready", execution: "via-guarded-tool", notes: "Outil de l'agent `system_diagnostics` : 10 raccourcis prédéfinis, 3 diagnostics paramétrés (service-status, port-owner, program ; valeur validée), et la requête libre `sql` — opération RÉSERVÉE, refusée tant qu'une règle de l'utilisateur ne l'accorde pas (autonomie configurable, 2026-10-21 ; tables réseau curl refusées). osqueryi sans démon, droits de l'utilisateur, sans base ni journal ni extension, profil redirigé ; ni chemin ni ligne de commande des processus, ni comptes ni historique ; erreurs SQL détectées sur la sortie d'erreur (code de retour 0 mesuré) ; résultats horodatés avec provenance ; lecture seule et auditée. Complète les outils système (`system_*`). Testé contre osquery réel (13 tests)." }),
  g({ id: "G14", repo: "LaurieWired/GhidraMCP", license: "Apache-2.0", pinned: null, stage: "evaluated", notes: "Pont retenu entre les deux candidats (catalogue plus restreint, lecture et renommage) ; bethington/ghidra-mcp (Apache-2.0, 209 outils) ÉCARTÉ : émulation P-code et débogueur vivant = exécution de la cible. Les deux exigent une session Ghidra GRAPHIQUE avec greffon ; le chemin principal reste ghidra_analyze (headless, la cible n'est jamais exécutée, F4)." }),
  g({ id: "G15", repo: "sandboxie-plus/Sandboxie", license: "GPL-3.0 (informationnel : usage personnel)", pinned: "Sandboxie-Plus 1.18.8 (installé par l'utilisateur le 2026-10-21 ; sha256 f27078ff… = condensat GitHub ; Authenticode « NOVASYNC LABS PTE. LTD. », même certificat que 1.18.5)", stage: "integrated", status: "adapter-ready", execution: "via-guarded-tool", notes: "Outils de l'agent sandbox_run, sandbox_changes, sandbox_discard (impl/sandboxie.ts) sur un bac que Jarod possède (« Jarod »). MESURÉ (banc réel, bac de test retiré ensuite) : écritures du programme dans C:\\Sandbox\\<utilisateur>\\<bac>, jamais dans le vrai profil ; ClosedFilePath=InternetAccessDevices coupe le réseau, bouclage compris (témoin local : 0 requête) ; code de retour transmis ; vidage effectif ; configuration par SbieSvc SANS élévation, vue seulement après Start.exe /reload ; l'interface Sandboxie-Plus réécrit la section d'un bac (modèles, blocage réseau AVEC exception curl) : Jarod relit Sandboxie.ini et refuse si le réseau n'est pas celui demandé. Réseau ouvert = opération réservée (run.network) ; refusé quand Internet est coupé pour Jarod. Distinct de jarod-sandbox (AppContainer, commandes) et de smolvm (VM Linux)." }),
  g({ id: "G16", repo: "alibaba/open-code-review", license: "Apache-2.0", pinned: "v1.12.12 (182898c, sha256 c34033f9…)", stage: "integrated", status: "adapter-ready", execution: "via-guarded-tool", notes: "Outil de l'agent `code_review_plan` : plan de revue (OpenCodeReview en délégation, SANS modèle ni réseau), relu ensuite par l'agent avec ses fournisseurs. Revue complète `runReview` contre un modèle LOCAL par défaut ; distant = accord explicite. Profil redirigé, jeton par l'environnement seulement, aucune écriture dans le dépôt, constats avec ligne retrouvée et extrait cité, jamais appliqués. Testé contre OpenCodeReview réel (5 tests, dont une revue complète contre un faux modèle local)." }),
  g({ id: "G17", repo: "trycua/cua", license: "MIT", pinned: null, stage: "deferred", stageReason: "exige des bureaux virtuels (Windows Sandbox = fonctionnalité Windows à activer, ou VM) : accord requis ; c'est le bureau isolé qui manque pour jouer des actions GUI au banc", notes: "Environnement de bureau et banc d'évaluation d'agents « computer use » : candidat pour l'environnement isolé du banc, pas comme orchestrateur." }),
];

// ---- sondes ----

const join = (...p: string[]) => p.join("\\");

/** Un moteur : variable dédiée, sinon `JAROD_ENGINES_DIR\<sous-chemin>`, sinon `null`. */
function engineFile(host: ProbeHost, envVar: string, ...rel: string[]): string | null {
  const own = host.env[envVar];
  if (own && host.exists(own)) return own;
  const root = host.env.JAROD_ENGINES_DIR;
  if (root && host.exists(join(root, ...rel))) return join(root, ...rel);
  return null;
}

/** Un dépôt seulement évalué ou bloqué : jamais « disponible », toujours avec sa raison. */
const pending = (what: string, why: string): Probe => async () => notInstalled(what, `${what} : ${why}`);

/** Un exécutable trouvé par variable, moteur ou PATH, et sa version. */
const binary =
  (label: string, envVar: string, rel: string[], pathName: string | null, args: string[] = ["--version"]): Probe =>
  async (host) => {
    const file = engineFile(host, envVar, ...rel);
    const c = file ? await program(host, file, label, args) : pathName ? await cli(host, pathName, label, args) : { kind: "absent" as const, result: notInstalled(label, `${label} introuvable (${envVar} ou JAROD_ENGINES_DIR)`) };
    if (c.kind !== "ok") return c.result;
    return { state: "available", detail: "programme trouvé", ...(c.version ? { version: c.version } : {}), found: [c.file] };
  };

type Cap = CapabilityManifest & { probe: Probe };

const base: { tools: string[]; artifacts: string[]; timeoutMs: number; cancel: string; risk: Cap["risk"]; locality: Cap["locality"]; sideEffects: string } = {
  tools: [],
  artifacts: [],
  timeoutMs: 8000,
  cancel: "rien à annuler : la sonde a un délai court",
  risk: "read",
  locality: "local",
  sideEffects: "aucun (détection)",
};

const cap = (adapter: string, c: Omit<Cap, keyof typeof base | "owner"> & Partial<typeof base>): CockpitIntegration => ({ adapter, capabilities: [{ ...base, ...c, owner: adapter }] });

export const PLUS3_INTEGRATIONS: CockpitIntegration[] = [
  cap("G1", {
    id: "syft.sbom",
    name: "Inventaire des composants (SBOM)",
    description: "Inventaire CycloneDX du paquet Windows réellement produit, avec couverture et défauts de paquet ; comparaison de deux versions. Outil de développement.",
    categories: ["développement", "qa", "licences"],
    intents: ["inventaire des dépendances", "générer un sbom", "comparer deux versions du paquet"],
    integration: "dev-tool",
    output: "sbom.json (jarod-sbom/1), RAPPORT.md, fichiers CycloneDX",
    requires: ["Syft (JAROD_SYFT ou JAROD_ENGINES_DIR\\syft\\syft.exe)", "un paquet construit (win-unpacked)"],
    verification: "syft version répond ; le rapport liste couvert / partiel / non couvert / défaut",
    artifacts: ["dist/sbom/<horodatage>/"],
    limits: ["pas un scan de sécurité", "code groupé couvert seulement par la liste écrite au groupage (BUNDLE.json)", "moteurs hors paquet : déclarés, présence non prouvée"],
    probe: binary("Syft", "JAROD_SYFT", ["syft", "syft.exe"], "syft", ["version"]),
  }),
  cap("G2", {
    id: "otel.local-traces",
    name: "Traces locales (OpenTelemetry)",
    description: "Traces corrélées tour → modèle → outil (attente d'accord, exécution, annulation), écrites en JSONL dans le profil, jamais exportées.",
    categories: ["observabilité", "diagnostic"],
    intents: ["mesurer le temps d'attente des accords", "tracer les appels d'outils", "diagnostiquer une lenteur"],
    integration: "infrastructure",
    output: "<profil>\\traces\\spans-AAAAMMJJ-N.jsonl",
    requires: ["Réglage localTraces allumé"],
    verification: "le réglage est lu ; les fichiers apparaissent au tour suivant",
    limits: ["identifiants, noms d'outils, fournisseurs, durées et statuts seulement", "aucun export réseau", "rotation 5 Mo, rétention 7 jours par défaut"],
    probe: async (_h, ctx) => {
      const c = ctx.setting?.("localTraces") as { enabled?: boolean; retentionDays?: number } | undefined;
      if (c?.enabled) return { state: "available", detail: `traces locales actives (rétention ${c.retentionDays ?? 7} j)` };
      return { state: "installed-unconfigured", detail: "SDK embarqué ; réglage localTraces éteint (défaut)", missing: ["réglage localTraces"] };
    },
  }),
  cap("G3", {
    id: "agentdojo.injection-bench",
    name: "Banc d'injections (AgentDojo)",
    description: "Rejoue le corpus d'injections d'AgentDojo contre la porte d'outils de Jarod. Outil de QA, jamais dans la boucle de l'utilisateur.",
    categories: ["qa", "sécurité"],
    intents: ["tester les injections de prompt", "banc adversarial"],
    integration: "dev-tool",
    output: "issues classées : réussie, bloquée (couche), non applicable, tâche échouée",
    requires: ["venv engines\\agentdojo (JAROD_AGENTDOJO_PY ou JAROD_ENGINES_DIR)"],
    verification: "le venv existe ; le banc tourne par vitest (agent/test/agentdojo.engine.test.ts)",
    limits: ["modèle qui cède (simulé) : mesure la porte, pas le modèle", "68/70 cas sans équivalent chez Jarod"],
    probe: async (host) => {
      const py = engineFile(host, "JAROD_AGENTDOJO_PY", "agentdojo", "Scripts", "python.exe");
      return py ? { state: "available", detail: "venv présent", found: [py] } : notInstalled("venv AgentDojo");
    },
  }),
  cap("G4", { id: "restic.backup", name: "Dépôt de sauvegardes chiffré (restic)", description: "Archive chaque sauvegarde externe réussie dans un dépôt restic chiffré et dédupliqué (Réglages › Stockage › Archive chiffrée), et en restaure un instantané après revérification.", categories: ["sauvegarde"], intents: ["sauvegarder avec restic", "dépôt de sauvegarde chiffré", "archive chiffrée"], integration: "infrastructure", output: "état de l'installation", requires: ["restic (JAROD_RESTIC ou JAROD_ENGINES_DIR\\restic\\restic.exe)"], verification: "restic version répond", limits: ["clé rangée par Windows (DPAPI) sur ce PC : gardez la feuille de récupération hors du PC et du disque", "jamais de forget ni de prune", "sans la clé, le dépôt est illisible (feuille de récupération)"], probe: binary("restic", "JAROD_RESTIC", ["restic", "restic.exe"], "restic", ["version"]) }),
  cap("G5", { id: "yt-dlp.media-text", name: "Texte d'une vidéo en ligne (yt-dlp)", description: "Métadonnées, sous-titres originaux ou automatiques (dits comme tels) ou audio d'une vidéo, pour un traitement local. Ne voit pas les images.", categories: ["vidéo", "transcription"], intents: ["récupérer les sous-titres d'une vidéo", "transcrire une vidéo en ligne", "résumer une vidéo youtube"], tools: ["media_fetch"], integration: "agent-tool", risk: "act", locality: "mixed", sideEffects: "écrit un fichier dans .jarod-media/ du dossier de travail", output: "texte des sous-titres avec son origine, ou chemin du fichier audio", requires: ["yt-dlp (JAROD_YTDLP ou JAROD_ENGINES_DIR\\yt-dlp\\yt-dlp.exe)", "Internet allumé"], verification: "yt-dlp --version répond", limits: ["une seule vidéo, pas de direct", "jamais de cookies : vidéos publiques seulement", "audio : transcription locale à faire ensuite", "le programme n'est pas isolé du réseau (X-04) ; la porte le refuse hors ligne"], probe: binary("yt-dlp", "JAROD_YTDLP", ["yt-dlp", "yt-dlp.exe"], "yt-dlp") }),
  cap("G6", { id: "llama-swap.model-switch", name: "Bascule de modèles locaux (llama-swap)", description: "Proxy local de modèles (compatible OpenAI) : plusieurs modèles en mémoire à la fois (groupes), moteurs que Jarod ne gère pas derrière une adresse unique. Fournisseur optionnel ; ne remplace pas le gestionnaire de modèles locaux de Jarod.", categories: ["modèle"], intents: ["changer de modèle local"], integration: "detection-only", output: "état de l'installation", requires: ["llama-swap"], verification: "llama-swap --version répond", limits: ["fournisseur OPTIONNEL : fournisseur « Personnalisé (compatible OpenAI) », adresse http://127.0.0.1:<port>/v1, clé dans le coffre", "configuration exigée : -listen 127.0.0.1:<port> et apiKeys (sans clé, CORS ouvert à toute page web)", "ne pas faire tourner en même temps que le moteur llama.cpp de Jarod sur le même GPU", "lance nvidia-smi périodiquement (machine NVIDIA)"], probe: binary("llama-swap", "JAROD_LLAMA_SWAP", ["llama-swap", "llama-swap.exe"], "llama-swap") }),
  cap("G7", { id: "windows-mcp.desktop-actions", name: "Actions Windows par MCP (Windows-MCP)", description: "Fournisseur MCP optionnel pour ce que FlaUI (D1) ne fait pas : glisser-déposer, sélection multiple, attente d'une condition d'interface, géométrie des écrans, et (à part) capture et arbre de tout l'écran. Outils choisis par --tools, télémétrie coupée.", categories: ["bureau", "automatisation"], intents: ["automatiser une application windows par mcp"], integration: "detection-only", risk: "act", output: "état de l'installation", requires: ["Python 3.14+", "windows-mcp"], verification: "windows-mcp --help répond", limits: ["fournisseur OPTIONNEL, jamais le contrôleur principal (D1 FlaUI)", "profil : --tools DisplayInventory,WaitFor,Wait,Move,MultiSelect (perception à part : Screenshot,Snapshot) ; ANONYMIZED_TELEMETRY=false", "coordonnées d'écran absolues : aucune fenêtre comme cible de règle ; accord à chaque appel", "agit sur le vrai bureau ; Screenshot/Snapshot voient TOUT l'écran (une image envoyée à un modèle distant quitte la machine)"], probe: binary("Windows-MCP", "JAROD_WINDOWS_MCP", ["windows-mcp", "Scripts", "windows-mcp.exe"], "windows-mcp", ["--help"]) }),
  cap("G8", { id: "reladraw.diagram", name: "Diagrammes placés (reladraw)", description: "Écrire un diagramme en texte en disant où va chaque élément (à droite de, sous…) ; le moteur reladraw le met en page et l'exporte en SVG (outil diagram_export, source .reladraw).", categories: ["diagramme"], intents: ["dessiner un diagramme", "schéma d'architecture", "diagramme reladraw"], tools: ["diagram_export"], integration: "agent-tool", output: "SVG enregistré comme artefact, source .reladraw gardée", requires: ["moteur reladraw (JAROD_RELADRAW ou JAROD_ENGINES_DIR\\reladraw)"], verification: "le CLI de reladraw est présent", limits: ["rendu sans réseau ni processus enfant, lecture limitée au moteur et à la source", "icônes externes non lues (lecture limitée)", "PNG non disponible"], probe: async (host) => { const f = [host.env.JAROD_RELADRAW, host.env.JAROD_ENGINES_DIR && join(host.env.JAROD_ENGINES_DIR, "reladraw", "node_modules", "reladraw", "dist", "cli.js")].find((p): p is string => Boolean(p && host.exists(p))); return f ? { state: "available", detail: "moteur reladraw présent (diagram_export, sources .reladraw)", found: [f] } : notInstalled("reladraw", "moteur reladraw introuvable (engines/reladraw)"); } }),
  cap("G9", {
    id: "mcp-inspector.inspect",
    name: "Inspection de serveurs MCP (MCP Inspector)",
    description: "Interface web d'inspection d'un serveur MCP, à la demande, en bouclage avec jeton. Outil de développement.",
    categories: ["développement", "mcp"],
    intents: ["inspecter un serveur mcp", "déboguer un serveur mcp"],
    integration: "dev-tool",
    output: "URL de bouclage + jeton de session",
    requires: ["engines\\mcp-inspector (JAROD_MCP_INSPECTOR ou JAROD_ENGINES_DIR)"],
    verification: "le paquet 2.9.0 est présent",
    limits: ["jamais lancé au démarrage", "lecture de catalogue sans méthode d'appel", "arrête sa seule instance"],
    probe: async (host) => {
      const dir = engineFile(host, "JAROD_MCP_INSPECTOR", "mcp-inspector");
      const pkg = dir ? host.readText(join(dir, "node_modules", "@modelcontextprotocol", "inspector", "package.json")) : null;
      const version = pkg ? (JSON.parse(pkg) as { version?: string }).version : undefined;
      return dir && pkg ? { state: "available", detail: "moteur présent", ...(version ? { version } : {}), found: [dir] } : notInstalled("MCP Inspector");
    },
  }),
  cap("G10", { id: "smolvm.linux-vm", name: "Machine Linux isolée (smolvm)", description: "Lancer des commandes Linux dans une micro-VM que Jarod possède, isolée de Windows : réseau coupé par défaut, dossier de travail partagé en lecture (ou en écriture, sur permission), état conservé entre les commandes.", categories: ["isolation", "vm"], intents: ["exécuter dans une vm linux", "commande linux", "tester un script linux isolé"], tools: ["linux_prepare", "linux_run", "linux_reset"], integration: "agent-tool", output: "code de retour et sortie de la commande", risk: "act", sideEffects: "dans la VM ; dossier de travail seulement s'il est partagé en écriture", requires: ["Windows Hypervisor Platform", "Mode développeur de Windows (liens symboliques)", "smolvm", "%LOCALAPPDATA%\\smolvm en jonction hors d'AppData (AF_UNIX)"], verification: "smolvm --version répond", limits: ["réseau ouvert et écriture dans le dossier de travail : opérations réservées (jarod permissions add allow linux_run --operation run.network)", "image téléchargée par linux_prepare (outil Internet, refusé hors ligne)", "une commande à la fois ; ~5 s par commande (démarrage et arrêt de la VM)"], probe: binary("smolvm", "JAROD_SMOLVM", ["smolvm", "smolvm.exe"], "smolvm") }),
  cap("G11", { id: "ui-tars.visual-agent", name: "Agent visuel (UI-TARS)", description: "Perception visuelle d'écran. Différé.", categories: ["bureau", "vision"], intents: ["agent visuel"], integration: "detection-only", output: "état", requires: ["modèle de vision"], verification: "—", limits: ["différé : modèle volumineux, seconde boucle d'agent"], probe: pending("UI-TARS", "différé (modèle de vision requis)") }),
  cap("G12", { id: "coucou.mini-ui", name: "Mini-fenêtre (inspirée de Coucou)", description: "Un îlot en haut de l'écran : ce que fait Jarod et ce qui attend votre réponse, même fenêtre cachée ; un clic ramène Jarod. Menu de l'icône › Mini-fenêtre.", categories: ["interface"], intents: ["mini interface", "voir ce que fait jarod", "îlot en haut de l'écran"], integration: "infrastructure", output: "affichage seulement", requires: ["le shell Jarod-OS (Windows)"], verification: "préférence miniWindow du shell", limits: ["lecture seule : on répond aux accords dans la fenêtre principale (BL-01)", "nom, mascotte et sons de Coucou non repris"], probe: async () => ({ state: "available", detail: "fait partie du shell : menu de l'icône › Mini-fenêtre (éteinte par défaut)" }) }),
  cap("G13", { id: "osquery.diagnostics", name: "Diagnostics système (osquery)", description: "Diagnostics système : raccourcis prédéfinis (système, disques, mémoire, ports en écoute, services, démarrage, correctifs, programmes), diagnostics paramétrés (un service, un port, un programme), et requête osquery libre une fois accordée par l'utilisateur ; sans démon ni élévation.", categories: ["système", "diagnostic"], intents: ["diagnostic système", "quels ports sont en écoute", "espace disque libre", "quels programmes sont installés"], tools: ["system_diagnostics"], integration: "agent-tool", output: "lignes JSON horodatées avec provenance", requires: ["osqueryi (JAROD_OSQUERYI ou JAROD_ENGINES_DIR\\osquery\\osqueryi.exe)"], verification: "osqueryi --version répond", limits: ["requête libre (query=sql) : refusée sans règle de l'utilisateur — jarod permissions add allow system_diagnostics --operation sql", "droits de l'utilisateur : certaines tables restent partielles sans élévation", "aucun démon permanent"], probe: binary("osquery", "JAROD_OSQUERYI", ["osquery", "osqueryi.exe"], "osqueryi") }),
  cap("G14", { id: "ghidra-mcp.bridge", name: "Pont Ghidra par MCP (GhidraMCP)", description: "Session Ghidra interactive par MCP. Évalué ; le chemin principal reste ghidra_analyze.", categories: ["analyse", "binaire"], intents: ["ghidra mcp"], integration: "detection-only", output: "état", requires: ["Ghidra graphique + greffon GhidraMCP"], verification: "—", limits: ["évalué : LaurieWired retenu, bethington écarté (émulation, débogueur)"], probe: pending("GhidraMCP", "évalué ; ghidra_analyze (headless) couvre l'analyse statique") }),
  cap("G15", {
    id: "sandboxie.app-isolation",
    name: "Isolation d'applications Windows (Sandboxie)",
    description: "Lancer un programme Windows (application, installateur) dans le bac à sable de Jarod : ce qu'il écrit reste dans le bac, réseau coupé par défaut ; revoir puis vider ce qu'il a écrit.",
    categories: ["isolation"],
    intents: ["isoler une application windows", "essayer un installateur sans risque", "lancer un programme dans un bac à sable"],
    tools: ["sandbox_run", "sandbox_changes", "sandbox_discard"],
    integration: "agent-tool",
    output: "code de retour, sortie, fichiers écrits dans le bac",
    risk: "act",
    sideEffects: "écritures dans le bac seulement (copie à l'écriture)",
    requires: ["Sandboxie-Plus installé (pilote SbieDrv, service SbieSvc)"],
    verification: "Start.exe et SbieIni.exe présents",
    limits: ["réseau du bac coupé par défaut ; ouvert = opération réservée (jarod permissions add allow sandbox_run --operation run.network)", "un programme qui demande l'élévation n'en reçoit pas plus que Sandboxie ne l'autorise", "caractères \" % & | < > ^ refusés dans le programme et ses arguments"],
    probe: async (host) => {
      const exe = [host.env.ProgramFiles && join(host.env.ProgramFiles, "Sandboxie-Plus", "Start.exe"), host.env.ProgramFiles && join(host.env.ProgramFiles, "Sandboxie", "Start.exe")].find((p): p is string => Boolean(p && host.exists(p)));
      return exe ? { state: "available", detail: "Sandboxie présent ; outils sandbox_run, sandbox_changes, sandbox_discard", found: [exe] } : notInstalled("Sandboxie", "Sandboxie non installé (pilote : accord requis)");
    },
  }),
  cap("G16", {
    id: "opencodereview.review",
    name: "Revue de code (OpenCodeReview)",
    description: "Plan de revue locale (fichiers, règles) sans modèle ni réseau ; la relecture est faite par l'agent avec ses fournisseurs.",
    categories: ["développement", "revue"],
    intents: ["relire mon code", "revue de code", "relire un commit"],
    tools: ["code_review_plan"],
    integration: "agent-tool",
    output: "fichiers à relire et règles applicables",
    requires: ["ocr.exe (JAROD_OCR ou JAROD_ENGINES_DIR\\opencodereview\\ocr.exe)", "dépôt git dans le dossier de travail"],
    verification: "ocr version répond",
    limits: ["aucun correctif appliqué automatiquement", "revue complète par modèle : local par défaut, distant sur accord explicite"],
    probe: binary("OpenCodeReview", "JAROD_OCR", ["opencodereview", "ocr.exe"], null, ["version"]),
  }),
  cap("G17", { id: "cua.computer-use", name: "Bureaux virtuels d'évaluation (Cua)", description: "Environnements de bureau isolés pour évaluer des agents. Différé.", categories: ["bureau", "qa"], intents: ["bureau virtuel d'évaluation"], integration: "detection-only", output: "état", requires: ["Windows Sandbox ou VM"], verification: "—", limits: ["différé : banc commun G7/G11/G17"], probe: pending("Cua", "différé (banc commun à faire)") }),
];
