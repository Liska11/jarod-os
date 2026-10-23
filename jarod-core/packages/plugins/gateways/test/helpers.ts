/**
 * Portage de packages/core/test/helpers.ts pour les passerelles : `makeCore` démarre un kernel RÉEL
 * (tous les plugins locaux, vraie base chiffrée) et rend un cœur qui a les membres de `JarodCore`
 * utilisés par les tests : ceux du runtime (plugin-agent) ET ceux des passerelles (`ctx.gateways` :
 * `syncTelegram`, `pairing`, `telegram`, `handleGatewayMessage`, `on("gateway")`…). Poser
 * `core.telegram = …` passe par le hub, donc enregistre la passerelle auprès du runtime, comme dans
 * la source où `deliver` lisait `this.telegram`.
 */
import type { Cipher, GatewaysConfig } from "@jarod/contracts";
import { bootApp, cleanup, discoverPlugins, shutdown, tempDir } from "@jarod/kernel/testing";
import type {} from "@jarod/plugin-agent";
import { memoryKeyStore, type KeyStore } from "@jarod/plugin-storage";
import { afterEach } from "vitest";
import type { GatewayHub } from "../src/index.js";

export { tempDir };

/** Shared in-memory key store: fast, and keys survive re-opening a core on the same folder. */
export const testKeys = memoryKeyStore();

export interface CoreOptions extends Omit<GatewaysConfig, "autoStart"> {
  dataDir?: string;
  keyStores?: KeyStore[];
  cipher?: Cipher;
  /** V-07 : un autre verdict pour l'analyseur de la quarantaine (`bootApp` le règle sur « propre » par défaut). */
  scan?: "clean" | "infected" | "unavailable";
}

/** Les champs `JarodCore.telegram`… (core.ts:270-274) : écrits, ils vont au hub. */
const LIVE = new Set<string | symbol>(["telegram", "discord", "slack", "email", "whatsapp"]);

export async function makeCore(opts: CoreOptions = {}) {
  const { dataDir, keyStores, cipher, scan, ...gateways } = opts;
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: dataDir ?? tempDir(), keyStores: keyStores ?? [testKeys], ...(cipher ? { cipher } : {}) };
  // Comme `new JarodCore()` sans `init()` : ni tick planifié, ni passerelle démarrée d'office.
  plugins.scheduler = { autoStart: false };
  plugins.gateways = { autoStart: false, ...gateways };
  if (scan) plugins.quarantine = { scanner: { scan: () => ({ verdict: scan, scanner: "test" }) } };
  const app = await bootApp(plugins);
  const hub = app.gateways;
  const base = Object.assign(app.agent, { app, dispose: () => shutdown(app) });
  return new Proxy(base, {
    get(target, p) {
      if (p in hub) {
        const v = Reflect.get(hub, p, hub);
        return typeof v === "function" ? v.bind(hub) : v;
      }
      return Reflect.get(target, p);
    },
    set(target, p, v) {
      return LIVE.has(p) ? Reflect.set(hub, p, v, hub) : Reflect.set(target, p, v);
    },
  }) as typeof base & Omit<GatewayHub, keyof typeof base>;
}

export type TestCore = Awaited<ReturnType<typeof makeCore>>;

afterEach(cleanup);
