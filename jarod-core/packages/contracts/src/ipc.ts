/**
 * ui-bridge unique main ↔ renderer (PLAN §0.2 et §0.4, W8 ; pattern One-AI W2 :
 * `One-AI/apps/desktop/src/preload/index.ts:349-381`, `packages/ui-bridge/src/channels.ts`).
 *
 * Le preload expose UN objet, `window.oneai = { invoke, on, host }`, et rien d'autre (verrou de test
 * `@jarod/desktop`). Double allowlist : un canal invoke n'est jamais écoutable, un canal d'événement
 * n'est jamais invocable ; le main refait le contrôle (expéditeur de confiance + allowlist). Les
 * surfaces historiques (`window.hermesAPI`) sont des shims côté renderer au-dessus de `oneai`.
 */
import { HERMES_EVENT_CHANNELS, HERMES_INVOKE_CHANNELS } from "./ipc-hermes-channels.js";

export { HERMES_EVENT_CHANNELS, HERMES_INVOKE_CHANNELS };

/**
 * Canaux propres à Jarod (absents de la surface hermesAPI de SANK-UI) — capture vocale continue (W10) :
 * `voice-capture-feed` (PCM 16 kHz int16 du micro → mot d'activation → commande), `voice-capture-status` ;
 * dossier de travail PAR DÉFAUT (SPECS-P5-WORKSPACE.md) : `get-default-workspace`, `set-default-workspace` (dossier choisi dans la
 * boîte native pendant ce lancement seulement, jamais un chemin libre).
 */
export const JAROD_INVOKE_CHANNELS = [
  "voice-capture-feed",
  "voice-capture-status",
  "get-default-workspace",
  "set-default-workspace",
  // Accord des outils (SPECS-P5-UI-PARITE.md §1) : réponse à une demande poussée, relecture des demandes en attente.
  "tool-approval-respond",
  "tool-approval-pending",
  // Portée « cette conversation » (SPECS-P5-UI-PARITE.md § 8.3) : compte des accords en cours, et retrait de tous.
  "tool-approval-grants",
  "tool-approval-grants-clear",
  // Réglages propres à Jarod sans équivalent hermesAPI (SPECS-P5-UI-PARITE.md §2) : lecture et écriture validées, liste blanche.
  "get-jarod-settings",
  "set-jarod-settings",
  // Listes de choix pour ces écrans (fournisseurs et leurs modèles), sans clé ni secret.
  "get-jarod-options",
  // Terminal intégré (SPECS-P5-UI-PARITE.md §5) : le renderer ne choisit ni le programme ni le dossier.
  "terminal-open",
  "terminal-attach",
  "terminal-write",
  "terminal-resize",
  "terminal-close",
  "terminal-list",
  // Navigateur de l'agent : efface sa session (cookies, connexions) après une confirmation native.
  "agent-browser-forget",
  // Plugins utilisateur : liste, activation (confirmation native), confiance (confirmation native).
  "plugins-list",
  "plugin-set-enabled",
  "plugin-set-trust",
  // Coffre d'identifiants : la valeur part du renderer vers le main et n'en revient jamais.
  "vault-list",
  "vault-save",
  "vault-remove",
  // Jarod-OS (Sécurité › Secrets) : état de protection du coffre, et retrait de toute portée sans effacer la valeur.
  "vault-status",
  "vault-revoke",
  // Hôtes SSH déclarés : la clé se choisit dans la boîte native, jamais tapée.
  "ssh-hosts-list",
  "ssh-pick-key",
  "ssh-host-add",
  "ssh-host-remove",
  "ssh-host-test",
  "ssh-host-exec-set",
  // Téléphone (pont local, appairage) et Android (adb) : l'allumage et le programme adb passent par des boîtes natives.
  "phone-status",
  "phone-bridge-set",
  "phone-pairing",
  "phone-revoke",
  "android-pick-adb",
  "android-set-adb",
  // API compatible OpenAI : allumage (boîte native), clé neuve montrée une fois.
  "api-server-status",
  "api-server-set",
  "api-server-new-key",
  // Moteur local llama.cpp : installation (boîte native), préréglages en champs structurés (modèle choisi dans la boîte « Ouvrir »), démarrage, estimation de mémoire.
  "local-engine-status",
  "local-engine-configure",
  "local-engine-install",
  "local-engine-install-cancel",
  "local-engine-add-preset",
  "local-engine-pick-model",
  "local-engine-preset-save",
  "local-engine-preset-remove",
  "local-engine-start",
  "local-engine-stop",
  "local-engine-fit",
  // Modèles locaux en mémoire (llama.cpp, LM Studio) : liste, charger, décharger, hotswap (un seul modèle de chat local, chargé à la demande du chat).
  "local-models-list",
  "local-models-load",
  "local-models-unload",
  "local-models-configure",
  // Hugging Face (SPECS-P5-MODELS.md § 3.10 (d)) : tout part du MAIN, sur un geste explicite de l'utilisateur ; jamais un chemin, une taille, une empreinte ni une URL venant du renderer.
  "hf-search",
  "hf-repo",
  "hf-fit",
  "hf-download",
  "hf-download-cancel",
  "hf-models-dir",
  "hf-pick-models-dir",
  // Volet Documents : « Reindex » (SPECS-P5-UI-PARITE.md § 20) — redécoupe depuis le texte gardé, boîte native avec le compte, état de la passe interrogé.
  "rag-index-status",
  "rag-reindex",
  "rag-reindex-cancel",
  // Automation (SPECS-P5-AUTOMATION.md) — CRUD règles + exécution manuelle.
  "automation-list",
  "automation-create",
  "automation-get",
  "automation-update",
  "automation-delete",
  "automation-run",
  // Secrets illisibles (AV2-009) : les NOMS des clés que le trousseau ne sait plus lire — la fenêtre les liste et propose la ressaisie.
  "secrets-unreadable",
  // Écran « Plateforme » : instantané en lecture seule + approbation d'un outil MCP dont la description a changé.
  "platform-status",
  "mcp-approve-tool",
  // Écran « Capacités » (cockpit, lot 1) : le registre vivant, en lecture seule ; resonder une capacité par son identifiant.
  "capabilities-list",
  "capabilities-check",
] as const;
/**
 * `voice-state` (listening/recording/transcribing), `voice-transcript` (commande transcrite), `voice-error` ; `tool-approval-request`
 * (l'agent attend l'accord de l'utilisateur pour un outil) et `tool-approval-resolved` (la demande est close : réponse, arrêt ou délai).
 */
export const JAROD_EVENT_CHANNELS = ["voice-state", "voice-transcript", "voice-error", "tool-approval-request", "tool-approval-resolved", "terminal-data", "terminal-exit", "local-engine-progress", "hf-progress", "local-models-activity"] as const;

/** Canaux request/response autorisés (source de vérité unique pour le preload ET le main). */
export const ONEAI_INVOKE_CHANNELS: readonly string[] = [...HERMES_INVOKE_CHANNELS, ...JAROD_INVOKE_CHANNELS];
/** Canaux poussés main → renderer autorisés. */
export const ONEAI_EVENT_CHANNELS: readonly string[] = [...HERMES_EVENT_CHANNELS, ...JAROD_EVENT_CHANNELS];

export type OneaiInvokeChannel = (typeof HERMES_INVOKE_CHANNELS)[number] | (typeof JAROD_INVOKE_CHANNELS)[number];
export type OneaiEventChannel = (typeof HERMES_EVENT_CHANNELS)[number] | (typeof JAROD_EVENT_CHANNELS)[number];

const INVOKE = new Set(ONEAI_INVOKE_CHANNELS);
const EVENTS = new Set(ONEAI_EVENT_CHANNELS);

export function isOneaiInvokeChannel(channel: unknown): channel is OneaiInvokeChannel {
  return typeof channel === "string" && INVOKE.has(channel);
}

export function isOneaiEventChannel(channel: unknown): channel is OneaiEventChannel {
  return typeof channel === "string" && EVENTS.has(channel);
}

/** Refus = exception, jamais une valeur : « inconnu » ne doit pas passer pour « fait ». */
export function assertOneaiChannel(kind: "invoke" | "event", channel: unknown): string {
  const ok = kind === "invoke" ? isOneaiInvokeChannel(channel) : isOneaiEventChannel(channel);
  if (!ok) throw new Error(`[oneai] canal IPC non autorisé (${kind}) : ${String(channel)}`);
  return channel as string;
}

/**
 * `update-messaging-platform` : variables SANK-UI (noms Hermes) qui ont un équivalent Jarod DE MÊME SENS, par
 * passerelle — les SEULES que le main liste (`get-messaging-platforms`) et que le renderer envoie. Les autres
 * (TELEGRAM_ALLOWED_USERS, TELEGRAM_PROXY, DISCORD_ALLOWED_USERS, pont WhatsApp « QR » d'Hermes…) ne partent
 * jamais vers le main ; le main les refuse de toute façon (fail-closed). Correspondance secret/réglage :
 * `ENV_EQUIVALENTS` du main (`handlers/gateways.ts`). `allowedChatIds` n'est PAS une de ces variables : il ne
 * s'expose qu'avec une UI Jarod explicite, jamais par conversion de TELEGRAM_ALLOWED_USERS.
 */
export const MESSAGING_PLATFORM_ENV_KEYS = {
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  email: ["EMAIL_ADDRESS", "EMAIL_PASSWORD", "EMAIL_IMAP_HOST", "EMAIL_SMTP_HOST"],
  whatsapp: [],
} as const satisfies Record<"telegram" | "discord" | "slack" | "email" | "whatsapp", readonly string[]>;
export type MessagingPlatformEnvKey = (typeof MESSAGING_PLATFORM_ENV_KEYS)[keyof typeof MESSAGING_PLATFORM_ENV_KEYS][number];

/** La variable `key` est-elle une variable Jarod de la passerelle `platform` ? (clé inconnue → non). */
export function isMessagingPlatformEnvKey(platform: string, key: string): key is MessagingPlatformEnvKey {
  if (!Object.hasOwn(MESSAGING_PLATFORM_ENV_KEYS, platform)) return false;
  return (MESSAGING_PLATFORM_ENV_KEYS[platform as keyof typeof MESSAGING_PLATFORM_ENV_KEYS] as readonly string[]).includes(key);
}

/** Les TROIS membres de `window.oneai`, et aucun autre (verrou `@jarod/desktop`). */
export const ONEAI_BRIDGE_KEYS = ["invoke", "on", "host"] as const;

/**
 * `oneai.host` = surface FERMÉE par défaut (décision utilisateur 2026-09-27) : ce qui ne peut PAS
 * traverser l'IPC et reste donc au preload, capacité par capacité. Ajouter une capacité = l'ajouter
 * ici ET au verrou de test ; toute autre clé fait échouer le preload.
 * - `getPathForFile` : chemin disque d'un `File` DÉPOSÉ (glisser-déposer) — `webUtils.getPathForFile`,
 *   un `File` n'est pas sérialisable. Seule capacité touchant au disque : jamais de lecture d'un
 *   chemin arbitraire, jamais de chemin fourni par le renderer.
 * - `process` : `platform` et trois versions (chrome, electron, node), en lecture seule.
 */
export const ONEAI_HOST_CAPABILITIES = ["getPathForFile", "process"] as const;
export type OneaiHostCapability = (typeof ONEAI_HOST_CAPABILITIES)[number];

export interface OneaiHost {
  getPathForFile(file: unknown): string;
  process: { platform: string; versions: { chrome?: string; electron?: string; node?: string } };
}

/** Refuse un `host` qui porte autre chose que la liste explicite (ou qui en manque une). */
export function assertOneaiHost(host: Record<string, unknown>): OneaiHost {
  const keys = Object.keys(host).sort();
  const expected = [...ONEAI_HOST_CAPABILITIES].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new Error(`[oneai] host hors liste de capacités : ${keys.join(", ")} (attendu : ${expected.join(", ")})`);
  }
  if (typeof host.getPathForFile !== "function") throw new Error("[oneai] host.getPathForFile doit être une fonction");
  return host as unknown as OneaiHost;
}

/** `window.oneai`. `on` rend sa désinscription ; l'écouteur reçoit la charge utile (sans l'événement IPC). */
export interface OneaiBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void;
  host: OneaiHost;
}
