// Portage de packages/cli/src/context.ts (rév. 2e180305) : `JarodCore` → kernel cordis démarré.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DISCORD_TOKEN_KEY,
  EMAIL_PASSWORD_KEY,
  RELAY_TOKEN_KEY,
  SLACK_APP_TOKEN_KEY,
  SLACK_BOT_TOKEN_KEY,
  WHATSAPP_APP_SECRET_KEY,
  WHATSAPP_TOKEN_KEY,
} from "@jarod/contracts";
import { discoverPlugins, JarodApp, type Started, start, stop } from "@jarod/kernel";
import type { AgentRuntime, RuntimeMode } from "@jarod/plugin-agent";
import type { GatewayHub } from "@jarod/plugin-gateways";
import { type EngineService, secretKeyFor } from "@jarod/plugin-llm";
import { ProfileManager } from "@jarod/plugin-persona";
import type { Scheduler, WebhookService } from "@jarod/plugin-scheduler";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";

/** Same location as the desktop app (Electron's appData + "Jarod-One/data"). */
export function defaultDataRoot(env = process.env, platform = process.platform, home = homedir()): string {
  if (env.JAROD_HOME) return env.JAROD_HOME;
  const appData =
    platform === "win32"
      ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return join(appData, "Jarod-One", "data");
}

/**
 * API keys stored by the desktop app are encrypted with the OS keychain via Electron: the CLI reads them from the environment instead.
 * Jarod-cordis (B3) : sous Windows, le CLI lit aussi le coffre du desktop (`electronSecretsCipher`) ; l'environnement reste le repli.
 */
export const ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  huggingface: ["HF_TOKEN"],
  custom: ["JAROD_CUSTOM_API_KEY"],
};

/**
 * Messaging and relay tokens, which the desktop app also keeps in the OS keychain: on a server, a
 * container or under a service manager they come from the environment.
 * Jarod-cordis (B3) : sauf le jeton Telegram (`gateway:telegram:token`), lu EXCLUSIVEMENT dans le coffre chiffré
 * du profil — écran Passerelles du desktop ; aucune variable d'environnement ne le remplace.
 */
export const ENV_TOKENS: Record<string, string[]> = {
  [DISCORD_TOKEN_KEY]: ["JAROD_DISCORD_TOKEN", "DISCORD_BOT_TOKEN"],
  [SLACK_BOT_TOKEN_KEY]: ["JAROD_SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN"],
  [SLACK_APP_TOKEN_KEY]: ["JAROD_SLACK_APP_TOKEN", "SLACK_APP_TOKEN"],
  [RELAY_TOKEN_KEY]: ["JAROD_RELAY_TOKEN"],
  [EMAIL_PASSWORD_KEY]: ["JAROD_EMAIL_PASSWORD"],
  [WHATSAPP_TOKEN_KEY]: ["JAROD_WHATSAPP_TOKEN"],
  [WHATSAPP_APP_SECRET_KEY]: ["JAROD_WHATSAPP_APP_SECRET"],
};

export type CliCore = AgentRuntime & {
  scheduler: Scheduler;
  /** Les déclencheurs entrants (plugin-scheduler) : l'état réel pour `webhooksLine` (absent = service non monté). */
  webhooks?: WebhookService;
  /** Les passerelles (plugin-gateways) : démarrées par `init()` seulement (`jarod serve`). */
  gatewayHub: GatewayHub;
  /** Le moteur llama.cpp du plugin llm (absent si le plugin n'est pas chargé) : `jarod serve` le démarre sur demande. */
  engine?: EngineService;
  /** Événements kernel (`gateway:status`…) : ce que `core.on(…)` écoutait (`JarodCore` était un Emitter). */
  app: JarodApp;
  /** `core.init()` (core.ts:655-690) : ce que le kernel n'a pas déjà fait au démarrage — les passerelles. */
  init(): Promise<void>;
  dispose(): Promise<void>;
};

export interface CliContext {
  core: CliCore;
  profile: string;
  dataDir: string;
  started: Started;
}

export async function openCore(
  opts: {
    profile?: string;
    env?: NodeJS.ProcessEnv;
    runtimeMode?: RuntimeMode;
    /**
     * Le cœur complet, comme `openCore()` + `core.init()` dans la source (`jarod serve`) : verrou du
     * profil, graines, tick planifié, MCP, curator. Les passerelles attendent `core.init()` : elles
     * lisent leurs jetons : coffre du profil, ou l'environnement (ENV_TOKENS) une fois le cœur ouvert.
     */
    init?: boolean;
  } = {},
): Promise<CliContext> {
  const env = opts.env ?? process.env;
  const root = defaultDataRoot(env);
  if (!existsSync(root) && !env.JAROD_HOME) {
    throw new Error(
      `Aucune donnée Jarod-One trouvée dans ${root}. Lancez l'application une première fois, ou définissez JAROD_HOME.`,
    );
  }
  const profiles = new ProfileManager(root);
  const profile = opts.profile ?? profiles.active();
  if (!profiles.list().includes(profile)) throw new Error(`Profil inconnu : ${profile}`);
  const dataDir = profiles.dirFor(profile);
  // `new JarodCore({ dataDir, cipher })` sans `init()` : ni verrou, ni graines, ni tick planifié.
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  // Secrets : `pl:` (écrits sans trousseau) et, sous Windows, `ss:` du desktop (safeStorage, clé de `Local State`).
  plugins.storage = { dataDir, cipher: electronSecretsCipher(electronUserDataDir(env)) };
  plugins.gateways = { autoStart: false };
  const mode = opts.runtimeMode ? { runtimeMode: opts.runtimeMode } : {};
  if (opts.init) plugins.agent = mode;
  else {
    plugins.scheduler = { autoStart: false };
    plugins.skills = { seed: false };
    plugins.mcp = { autoSync: false };
    plugins.agent = { runtimeLock: false, curatorTimer: false, ...mode };
    // Plugins utilisateur : semés et chargés par `init()` seulement (core.ts:658,661).
    plugins.workflows = { seed: false, load: false };
  }
  // Portability (memory plugin) : nécessaire pour `portability apply` même sans init.
  plugins.memory = {};
  const app = new JarodApp({ plugins });
  const started = await start(app);
  const kernel = app as unknown as {
    agent: AgentRuntime;
    scheduler: Scheduler;
    webhooks?: WebhookService;
    gateways: GatewayHub;
    llm?: { engine: EngineService };
  };
  const core = Object.assign(kernel.agent, {
    scheduler: kernel.scheduler,
    webhooks: kernel.webhooks,
    gatewayHub: kernel.gateways,
    ...(kernel.llm ? { engine: kernel.llm.engine } : {}),
    app,
    init: async () => kernel.gateways.syncAll(),
    dispose: () => stop(started),
  });

  // Environment variables take over for keys the CLI cannot decrypt.
  const stored = core.settings.getSecret.bind(core.settings);
  core.settings.getSecret = (key: string) => {
    // A secret this process cannot decrypt (another OS account, `ss:` off Windows): fall through to the environment.
    let fromDb: string | undefined;
    try {
      fromDb = stored(key);
    } catch {
      fromDb = undefined;
    }
    if (fromDb) return fromDb;
    const token = ENV_TOKENS[key]?.map((k) => env[k]).find(Boolean);
    if (token) return token;
    const provider = Object.keys(ENV_KEYS).find((p) => secretKeyFor(p) === key);
    return provider ? ENV_KEYS[provider]!.map((k) => env[k]).find(Boolean) : undefined;
  };
  core.settings.secretKeys = () =>
    Object.entries(ENV_KEYS)
      .filter(([p, keys]) => keys.some((k) => env[k]) || Boolean(stored(secretKeyFor(p))))
      .map(([p]) => secretKeyFor(p));
  return { core, profile, dataDir, started };
}
