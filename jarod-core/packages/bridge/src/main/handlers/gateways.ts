/**
 * Passerelles de messagerie : `start-gateway` / `stop-gateway` / `restart-gateway` / `gateway-status`.
 * Sources : SANK-UI `src/main/ipc/register.ts:1873-1935` et `src/main/hermes.ts:2997-3003`
 * (`GatewayStartResult`) — rév. 3aaadb0, MIT © github.com/fathah. Hermes démarre UN processus
 * passerelle (toutes plateformes) ; Jarod a le `GatewayHub` (plugin-gateways) : démarrer = `syncAll()`
 * (les passerelles ACTIVÉES dans les réglages, comme `core.init()`), arrêter = `stopAll()`,
 * « en marche » = au moins une passerelle à l'état `running`.
 */
import { DISCORD_TOKEN_KEY, EMAIL_PASSWORD_KEY, type GatewayStatus, SLACK_APP_TOKEN_KEY, SLACK_BOT_TOKEN_KEY, TELEGRAM_TOKEN_KEY, WHATSAPP_TOKEN_KEY } from "@jarod/contracts";
import { isMessagingPlatformEnvKey, type MessagingPlatformEnvKey } from "@jarod/contracts/ipc";
import { API_KEY_SECRET } from "@jarod/plugin-llm";
import {
  buildMessagingPlatforms,
  type MessagingPlatformInfo,
  type MessagingPlatformsResponse,
  type MessagingPlatformTestResponse,
  type MessagingPlatformUpdate,
  testMessagingPlatformStatus,
  validateMessagingPlatformUpdate,
} from "../../sank/src/shared/messaging-platforms.js";
import { assertProfile, type HandlerContext } from "./context.js";
import { SECRET_MASK } from "./tools.js";

const IDS: GatewayStatus["id"][] = ["telegram", "discord", "slack", "email", "whatsapp"];

/**
 * D1(b) — variables Hermes qui ont un équivalent Jarod DE MÊME SENS (liste par passerelle :
 * `MESSAGING_PLATFORM_ENV_KEYS`, `@jarod/contracts/ipc`) : un secret du coffre ou un champ du réglage `email` ;
 * les autres (TELEGRAM_PROXY, TELEGRAM_ALLOWED_USERS, DISCORD_REPLY_TO_MODE, pont WhatsApp « QR » d'Hermes…) ne
 * sont ni listées à l'écran ni écrites. WhatsApp : Jarod = API Cloud de Meta (jeton + « Phone number ID »), pas le
 * pont d'Hermes. `write("")` efface (secret retiré, champ vidé).
 */
type EnvField = { secret: string } | { email: "user" | "imapHost" | "smtpHost" };
const ENV_EQUIVALENTS: Record<MessagingPlatformEnvKey, EnvField> = {
  TELEGRAM_BOT_TOKEN: { secret: TELEGRAM_TOKEN_KEY },
  DISCORD_BOT_TOKEN: { secret: DISCORD_TOKEN_KEY },
  SLACK_BOT_TOKEN: { secret: SLACK_BOT_TOKEN_KEY },
  SLACK_APP_TOKEN: { secret: SLACK_APP_TOKEN_KEY },
  EMAIL_ADDRESS: { email: "user" },
  EMAIL_PASSWORD: { secret: EMAIL_PASSWORD_KEY },
  EMAIL_IMAP_HOST: { email: "imapHost" },
  EMAIL_SMTP_HOST: { email: "smtpHost" },
};
const isEnvSet = (f: EnvField, k: { secret(key: string): boolean; settings: Record<string, unknown> }) =>
  "secret" in f ? k.secret(f.secret) : Boolean((k.settings.email as Record<string, string | undefined>)[f.email]);

/** « Configurée » au sens de Jarod (ce que chaque passerelle exige pour démarrer). */
const CONFIGURED: Record<GatewayStatus["id"], (k: { secret(key: string): boolean; settings: Record<string, unknown> }) => boolean> = {
  telegram: (k) => k.secret(TELEGRAM_TOKEN_KEY),
  discord: (k) => k.secret(DISCORD_TOKEN_KEY),
  slack: (k) => k.secret(SLACK_BOT_TOKEN_KEY) && k.secret(SLACK_APP_TOKEN_KEY),
  email: (k) => {
    const e = k.settings.email as { user?: string; imapHost?: string; smtpHost?: string };
    return Boolean(e.user && e.imapHost && e.smtpHost) && k.secret(EMAIL_PASSWORD_KEY);
  },
  whatsapp: (k) => Boolean((k.settings.whatsapp as { phoneNumberId?: string }).phoneNumberId) && k.secret(WHATSAPP_TOKEN_KEY),
};

const GATEWAY_MESSAGE =
  "Jarod-One : jetons dans le coffre chiffré du profil, jamais affichés ; seuls les champs qui ont un équivalent Jarod sont modifiables.";

const SYNC = { telegram: "syncTelegram", discord: "syncDiscord", slack: "syncSlack", email: "syncEmail", whatsapp: "syncWhatsApp" } as const;
const isJarodGateway = (id: unknown): id is GatewayStatus["id"] => typeof id === "string" && (IDS as string[]).includes(id);

export function createGatewayHandlers(ctx: HandlerContext) {
  const hub = () => ctx.kernel().gateways;
  const running = () => IDS.some((id) => hub().gatewayStatus(id).state === "running");
  const settings = () => ctx.kernel().agent.settings;
  /** Réglage `<id>.enabled`. */
  const setEnabled = (id: GatewayStatus["id"], enabled: boolean) => {
    const s = settings();
    s.set(id, { ...s.get(id), enabled } as never);
  };
  /**
   * Après une écriture, la passerelle modifiée est relancée SI la passerelle tourne (`register.ts:2021-2029` :
   * `restartGateway` seulement si elle est en marche) ; `sync<Id>` arrête puis redémarre selon le réglage et le jeton.
   */
  const resync = (id: GatewayStatus["id"]) => {
    if (running()) void hub()[SYNC[id]]();
  };
  const writeEnv = (platform: GatewayStatus["id"], key: string, value: string) => {
    if (!isMessagingPlatformEnvKey(platform, key)) throw new Error(`${key} : sans équivalent dans Jarod-One (non enregistré)`);
    const f = ENV_EQUIVALENTS[key];
    if ("secret" in f) settings().setSecret(f.secret, value);
    else settings().set("email", { ...settings().get("email"), [f.email]: value });
  };

  /**
   * `register.ts:2034-2066`, `shared/messaging-platforms.ts:920-979` (`buildMessagingPlatforms`, appelée telle
   * quelle) : les 5 passerelles de Jarod seulement (les autres plateformes d'Hermes n'ont pas d'implémentation
   * ici). Écarts : valeurs JAMAIS transmises (présence seulement, `redacted_value` masquée) ; « configurée » =
   * critère Jarod ; activée = réglage `<id>.enabled` ; état = `GatewayHub` (en marche → « connected », erreur →
   * message) ; pas d'outils par plateforme chez Jarod (`toolsets: []`) ; éditable (écritures portées, V1) ;
   * `env_vars` réduits aux variables Jarod de la passerelle (`MESSAGING_PLATFORM_ENV_KEYS`) : l'écran n'affiche
   * donc aucun champ sans équivalent (TELEGRAM_ALLOWED_USERS…) et ne peut pas le soumettre.
   */
  const listPlatforms = (profile?: unknown): MessagingPlatformsResponse => {
    assertProfile(ctx, profile);
    const s = settings();
    const secrets = new Set(s.secretKeys());
    const k = { secret: (key: string) => secrets.has(key), settings: s.getAll() as unknown as Record<string, unknown> };
    const env: Record<string, string> = {};
    for (const [name, f] of Object.entries(ENV_EQUIVALENTS)) if (isEnvSet(f, k)) env[name] = SECRET_MASK;
    const enabled: Record<string, boolean> = {};
    const states: Record<string, { state: string; error_message?: string | null }> = {};
    for (const id of IDS) {
      enabled[id] = Boolean((k.settings[id] as { enabled?: boolean } | undefined)?.enabled);
      const st = hub().gatewayStatus(id);
      if (st.state === "running") states[id] = { state: "connected" };
      else if (st.state === "error") states[id] = { state: "error", error_message: st.error ?? null };
    }
    const isRunning = running();
    const built = buildMessagingPlatforms(env, enabled, isRunning, {}, states);
    const platforms = built.platforms
      .filter((p) => (IDS as string[]).includes(p.id))
      .map((p): MessagingPlatformInfo => {
        const configured = CONFIGURED[p.id as GatewayStatus["id"]](k);
        // Même règle d'état que `buildMessagingPlatform` (:955-960), avec le critère « configurée » de Jarod.
        let state = "disabled";
        if (p.enabled && !configured) state = "not_configured";
        else if (p.enabled && isRunning) state = states[p.id]?.state || "configured";
        else if (p.enabled) state = "gateway_stopped";
        return {
          ...p,
          configured,
          state,
          env_vars: p.env_vars
            .filter((v) => isMessagingPlatformEnvKey(p.id, v.key))
            .map((v) => ({ ...v, redacted_value: v.is_set ? SECRET_MASK : null })),
          toolsets: [],
        };
      });
    return { editable: true, message: GATEWAY_MESSAGE, platforms, source: built.source };
  };

  return {
    "start-gateway": () => {
      const alreadyRunning = running();
      hub().syncAll();
      // Démarrage asynchrone (getMe, connexions) : `running` dit l'état à cet instant, l'écran relit `gateway-status`.
      return { success: true, running: running(), ...(alreadyRunning ? { alreadyRunning } : {}) };
    },
    "stop-gateway": () => {
      hub().stopAll();
      return true;
    },
    "restart-gateway": (profile?: unknown) => {
      assertProfile(ctx, profile);
      hub().stopAll();
      hub().syncAll();
      return true;
    },
    "gateway-status": () => running(),
    "get-messaging-platforms": (profile?: unknown): MessagingPlatformsResponse => listPlatforms(profile),
    /**
     * D1(b) écritures (V1 : passerelles éditables dès ce portage) — `register.ts:2069-2117`,
     * `messaging-platforms.ts:74-129` (`applyMessagingPlatformUpdate` : `clear_env` vidés, `env` non vides écrits,
     * puis `enabled`, puis `toolsets`), validation `shared/messaging-platforms.ts:1071-1096` appelée telle quelle.
     * Écarts : passerelles de Jarod seulement ; une valeur égale au masque = « inchangée » (V1) ; variable sans
     * équivalent Jarod ou `toolsets` (pas d'outils par plateforme chez Jarod) → ERREUR, rien d'écrit (validation
     * complète avant la première écriture) ; jamais `ok: true` pour une écriture qui n'a pas eu lieu.
     */
    "update-messaging-platform": (platform: unknown, update: unknown, profile?: unknown): { ok: boolean; platform: string } => {
      assertProfile(ctx, profile);
      if (!isJarodGateway(platform)) throw new Error(`Passerelle « ${String(platform)} » absente de Jarod-One`);
      const u = (update && typeof update === "object" && !Array.isArray(update) ? update : {}) as MessagingPlatformUpdate;
      validateMessagingPlatformUpdate(platform, u);
      if (u.toolsets && Object.keys(u.toolsets).length) throw new Error("Jarod-One n'a pas d'outils par passerelle (toolsets non modifiables).");
      if (u.enabled !== undefined && typeof u.enabled !== "boolean") throw new Error("enabled : booléen attendu");
      const writes: Array<[string, string]> = [];
      for (const key of u.clear_env ?? []) writes.push([key, ""]);
      for (const [key, value] of Object.entries(u.env ?? {})) {
        const trimmed = String(value ?? "").trim();
        if (trimmed && trimmed !== SECRET_MASK) writes.push([key, trimmed]);
      }
      for (const [key] of writes) if (!isMessagingPlatformEnvKey(platform, key)) throw new Error(`${key} : sans équivalent dans Jarod-One (non enregistré)`);
      for (const [key, value] of writes) writeEnv(platform, key, value);
      if (u.enabled !== undefined) setEnabled(platform, u.enabled);
      resync(platform);
      return { ok: true, platform };
    },
    /** `register.ts:2119-2160` → `testMessagingPlatformStatus` (partagé, tel quel) sur la réponse de `get-messaging-platforms`. */
    "test-messaging-platform": (platform: unknown, profile?: unknown): MessagingPlatformTestResponse => {
      const p = listPlatforms(profile).platforms.find((e) => e.id === platform);
      if (!p) return { ok: false, state: "unknown", message: `Unknown messaging platform: ${String(platform)}` };
      return testMessagingPlatformStatus(p);
    },
    /** `register.ts:2006-2011` : `{ <plateforme>: activée }` — les 5 passerelles de Jarod (réglage `<id>.enabled`). */
    "get-platform-enabled": (profile?: unknown): Record<string, boolean> => {
      assertProfile(ctx, profile);
      return Object.fromEntries(IDS.map((id) => [id, Boolean((settings().get(id) as { enabled?: boolean }).enabled)]));
    },
    /** `register.ts:2012-2032` ; plateforme hors Jarod → erreur (SANK-UI écrit le réglage d'une plateforme quelconque). */
    "set-platform-enabled": (platform: unknown, enabled: unknown, profile?: unknown): boolean => {
      assertProfile(ctx, profile);
      if (!isJarodGateway(platform)) throw new Error(`Passerelle « ${String(platform)} » absente de Jarod-One`);
      if (typeof enabled !== "boolean") throw new Error("enabled : booléen attendu");
      setEnabled(platform, enabled);
      resync(platform);
      return true;
    },
    /**
     * `register.ts:1270-1272`, `config.ts:1289-1307` : la clé de l'API OpenAI-compatible de Jarod existe-t-elle
     * (`api:openai:key`, coffre) ? Jamais sa valeur. `providerId` (fournisseur de secrets Hermes) sans équivalent.
     */
    "get-api-server-key-status": (profile?: unknown) => {
      assertProfile(ctx, profile);
      return { hasKey: ctx.kernel().agent.settings.secretKeys().includes(API_KEY_SECRET), checkedAt: Date.now() };
    },
  };
}
