/**
 * Ce que les handlers de l'ui-bridge reçoivent : le kernel démarré (plugins publiés sur l'app cordis)
 * et le shell Electron réduit à ce qu'ils utilisent — pour être testés sur un VRAI kernel sans Electron.
 * Pattern : `Jarod-one/packages/desktop/src/main/handlers.ts:14-31` (`HandlerContext`, rév. 2e180305).
 */
import type { McpServerConfig } from "@jarod/contracts";
import type { AgentRuntime } from "@jarod/plugin-agent";
import type { EngineService, Hardware, LocalModelsService } from "@jarod/plugin-llm";
import type { GatewayHub } from "@jarod/plugin-gateways";
import type { PersonaService } from "@jarod/plugin-persona";
import type { Scheduler } from "@jarod/plugin-scheduler";
import type { UpdateService } from "@jarod/plugin-updates";
import type { VoiceService } from "@jarod/plugin-voice";
import type { AutomationService } from "@jarod/plugin-automation";
import type { PluginHost } from "@jarod/plugin-workflows";
import type { PermissionsService } from "@jarod/plugin-permissions";
import type { SshHostsPort } from "./ssh-hosts.js";
import type { RestoreKeys } from "../profile-restore.js";
import type { KanbanPort } from "./kanban.js";
import type { RegistryClient } from "../registry.js";

/** Un serveur MCP tel que l'écran le montre. */
export interface McpServerView {
  id: string;
  name: string;
  enabled: boolean;
  state: "stopped" | "starting" | "running" | "error";
  error?: string;
  tools: string[];
  pending: Array<{ tool: string; reason: "changed" | "new"; pinned?: string; current: string }>;
}

/** Ce que l'écran « Plateforme » montre : rien d'exécutable, aucun chemin, aucun contenu. */
export interface PlatformSnapshot {
  plugins: Array<{ name: string; version: string; status: string; failures: number; reason?: string }>;
  sandboxes: Array<{ id: string; profile: string; state: string; createdAt: number }>;
  quarantine: Array<{ id: string; label: string; size: number; status: string; verdict: string | null }>;
  hyperv: { cmdlets: boolean; admin: boolean; detail: string } | null;
}

/** Les services du kernel qu'atteignent les handlers (`app.agent`, `app.scheduler`…). */
/** Une capacité du registre vivant (cockpit, lot 1), telle que plugin-integrations la rend : données sérialisables, sans secret. */
export interface CapabilityRow {
  id: string;
  name: string;
  description: string;
  owner: string;
  integration: "agent-tool" | "skill" | "detection-only" | "external-app";
  state: "unknown" | "not-installed" | "installed-unconfigured" | "available" | "degraded" | "blocked-permission" | "error";
  detail: string;
  version?: string;
  found?: string[];
  missing?: string[];
  risk: string;
  locality: "local" | "remote" | "mixed";
  requires: string[];
  limits: string[];
  tools: string[];
  permissions: Record<string, "allow" | "ask" | "deny">;
  experimental?: boolean;
  checkedAt: number | null;
  provenance?: { repo: string; license: string; pinned: string | null; status: string };
}

export interface DesktopKernel {
  agent: AgentRuntime;
  scheduler: Scheduler;
  gateways: GatewayHub;
  /** plugin-persona désactivable : absent = SOUL.md non géré. */
  persona?: PersonaService;
  /** plugin-voice (dictée, capture continue) ; absent = désactivé. */
  voice?: VoiceService;
  /**
   * plugin-mcp, vu par un port STRUCTUREL (le desktop ne dépend pas du paquet) : démarrer/arrêter les serveurs
   * des réglages, sonder un serveur (connexion temporaire). Absent = plugin désactivé.
   */
  mcp?: {
    sync(configs: McpServerConfig[]): Promise<void>;
    probe(config: McpServerConfig): Promise<Array<{ name: string; description?: string }>>;
    /** État des serveurs, dont les outils retenus parce que leur description a changé (épinglage SHA-256). */
    list?(): McpServerView[];
    /** Accepte la description actuelle d'un outil retenu. */
    approve?(serverId: string, tool: string): void;
  };
  /** Plateforme de plugins, quarantaine, bacs à sable, Hyper-V : un instantané en lecture seule. Absent = rien n'est offert. */
  platform?: { snapshot(): Promise<PlatformSnapshot> };
  /** Garde `skill-guard` de plugin-skills (`ctx.skillsHub.scan`, port structurel) ; absent = installations de skills refusées. */
  skillsHub?: {
    scan(bundle: { files: { path: string; data: Buffer }[] }): { verdict: string; findings: unknown[] };
  };
  /**
   * `PortabilityService` de plugin-memory (port STRUCTUREL) : import par fusion (Q13-3) ; absent = import refusé.
   */
  portability?: {
    inspect(dir: string): {
      manifest: { profile: string };
      memory: { added: number; alreadyThere: number };
      settings: string[];
      ignored: string[];
      approval: { key: string; lines: string[] }[];
    };
    apply(dir: string, opts?: { approve?: readonly string[] }): { memory: { added: number; alreadyThere: number }; settings: number; personas: number; ignored: string[]; approved: string[] };
  };
  /**
   * plugin-storage (port STRUCTUREL) : clés de ce compte et contrôle d'un fichier de base, pour la restauration
   * d'une sauvegarde complète dans un profil neuf (Q14) ; absent = restauration refusée. Jamais vers le renderer.
   * `dbEncryption` : comment la base a été ouverte (magasin qui a rendu la clé), pour l'état de protection du coffre.
   */
  storage?: RestoreKeys & { readonly dbEncryption?: { encrypted: boolean; keyStoreId?: string | null; weak: boolean } };
  /**
   * plugin-kanban (Q17, port STRUCTUREL) : tableaux et tâches de `jarod.db` (v17) ; absent = canaux Kanban en échec
   * (« plugin-kanban désactivé »).
   */
  kanban?: KanbanPort;
  /** plugin-rag (port STRUCTUREL) : état de l'index et « Reindex » du volet Documents (SPECS-P5-UI-PARITE.md § 20) ; absent = canaux en échec. */
  rag?: {
    status(): { enabled: boolean; chunks: number; docs: number; endpoint: string | null };
    reindexPlan(): { documents: number; chunks: number; missing: number };
    reindex(o: {
      signal?: AbortSignal;
      onProgress?: (p: { done: number; total: number; docId: string | null }) => void;
    }): Promise<{ documents: number; chunks: number; missing: number; cancelled?: true }>;
  };
  /** Registre vivant des capacités (plugin-integrations, port STRUCTUREL) ; absent = écran vide. */
  capabilities?: { list(): Promise<CapabilityRow[]>; check(id: string): Promise<CapabilityRow> };
  /** Hôtes SSH déclarés (plugin-tools, port STRUCTUREL) ; absent = désactivé. */
  sshHosts?: SshHostsPort;
  /** Plugins utilisateur (plugin-workflows) : activation et confiance ; absent = désactivé. */
  pluginHost?: PluginHost;
  /** Automation : CRUD règles + exécution ; absent = désactivé. */
  automation?: AutomationService;
  /** Permissions : garde unifié + hot reload depuis storage ; absent = désactivé. */
  permissions?: PermissionsService;
  /** Moteur llama.cpp de plugin-llm (installation, préréglages, démarrage) et la détection du matériel ; absent = désactivé. */
  localEngine?: {
    engine: EngineService;
    hardware(): Promise<Hardware>;
    /** Modèles locaux en mémoire (llama.cpp, LM Studio) : charger, décharger, hotswap. */
    models?: LocalModelsService;
  };
  /** plugin-updates (canal distant + dossier local) ; absent = désactivé. */
  updates?: UpdateService;
  /** Nom du profil servi (un kernel = un profil). */
  profile: string;
  /**
   * Racine des données partagée avec le CLI (`<racine>/profiles/<nom>`, `profile.json`) : liste des profils
   * et préférences de l'application (`desktop.json`, équivalent du `desktop.json` de HERMES_HOME).
   */
  dataRoot: string;
}

/** Le shell Electron, vu des handlers. */
export interface DesktopShell {
  appVersion(): string;
  quit(): void;
  relaunch(): void;
  writeClipboard(text: string): void;
  openExternal(url: string): Promise<void>;
  /** Pousse un événement vers la fenêtre (canal d'événement autorisé seulement : `emitOneai`). */
  send(channel: string, ...args: unknown[]): void;
  /** Dossier temporaire de l'app (`app.getPath("temp")`) : les installeurs y sont copiés avant lancement. */
  tempDir(): string;
  /** Installée par l'installeur NSIS (elle peut se mettre à jour en silence) — source `handlers.ts:26-29`. */
  isInstalled(): boolean;
  /** `/S --updated --force-run`, puis quitte (source `index.ts:405-413`). */
  installSilently(installer: string): void;
  /** Ouvre un fichier avec l'application associée (`shell.openPath`). */
  openPath(path: string): Promise<string>;
  /** `nativeTheme.themeSource` (apparence native de la fenêtre, suivie par le thème des écrans). */
  setThemeSource(source: "dark" | "light" | "system"): void;
  /** Correcteur orthographique de la session de la fenêtre + langues préférées du système. */
  spellChecker(): { available: string[]; selected: string[]; preferredSystem: string[] };
  /** `session.setSpellCheckerLanguages` sur la session de la fenêtre (liste déjà filtrée par le handler). */
  setSpellCheckerLanguages(languages: string[]): void;
  /** Dossier des journaux de l'application (`<userData>/logs`). */
  logsDir(): string;
  /**
   * Préférence d'accélération matérielle lue AU DÉMARRAGE (`desktop.json`, `gpu.ts`) : celle que ce processus
   * applique ; absente = « auto ». Une préférence changée depuis ne vaut qu'au prochain lancement.
   */
  gpuBootPreference?(): "auto" | "on" | "off";
  /**
   * Q11 (b) : confirmation EXPLICITE d'une installation depuis le registre, dans une boîte de dialogue NATIVE du
   * main (nom, source épinglée, licence, SHA-256, permissions) — jamais dans le renderer. Absente = refus.
   */
  confirmInstall?(summary: {
    kind: string;
    id: string;
    name: string;
    source: string;
    revision: string;
    license: string;
    sha256: string;
    permissions: string[];
    files: number;
    target: string;
  }): Promise<boolean>;
  /**
   * Q12 — boîtes et gestes NATIFS du main (jamais un chemin libre du renderer) ; absents = refus. Dossier
   * `userData` d'Electron (journaux, profil Chromium) : protégé par la garde fichiers comme les données de Jarod.
   */
  userDataDir?(): string;
  /** Boîte « Choisir un dossier » ; null = annulée. */
  pickFolder?(): Promise<string | null>;
  /** Boîte « Ouvrir » d'un fichier ; null = annulée. */
  pickFile?(options: { title: string; filters: { name: string; extensions: string[] }[] }): Promise<string | null>;
  /** Boîte « Enregistrer sous » (nom proposé déjà assaini) ; null = annulée. */
  pickSavePath?(defaultName: string): Promise<string | null>;
  /** Boîte « Choisir un dossier de destination » (sauvegarde Q13, modèles Hugging Face) ; `defaultPath` : dossier présélectionné ; null = annulée. */
  pickDestinationFolder?(title: string, defaultPath?: string): Promise<string | null>;
  /** « Afficher dans l'explorateur » (`shell.showItemInFolder`). */
  showItemInFolder?(path: string): void;
  /** Terminal ouvert dans un dossier, SANS commande. */
  openTerminal?(dir: string): Promise<boolean>;
  /** Menu contextuel natif. */
  popupMenu?(items: { label: string; enabled: boolean; click: () => void }[]): void;
  /** Message natif d'information (refus d'un dossier choisi, résultat d'une sauvegarde…). */
  notify?(message: string, detail?: string): void;
  /** Confirmation native (« Annuler » par défaut) : import d'un paquet (Q13-3), restauration (Q14, `action`). */
  confirm?(message: string, detail: string, action?: string): Promise<boolean>;
  /**
   * Entrée de démarrage de la session Windows (SPECS-P5-TRAY.md § 2.4) : `packaged` faux = JAMAIS écrite (un exécutable de développement ne s'inscrit pas au démarrage) ;
   * absent = indisponible. Un port, doublé par tous les tests : ni les tests ni l'agent n'écrivent l'entrée de démarrage de la machine.
   */
  loginItems?: { packaged: boolean; get(): boolean; set(on: boolean): void };
}

/**
 * Hugging Face (SPECS-P5-MODELS.md § 3.10) : câblage fourni par le CODE du processus main — JAMAIS par un réglage, un canal IPC, un champ d'entrée ni (hors mode test
 * triple garde, `hf-base.ts`) une variable d'environnement. Absent = la production : `https://huggingface.co`, `fetch` global, `statfs`, horloge système.
 */
export interface HfWiring {
  /** Base de l'API : le serveur factice de l'e2e (`resolveTestHfBase`) ou des tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Origines de CDN supplémentaires admises (tests : un second serveur factice). */
  extraTrustedOrigins?: readonly string[];
  /** Octets libres sur un dossier existant (tests : valeur imposée). */
  freeBytes?: (dir: string) => number | Promise<number>;
  /** Dossier présélectionné par la boîte « Choisir un dossier » (s'il existe). */
  defaultModelsDir?: string;
  /** Cadence minimale des événements de progression (défaut 250 ms) et horloge (tests). */
  progressIntervalMs?: number;
  now?: () => number;
  /** Budget cumulé de corps lus par action « Check all » (défaut 64 Mio) et plafond d'UNE lecture (défaut 16 Mio) : réglables par le code, pour les tests. */
  fitBudgetBytes?: number;
  fitReadCapBytes?: number;
}

export interface HandlerContext {
  kernel(): DesktopKernel;
  shell: DesktopShell;
  /**
   * Changer de profil = fermer le kernel servi et en ouvrir un sur l'autre profil (un kernel = un profil ; source
   * `Jarod-one/packages/desktop/src/main/index.ts:256-270`, `switchProfile` : retour au profil précédent si
   * l'ouverture échoue, erreur relancée). Fourni par le main ; absent = changement impossible (refusé).
   */
  switchProfile?(name: string): Promise<void>;
  /** Registre Discover lu par le main (Q11) ; absent/null = non consulté (mode test sans registre local). */
  registry?: RegistryClient | null;
  /** Hugging Face : câblage du CODE (voir `HfWiring`) ; absent = production. */
  huggingface?: HfWiring;
  /** Navigateur de l'agent (SPECS-P5-UI-PARITE.md §6) : efface sa session ; absent = rien à effacer (mode sans fenêtre). */
  agentBrowser?: { forget(): Promise<void> };
  /** Terminal intégré : pty et liste de shells INJECTABLES (tests) ; absents = le vrai `node-pty` et les shells détectés. */
  terminals?: {
    spawn?(shell: string, args: string[], o: import("../terminal.js").SpawnOptions): import("../terminal.js").PtyLike;
    shells?(): import("../terminal.js").ShellInfo[];
  };
}

/**
 * La surface hermesAPI passe un `profile` optionnel à beaucoup d'appels (Hermes sert plusieurs
 * profils à la fois). Un kernel sert UN profil : un autre nom est refusé, jamais servi par erreur.
 */
export function assertProfile(ctx: HandlerContext, profile: unknown): void {
  if (profile === undefined || profile === null || profile === "") return;
  const active = ctx.kernel().profile;
  if (profile !== active) throw new Error(`[oneai] profil « ${String(profile)} » non servi (profil actif : ${active})`);
}

/** Horodatage Hermes (`state.db` : secondes Unix) depuis une date Jarod (millisecondes). */
export const toHermesTime = (ms: number | null | undefined): number | null => (ms == null ? null : ms / 1000);
