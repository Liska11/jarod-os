/**
 * Portage de packages/core/test/helpers.ts : `makeCore` démarre un kernel RÉEL (tous les plugins
 * locaux, vraie base chiffrée) sur un dossier temporaire et rend le runtime avec les mêmes membres que
 * `JarodCore` (`sessions`, `messages`, `settings`, `providers`, `submit`…). Libéré après chaque test.
 */
import type { Cipher, SchedulerConfig } from "@jarod/contracts";
import { bootApp, cleanup, discoverPlugins, shutdown, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore, type KeyStore } from "@jarod/plugin-storage";
import { afterEach } from "vitest";
import type { RuntimeMode } from "../src/runtime-lock.js";
import type {} from "../src/index.js";

export { tempDir };

/** Shared in-memory key store: fast, and keys survive re-opening a core on the same folder. */
export const testKeys = memoryKeyStore();

export interface CoreOptions {
  dataDir?: string;
  keyStores?: KeyStore[];
  cipher?: Cipher;
  encryptDb?: boolean;
  runtimeMode?: RuntimeMode;
  appVersion?: string;
  scheduler?: SchedulerConfig;
}

export async function makeCore(opts: CoreOptions = {}) {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = {
    dataDir: opts.dataDir ?? tempDir(),
    keyStores: opts.keyStores ?? [testKeys],
    ...(opts.cipher ? { cipher: opts.cipher } : {}),
    ...(opts.encryptDb === undefined ? {} : { encryptDb: opts.encryptDb }),
  };
  // Comme `new JarodCore()` sans `init()` : le tick du planificateur ne tourne pas tout seul.
  plugins.scheduler = { autoStart: false, ...opts.scheduler };
  plugins.agent = { ...(opts.runtimeMode ? { runtimeMode: opts.runtimeMode } : {}), ...(opts.appVersion ? { appVersion: opts.appVersion } : {}) };
  const app = await bootApp(plugins);
  return Object.assign(app.agent, {
    app,
    options: { dataDir: app.storage.dataDir },
    dbEncryption: app.storage.dbEncryption,
    scheduler: app.scheduler,
    jobs: app.jobs,
    /** Le kernel a déjà fait ce que faisait `init()` (graines, chargement, verrou) au démarrage. */
    init: async () => {},
    dispose: () => shutdown(app),
  });
}

export type TestCore = Awaited<ReturnType<typeof makeCore>>;

afterEach(cleanup);
