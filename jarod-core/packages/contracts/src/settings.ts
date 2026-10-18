/**
 * Réglages : le DTO partagé par tous les frontends (desktop, CLI, relay). Portage de
 * packages/core/src/services/settings.ts (rév. 2e180305). Les types de configuration que
 * settings.ts importait de ~12 services sont extraits ici À L'IDENTIQUE (source : fichier:lignes) ;
 * chaque plugin propriétaire les ré-exporte depuis ce module.
 */
import { type AutoImprovementConfig, DEFAULT_AUTO_IMPROVEMENT } from "./auto-improvement-config.js";
import { DEFAULT_ECOSYSTEM_FLAGS, type EcosystemFlags } from "./ecosystem.js";

// remote/host.ts:25-31
export interface RemoteDevice {
  id: string;
  name: string;
  publicKey: string;
  pairedAt: number;
  lastSeen: number;
}

// remote/host.ts:33-40
export interface RemoteConfig {
  enabled: boolean;
  /** Public URL of the self-hosted relay (https://…). */
  relayUrl: string;
  /** Random id this computer uses on the relay (not a secret). */
  hostId: string;
  devices: RemoteDevice[];
}

// services/email.ts:19-34
export interface EmailConfig {
  enabled: boolean;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** Login for both servers. The password is a secret (EMAIL_PASSWORD_KEY), never a setting. */
  user: string;
  /** Sender address of the answers (defaults to `user`). */
  from: string;
  allowedSenders: string[];
  /** Only messages authenticated by the receiving server (DKIM/DMARC pass). On by default. */
  requireAuth: boolean;
  /**
   * Trusted `authserv-id`s (e.g. `["mx.google.com"]`): only the FIRST `Authentication-Results` header is read,
   * and its `authserv-id` must be one of these. Empty = no pinning (the first header is trusted whoever wrote
   * it) — set it to reject a message that carries only a sender-forged header.
   */
  trustedAuthservIds: string[];
  pollSeconds: number;
  folder: string;
}

// services/engine.ts:21-21
export type EngineBackend = "cuda" | "vulkan" | "hip" | "sycl" | "metal" | "cpu";

// services/engine.ts:47-53
export interface InstalledEngine {
  tag: string;
  backend: EngineBackend;
  dir: string;
  bin: string;
  at: number;
}

// services/engine.ts:25-45
export interface EnginePreset {
  id: string;
  name: string;
  /** Path of the GGUF model. */
  model: string;
  /** Smaller GGUF of the same family for speculative decoding (empty: none). */
  draftModel: string;
  ctxSize: number;
  /** Layers offloaded to the GPU; -1 = all of them. */
  gpuLayers: number;
  flashAttn: "auto" | "on" | "off";
  /** KV cache quantization: q8_0 halves its memory for a negligible loss. */
  cacheType: "f16" | "q8_0" | "q4_0";
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  reasoning: ReasoningMode;
  /** Parallel sequences (`--parallel`); absent = llama-server's own default. Counted by the memory estimate (`gguf-fit`). */
  parallelSlots?: number;
  /** Extra llama-server arguments, one per item (never through a shell). The desktop screen never writes these: it only keeps or clears what is stored. */
  extraArgs: string[];
}

// services/engine.ts:55-64
export interface LocalEngineConfig {
  port: number;
  /** Chosen backend; empty = the one detected for this machine. */
  backend: EngineBackend | "";
  installed: InstalledEngine | null;
  presets: EnginePreset[];
  activePreset: string;
  /** Load the active preset when Jarod starts. */
  autoStart: boolean;
  /**
   * Where models downloaded from Hugging Face go (SPECS-P5-MODELS.md § 4): chosen ONCE in the native folder dialog, never typed, never under the profile's data folder
   * (checked again at every download). Absent = not chosen yet. Only a path: no model file is ever part of the settings or of a profile backup.
   */
  modelsDir?: string;
}

/**
 * Modèles locaux chargés en mémoire (llama.cpp piloté par Jarod, LM Studio) : `hotswap` = un seul modèle de chat local à la fois. Allumé, choisir
 * un modèle local dans le chat le CHARGE (avant le tour) et décharge les autres modèles de chat locaux ; les modèles d'embeddings ne sont
 * jamais déchargés. Éteint (défaut), rien ne se charge ni ne se décharge sans un geste dans le volet.
 */
export interface LocalModelsConfig {
  hotswap: boolean;
  /**
   * Longueur de contexte (tokens) demandée à LM Studio au chargement, par clé de modèle (`jean-1.0-27b@iq4_xs` → 32768). Absente : celle que
   * LM Studio choisit (souvent 4 096 ou 8 192, trop peu pour la liste d'outils de l'agent). Les préréglages llama.cpp ont la leur (`ctxSize`).
   */
  lmstudioContext?: Record<string, number>;
}

// services/learning.ts:32-36
export interface LearningConfig {
  enabled: boolean;
  /** A review after this many new user messages in a conversation. */
  reviewEvery: number;
}

// services/lsp.ts:26-32
export interface LspConfig {
  enabled: boolean;
  /** Append compiler errors to the result of write_file / edit_file. */
  diagnoseAfterEdit: boolean;
  /** User-defined servers; they take precedence over the built-in ones for their extensions. */
  custom: LspServerConfig[];
}

// services/openai-api.ts:20-25
export interface ApiServerConfig {
  enabled: boolean;
  port: number;
  /** 127.0.0.1 (this machine only) or 0.0.0.0 (the local network too). */
  host: "127.0.0.1" | "0.0.0.0";
}

// services/docker-sandbox.ts:19-27
export interface DockerOptions {
  image: string;
  /** Network access from the container (package installs need it). */
  network: boolean;
  /** Memory limit (`4g`, `512m`); empty = none. */
  memory: string;
  /** CPU limit; 0 = none. */
  cpus: number;
}

// services/docker-sandbox.ts:29-29
export const DEFAULT_DOCKER: DockerOptions = { image: "node:22-bookworm", network: true, memory: "4g", cpus: 2 };

// services/shell-guard.ts:41-42
/** Ce que l'utilisateur demande au garde. */
export type WriteScope = "off" | "workspace";

// services/shell-guard.ts:44-66
export interface ShellPolicy {
  /**
   * `off` : la commande est lancée telle quelle (comportement historique, aucune promesse de
   * confinement). `workspace` : le confinement des écritures est EXIGÉ — s'il n'est pas tenable sur
   * cette machine, la commande est refusée. Jamais exécutée sans protection.
   */
  writeScope: WriteScope;
  /** Dossiers supplémentaires où l'écriture reste permise (relatifs au dossier de travail). */
  writableRoots: string[];
  /**
   * Dossiers que la commande confinée peut LIRE et EXÉCUTER sans y écrire (ceux des outils : node, git…), chemins absolus. Ajoutés au PATH de la commande
   * sous `jarod-sandbox` (Windows) ; ailleurs la racine est déjà lisible. Refusés en bloc s'ils désignent une racine de lecteur, le dossier personnel (ou un
   * de ses ancêtres) ou un dossier de clés. Optionnel : absent = aucun.
   */
  readRoots?: string[];
  /** Programmes autorisés (nom ou chemin absolu). Vide = tous ceux que la machine a. */
  allowedPrograms: string[];
  /** Programmes toujours refusés. */
  deniedPrograms: string[];
  /** Programmes qui exigent l'accord de l'utilisateur, nommé, par la porte d'approbation du cœur. */
  askPrograms: string[];
  /**
   * Où les commandes tournent : `local` (la machine, comme avant) ou `docker` (un conteneur par
   * dossier de travail, qui ne partage que ce dossier — le confinement des écritures y est tenu
   * sur toutes les plateformes, Windows compris).
   */
  environment?: "local" | "docker";
  docker?: DockerOptions;
}

// services/shell-guard.ts:68-77
/** Le défaut : rien de demandé, rien de restreint — le comportement d'avant, à la lettre. */
export const DEFAULT_SHELL_POLICY: ShellPolicy = {
  writeScope: "off",
  writableRoots: [],
  readRoots: [],
  allowedPrograms: [],
  deniedPrograms: [],
  askPrograms: [],
  environment: "local",
  docker: DEFAULT_DOCKER,
};

/**
 * E2 — le navigateur CONNECTÉ (réglage de l'utilisateur). ÉTEINT et sans aucun domaine par défaut : rien n'est branché tant que l'utilisateur n'a pas
 * choisi, lui-même, des domaines. Même avec un domaine, chaque opération demande son accord et le navigateur n'est qu'un Chrome jetable à profil neuf :
 * il n'ouvre jamais le profil quotidien. `allowDomains` vaut pour TOUTE destination réseau du navigateur (pages, sous-ressources, redirections), pas
 * seulement pour les navigations.
 */
export interface ConnectedBrowserSettings {
  enabled: boolean;
  /** Domaines complets (« exemple.org », sous-domaines compris). Vide = rien n'est permis. */
  allowDomains: string[];
  /** Domaines refusés en plus de la liste noire intégrée ; la liste noire l'emporte toujours. */
  denyDomains: string[];
}

export const DEFAULT_CONNECTED_BROWSER: ConnectedBrowserSettings = { enabled: false, allowDomains: [], denyDomains: [] };

/** Pourquoi `d` n'est pas un domaine acceptable pour le réglage, ou null. Un domaine complet : ni joker, ni étiquette seule (« com »), ni adresse IP, ni port. */
export function connectedBrowserDomainProblem(d: string): string | null {
  if (d.length > 253) return "trop long";
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(d)) return "un domaine complet en minuscules, comme exemple.org (ni joker, ni port, ni chemin)";
  if (/^\d+$/.test(d.slice(d.lastIndexOf(".") + 1))) return "une adresse IP n'est pas un domaine";
  return null;
}

// services/ssh-hosts.ts:43-57
/** Un hôte déclaré, tel qu'il est rangé. Six champs, et rien d'autre — pas de secret, pas d'option. */
export interface SshHostRecord {
  /** Identifiant interne, stable, jamais affiché comme nom. */
  id: string;
  /** Le nom que l'utilisateur donne à cet hôte : c'est lui qui s'affiche dans la liste. */
  name: string;
  /** Nom d'hôte ou adresse IP. */
  host: string;
  /** Utilisateur distant. Obligatoire ici : un hôte déclaré le déclare. */
  username: string;
  /** Port TCP. Défaut : 22. */
  port: number;
  /** CHEMIN d'une clé privée. Le seul « secret » admis, et ce n'en est pas un : c'est un chemin. */
  keyPath: string;
}

// services/vault.ts:16-27
export interface VaultEntry {
  /** What the agent calls it: letters, digits, underscores. */
  name: string;
  description: string;
  /** Environment variable it becomes in a shell command (defaults to the name in upper case). */
  envVar: string;
  /** Hosts an HTTP request may send it to (`api.github.com`, `*.example.com`). Empty: none. */
  domains: string[];
  /** May be given to shell commands as an environment variable. */
  allowShell: boolean;
  createdAt: number;
  /** What it is, for the person (Jarod-OS, Sécurité › Secrets). Absent: `other`. */
  kind?: VaultKind;
  /** Held in memory only, for this run of the core: never written to disk, gone at the next start. */
  temporary?: boolean;
}

export type VaultKind = "api_key" | "token" | "password" | "other";

// services/vision.ts:17-23
export interface ImageDescriptionConfig {
  /** auto: only for models that cannot see; always: for every model; off: images sent as they are. */
  mode: "auto" | "always" | "off";
  /** The model that describes. Empty = nothing is described (no provider is chosen for the user). */
  provider: string;
  model: string;
}

// services/webhooks.ts:10-11
/** Le port par défaut : local uniquement, jamais exposé. */
export const DEFAULT_HOOK_PORT = 8790;

// services/whatsapp.ts:22-30
export interface WhatsAppConfig {
  enabled: boolean;
  /** "Phone number ID" of the WhatsApp Business number (Meta console → WhatsApp → API setup). */
  phoneNumberId: string;
  /** Local port of the webhook (127.0.0.1 only). */
  port: number;
  /** Numbers allowed to talk to Jarod, digits only in international format (33612345678). */
  allowedNumbers: string[];
}

// services/engine.ts:22-23
/** Ajean's reasoning modes: auto (the model decides), on, off, deepseek (thinking kept apart). */
export type ReasoningMode = "auto" | "on" | "off" | "deepseek";

// services/lsp.ts:16-24
export interface LspServerConfig {
  id: string;
  name: string;
  /** Executable (name on PATH or absolute path). */
  command: string;
  args: string[];
  /** File extensions handled, with the dot (".ts"). */
  extensions: string[];
}

// services/settings.ts:20-339
export type Effort = "" | "low" | "medium" | "high" | "xhigh" | "max";

/** Les outils d'UN plugin (noms enregistrés) que l'utilisateur a classés « sans accord », pour l'empreinte `digest` de son contenu. */
export interface PluginTrustEntry {
  digest: string;
  tools: string[];
  at: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  /** Remote server (Streamable HTTP): when set, `command`/`args` are ignored. */
  url?: string;
  /** HTTP headers sent to a remote server, e.g. { Authorization: "Bearer …" }. */
  headers?: Record<string, string>;
}

export interface ProviderOverride {
  baseUrl?: string;
  /** User-curated model list (refreshed from the provider's /models endpoint). */
  models?: string[];
}

export interface TelegramConfig {
  enabled: boolean;
  /** Only these chat ids may talk to the agent. */
  allowedChatIds: string[];
}

export interface DiscordConfig {
  enabled: boolean;
  /** Discord user ids allowed to talk to the agent. */
  allowedUserIds: string[];
}

export interface SlackConfig {
  enabled: boolean;
  /** Slack member ids (U…) allowed to talk to the agent. */
  allowedUserIds: string[];
}

export interface VoiceConfig {
  /** Provider used for speech-to-text (OpenAI-compatible /audio/transcriptions). */
  sttProvider: string;
  sttModel: string;
  /** Read answers aloud automatically after voice input. */
  autoSpeak: boolean;
  /** speechSynthesis voice name ("" = system default for the language). */
  ttsVoice: string;
  ttsRate: number;
}

/** A phone paired on the local network. The token is kept as a hash: it is never written down. */
export interface MobileDevice {
  deviceId: string;
  name: string;
  tokenHash: string;
  pairedAt: number;
  lastSeen: number;
}

export interface MobileConfig {
  enabled: boolean;
  port: number;
  devices: MobileDevice[];
}

/** The adb this computer uses for Android devices: "" means the one on PATH. */
export interface AndroidConfig {
  adbPath: string;
  timeoutMs: number;
}

/**
 * Les déclencheurs entrants SIGNÉS (`services/webhooks.ts`) : ce qui permet à un morceau d'API, à un
 * cron système ou à un autre outil de réveiller l'agent depuis l'extérieur.
 *
 * Le SECRET d'un déclencheur ne vit PAS ici : il est rangé dans la table `secrets`. Ce réglage ne
 * porte que l'interrupteur et le port — c'est-à-dire ce qu'un export de profil peut montrer sans
 * livrer de quoi signer.
 */
export interface WebhooksConfig {
  /** Faux par défaut : rien n'écoute tant que l'utilisateur ne l'a pas demandé. */
  enabled: boolean;
  /** Le port d'écoute. Le serveur ne se lie qu'à 127.0.0.1, jamais au réseau. */
  port: number;
}

/** Entretien des skills écrites par l'agent : voir `services/curator.ts`. */
export interface CuratorConfig {
  enabled: boolean;
  /** Temps minimal entre deux passes. */
  intervalHours: number;
  /** Une passe n'a lieu qu'après ce temps sans activité (aucune conversation touchée). */
  minIdleHours: number;
  /** Sans usage depuis ce délai : la skill est marquée « périmée » (elle reste disponible). */
  staleAfterDays: number;
  /** Sans usage depuis ce délai : la skill part dans `.archive/` (récupérable). */
  archiveAfterDays: number;
  /** État : dernière passe (ms). 0 = jamais observé. */
  lastRunAt: number;
}

/** Un plafond : chaque dimension à 0 est désactivée. */
export interface BudgetLimits {
  /** Tokens d'entrée + de sortie des réponses de la conversation (`sessionUsage`). */
  maxTokens: number;
  /** Coût estimé (USD) ; ne joue que si le modèle est au barème (sinon « coût inconnu »). */
  maxCostUsd: number;
}

/**
 * Jarod-cordis (G4, décision 2026-09-28) : alerte à 80 % (statut, une fois), arrêt du tour à 100 %
 * (contrôle avant chaque appel du modèle) ; on poursuit en relevant le plafond (`/budget`).
 */
export interface SessionBudgetConfig extends BudgetLimits {
  /** Plafond relevé par `/budget` pour UNE conversation (clé = id) ; remplace le plafond global. */
  perSession: Record<string, BudgetLimits>;
}

export interface Settings {
  language: "fr" | "en";
  theme: "system" | "light" | "dark";
  activeProvider: string;
  activeModel: string;
  /**
   * La chaîne de repli, dans l'ordre déclaré. Vide par défaut, et c'est délibéré : basculer envoie
   * les données ailleurs, donc rien ne bascule vers un endroit que l'utilisateur n'a pas nommé.
   */
  fallbacks: { provider: string; model?: string }[];
  providerOverrides: Record<string, ProviderOverride>;
  persona: string;
  thinking: boolean;
  effort: Effort;
  /** Claude only: let the API re-run a refused request on a fallback model. */
  anthropicFallbacks: boolean;
  autoApproveTools: boolean;
  /**
   * « Toujours autoriser » : les outils (noms enregistrés) que l'utilisateur a dispensés d'accord, un par un, depuis la fenêtre
   * d'accord (SPECS-P5-UI-PARITE.md §4). Vaut pour TOUS les appels de cet outil, quels que soient ses arguments. Ne lève PAS une règle
   * « demander » du garde de permissions, ni le mode Plan, ni le garde du shell. Jamais importable depuis un paquet de profil
   * (liste blanche du portage) ; un outil s'y ajoute par la fenêtre d'accord (confirmation native) et s'en retire par les réglages.
   */
  alwaysAllowTools: string[];
  disabledTools: string[];
  memoryInject: boolean;
  workspace: string | null;
  /** Shell used by the integrated terminal; empty picks the platform default. */
  terminalShell: string;
  maxAgentSteps: number;
  mcpServers: McpServerConfig[];
  disabledSkills: string[];
  skillVersions: Record<string, string>;
  disabledPlugins: string[];
  /**
   * Règles du garde de permissions unifié (fail-closed, first-match-wins), persistées par l'utilisateur.
   * Format : `{ tool: string, decision: "allow" | "ask" | "deny" }[]` ; `tool` = nom d'outil, segment
   * (`fs` → `fs_*`) ou `*`. Vide = aucune règle utilisateur : la chaîne retombe alors sur « outil déclaré
   * au registre → allow », puis `* → deny`. L'ordre compte : la première règle qui couvre l'outil gagne.
   * Relues à chaud par `plugin-permissions` (aucun redémarrage) ; tout affaiblissement passe par la
   * confirmation native de `set-jarod-settings`.
   */
  permissionsRules: { tool: string; decision: "allow" | "ask" | "deny" }[];
  /**
   * Q19-4 — la confiance de l'UTILISATEUR envers les outils d'un plugin, seule source de « sans accord » : un outil de
   * plugin exige l'accord à chaque appel tant que l'utilisateur ne l'a pas classé ici (`/plugin trust`), et ce classement
   * est lié à l'EMPREINTE du contenu du plugin (toute modification le retire). Ce que le plugin déclare (`dangerous`) n'est
   * qu'une indication. Jamais importable depuis un paquet de profil.
   */
  pluginTrust: Record<string, PluginTrustEntry>;
  /** `plan`: read-only agent that investigates and proposes; `build`: full tool access. */
  agentMode: "build" | "plan";
  /** Ask the model for a short title after the first exchange. */
  autoTitle: boolean;
  /** History size (characters) above which older turns are summarized automatically; 0 = never. */
  compactThreshold: number;
  /**
   * Fenêtre du modèle actif, en jetons (0 = inconnue). Elle sert à refuser AVANT l'envoi : au-delà,
   * les messages les plus anciens sont écartés et l'utilisateur est prévenu, au lieu de découvrir le
   * dépassement par l'erreur du fournisseur. L'interface la renseigne quand elle la connaît
   * (`get-model-context-window`) ; un modèle local a la longueur de contexte qu'on lui a chargée.
   */
  contextWindow: number;
  /** Jarod-cordis (G4) : plafond de tokens/coût par conversation ; voir `SessionBudgetConfig`. */
  sessionBudget: SessionBudgetConfig;
  telegram: TelegramConfig;
  /** Passerelle e-mail (IMAP + SMTP) ; le mot de passe est un secret, jamais un réglage. */
  email: EmailConfig;
  /** Passerelle WhatsApp (API Cloud officielle de Meta) ; jeton et secret d'application sont des secrets. */
  whatsapp: WhatsAppConfig;
  /** Images described by a model that sees, for the models that do not. */
  imageDescription: ImageDescriptionConfig;
  /** The llama.cpp engine managed by Jarod: install, presets, port. */
  localEngine: LocalEngineConfig;
  /** Chargement / déchargement des modèles locaux et hotswap (un seul modèle de chat local en mémoire). */
  localModels: LocalModelsConfig;
  /** The credential vault's entries (names, uses, domains); the values are secrets. */
  vault: VaultEntry[];
  /** Jarod behind an OpenAI-compatible API (the key is a secret). */
  apiServer: ApiServerConfig;
  discord: DiscordConfig;
  slack: SlackConfig;
  /**
   * Language servers (diagnostics and code navigation for the agent).
   *
   * STATUT : NON PORTÉ — dette de portage, pas une exclusion. Rien ne lit ce réglage : `services/lsp.ts` (V2) n'a jamais été porté (seul `findOnPath` l'a été,
   * `@jarod/kernel/find-on-path`) ; le PLAN le rangeait dans plugin-skills, BESOINS Q1 l'a placé dans plugin-tools, aucun des deux ne l'a reçu. Voir PLAN / P1.
   */
  lsp: LspConfig;
  /** Remote access through a self-hosted relay. */
  remote: RemoteConfig;
  voice: VoiceConfig;
  mobile: MobileConfig;
  android: AndroidConfig;
  /**
   * Les déclencheurs entrants signés. Optionnel, mais **présent dans `DEFAULT_SETTINGS`** — et c'est
   * ce qui fait la différence : `SettingsService.patch` n'écrit que les clés qu'il connaît, donc une
   * clé absente des défauts est jetée EN SILENCE et l'interrupteur ne s'allume jamais depuis l'écran.
   * Sa valeur par défaut est « éteint » : une installation qui ne dit rien ne change rien (aucun
   * serveur ne s'ouvre, aucune migration, aucun octet rangé).
   *
   * STATUT : NON PORTÉ (démarrage) — dette de portage, pas une exclusion. `WebhookService` (plugin-scheduler) est porté et testé, mais RIEN ne le démarre dans le
   * kernel ni dans `jarod serve` (reporté P1, voir PLAN / P1) : ce réglage n'ouvre aucun port. `jarod serve` l'annonce « non démarrés », jamais « actif ».
   */
  webhooks?: WebhooksConfig;
  /** Show the agent's browser window while it navigates. */
  browserVisible: boolean;
  /**
   * Navigateur de l'agent : session GARDÉE sur disque (cookies, connexions faites par l'utilisateur dans la fenêtre), propre à l'agent. Faux par
   * défaut : la session vit en mémoire et s'efface à `browser_close`. Activer exige une confirmation native ; « Oublier » l'efface.
   */
  browserPersistent: boolean;
  rag: {
    /** Off by default: an index nobody asked for is an index nobody maintains. */
    enabled: boolean;
    /** "" follows the active provider when it is local, so nothing leaves the machine by default. */
    embeddingsUrl: string;
    /** "" lets the server pick; set it when the server hosts several models. */
    embeddingsModel: string;
    chunkSize: number;
    chunkOverlap: number;
    /** At most this many passages from the same document, or one long file takes every slot. */
    maxChunksPerDoc: number;
    topK: number;
    /** Chemins EXPLICITES, absolus, du worker Docling (jamais devinés) : l'interpréteur du venv et le script. Requis si `ecosystem.documentParser = "docling"`. */
    doclingPython: string;
    doclingWorker: string;
    /** Script du worker PDF (pdfium, `sidecars/pdfium-worker/`), lancé par `doclingPython` ; absolu. Les PDF ne passent PAS par Docling (DECISIONS 2026-09-30). */
    pdfiumWorker: string;
  };
  /** Local updates: installers built with `pnpm dist` appear in `folder` ("" = the app's own build folder). */
  updates: {
    folder: string;
    /** "" follows the running version: a build tagged -beta tracks betas, a release tracks stable. */
    channel: "" | "stable" | "beta";
    autoCheck: boolean;
    lastChecked: number;
    notified: string;
  };
  /**
   * Desktop app: closing the window keeps Jarod running in the notification area (schedules,
   * messaging bots and remote access keep working); start it with the session.
   */
  desktop: { closeToTray: boolean; launchAtLogin: boolean; trayHintShown: boolean };
  curator: CuratorConfig;
  /**
   * Recherche d'outils : « auto » ne décrit au modèle qu'un noyau d'outils (plus tool_search) quand le
   * fournisseur est local — petit contexte, préremplissage lent —, « on » toujours, « off » jamais.
   */
  toolSearch: "auto" | "on" | "off";
  /** Revue d'apprentissage en arrière-plan (voir `services/learning.ts`). */
  learning: LearningConfig;
  /**
   * L'auto-amélioration (`services/auto-improvement.ts`) : recherche GitHub, auto-analyse, rapport.
   * Dans `DEFAULT_SETTINGS`, éteinte : une installation existante ne lance rien de plus.
   *
   * STATUT : EXCLU — décision CLI Q1 du 2026-10-02 (une décision, pas une dette de portage). Les modules `auto-improvement*` ne sont pas portés et `jarod improve` est
   * retiré de l'aide. Seul le schéma reste ici (pour ne pas perdre un réglage existant à la lecture d'un profil). Exclusion conditionnelle, pas une renonciation :
   * conditions de réouverture dans DECISIONS (entrée CLI Q1).
   */
  autoImprovement: AutoImprovementConfig;
  /**
   * Politique du garde du shell (`run_shell`). Optionnel : les réglages existants restent valides
   * tels quels. Absent, le défaut s'applique — rien n'est demandé et rien n'est restreint, donc le
   * comportement reste celui d'avant. Voir `/shell-guard` pour ce qui est en vigueur.
   */
  shellGuard?: Partial<ShellPolicy>;
  /** E2 — le navigateur connecté : éteint, aucun domaine par défaut. Voir `ConnectedBrowserSettings`. */
  connectedBrowser?: Partial<ConnectedBrowserSettings>;
  /**
   * Les hôtes SSH DÉCLARÉS, vus depuis l'application : un nom, une adresse, un utilisateur, un port
   * et le CHEMIN d'une clé privée. Optionnel : les réglages existants restent valides tels quels, et
   * une installation qui ne déclare aucun hôte ne range rien.
   *
   * Aucun secret n'est rangé ici : un chemin de clé n'est pas une clé, et il n'existe aucun champ de
   * mot de passe ou de phrase de passe dans une déclaration. La vérification des clés d'hôte reste
   * active : cette liste ne transporte aucune option ssh, et rien ici ne peut en ajouter une.
   */
  sshHosts?: SshHostRecord[];
  /**
   * Ids of the declared SSH hosts on which the agent may run commands (`remote_exec`), one confirmed command at a time. Absent or
   * empty: off, and the tool is not offered to the model. Written only by the desktop's `ssh-host-exec-set` (native confirmation).
   */
  sshExecHosts?: string[];
  /**
   * La période du tick du plugin `automation`, en millisecondes — le seul réglage de cette famille
   * qui règle un TEMPS plutôt qu'une liste.
   *
   * Optionnel, et volontairement hors de `DEFAULT_SETTINGS` : une installation qui ne le pose pas ne
   * range rien, garde ses réglages tels quels (aucune migration), et continue avec la période d'avant
   * — 30 000 ms, le défaut de la V2. `patch()` ne le connaît donc pas : la clé se pose par
   * `settings.set` (ou par un bundle, quand elle y sera autorisée).
   *
   * Une valeur absurde n'est jamais transmise telle quelle : `normalizeAutomationTickMs` la ramène
   * dans ses bornes (voir `services/bundled-plugins.ts`), et la période EFFECTIVE est celle que le
   * rapport de couture annonce (`tickMs=…`).
   *
   * STATUT : NON PORTÉ — dette de portage, pas une exclusion. Le plugin `automation` (`automation-plugin.ts`) et `bundled-plugins.ts` (où vit
   * `normalizeAutomationTickMs`) ne sont pas portés : rien ne lit ce réglage. Voir PLAN (plugin-workflows) / P1.
   */
  automationTickMs?: number;
  /**
   * Jarod-cordis (PLAN §10, phase 0) : moteurs de l'écosystème activés pour CE profil (index vectoriel,
   * parseur, embeddings creux, reranker, décisions typées, journal). Dans `DEFAULT_SETTINGS`, tout
   * éteint = pile actuelle ; se lit par `ecosystemFlags()` (une valeur invalide rend les défauts).
   */
  ecosystem: EcosystemFlags;
}

export const DEFAULT_PERSONA = `Tu es Jarod, un assistant IA polyvalent qui tourne sur l'ordinateur de l'utilisateur.
Tu es direct, précis et chaleureux. Tu réponds dans la langue de l'utilisateur.
Quand une tâche demande d'agir (lire des fichiers, lancer une commande, chercher sur le web), utilise tes outils plutôt que de deviner.`;

export const DEFAULT_SETTINGS: Settings = {
  language: "fr",
  theme: "system",
  activeProvider: "anthropic",
  activeModel: "claude-opus-5",
  fallbacks: [],
  providerOverrides: {},
  persona: DEFAULT_PERSONA,
  thinking: true,
  effort: "",
  anthropicFallbacks: true,
  autoApproveTools: false,
  alwaysAllowTools: [],
  disabledTools: [],
  memoryInject: true,
  workspace: null,
  terminalShell: "",
  maxAgentSteps: 25,
  mcpServers: [],
  disabledSkills: [],
  skillVersions: {},
  disabledPlugins: [],
  permissionsRules: [],
  pluginTrust: {},
  agentMode: "build",
  autoTitle: true,
  compactThreshold: 240_000,
  // Inconnue par défaut : le noyau n'invente aucune fenêtre, il garde son plafond d'historique.
  contextWindow: 0,
  // Éteint par défaut : une installation qui ne dit rien n'est jamais arrêtée en cours de conversation.
  sessionBudget: { maxTokens: 0, maxCostUsd: 0, perSession: {} },
  telegram: { enabled: false, allowedChatIds: [] },
  discord: { enabled: false, allowedUserIds: [] },
  slack: { enabled: false, allowedUserIds: [] },
  email: {
    enabled: false,
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 465,
    user: "",
    from: "",
    allowedSenders: [],
    requireAuth: true,
    trustedAuthservIds: [],
    pollSeconds: 60,
    folder: "INBOX",
  },
  whatsapp: { enabled: false, phoneNumberId: "", port: 8791, allowedNumbers: [] },
  imageDescription: { mode: "auto", provider: "", model: "" },
  localEngine: { port: 8080, backend: "", installed: null, presets: [], activePreset: "", autoStart: false },
  // Éteint par défaut : aucun modèle ne se charge ni ne se décharge sans un geste de l'utilisateur.
  localModels: { hotswap: false },
  vault: [],
  apiServer: { enabled: false, port: 8642, host: "127.0.0.1" },
  lsp: { enabled: true, diagnoseAfterEdit: true, custom: [] },
  remote: { enabled: false, relayUrl: "", hostId: "", devices: [] },
  mobile: { enabled: false, port: 10492, devices: [] },
  android: { adbPath: "", timeoutMs: 15000 },
  // Éteint par défaut : rien n'écoute, donc une installation existante ne change pas d'un octet.
  webhooks: { enabled: false, port: DEFAULT_HOOK_PORT },
  voice: { sttProvider: "openai", sttModel: "whisper-1", autoSpeak: false, ttsVoice: "", ttsRate: 1 },
  browserVisible: true,
  browserPersistent: false,
  rag: {
    enabled: false,
    embeddingsUrl: "",
    embeddingsModel: "",
    chunkSize: 800,
    chunkOverlap: 100,
    maxChunksPerDoc: 2,
    topK: 5,
    doclingPython: "",
    doclingWorker: "",
    pdfiumWorker: "",
  },
  updates: { folder: "", channel: "", autoCheck: true, lastChecked: 0, notified: "" },
  desktop: { closeToTray: true, launchAtLogin: false, trayHintShown: false },
  curator: {
    enabled: true,
    intervalHours: 168,
    minIdleHours: 2,
    staleAfterDays: 14,
    archiveAfterDays: 30,
    lastRunAt: 0,
  },
  toolSearch: "auto",
  learning: { enabled: true, reviewEvery: 8 },
  autoImprovement: DEFAULT_AUTO_IMPROVEMENT,
  shellGuard: DEFAULT_SHELL_POLICY,
  connectedBrowser: DEFAULT_CONNECTED_BROWSER,
  ecosystem: DEFAULT_ECOSYSTEM_FLAGS,
};

export type { AutoImprovementConfig };
