/**
 * W9 — câblage du pont téléphone dans plugin-gateways (core.ts:504-515,529) : outils android
 * enregistrés, pont rallumé au démarrage s'il était activé, port libéré à l'arrêt du kernel sans
 * éteindre le réglage (il revient au démarrage suivant). Jarod-cordis (pas de test source).
 */
import { bootApp, discoverPlugins, shutdown, tempDir } from "@jarod/kernel/testing";
import { describe, expect, it } from "vitest";
import { testKeys } from "./helpers.js";

async function boot(dataDir: string, autoStart: boolean) {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir, keyStores: [testKeys] };
  plugins.scheduler = { autoStart: false };
  plugins.agent = { runtimeLock: false, curatorTimer: false };
  plugins.gateways = { autoStart };
  return bootApp(plugins);
}

describe("plugin-gateways — pont téléphone et android", () => {
  it("enregistre les outils android, et les retire à l'arrêt", async () => {
    const app = await boot(tempDir(), false);
    const tools = app.agent.tools;
    expect(tools.get("android_devices")).toBeTruthy();
    expect(tools.get("android_shell")?.dangerous).toBe(true);
    expect(app.gateways.mobile.status().running).toBe(false);
    await shutdown(app);
    expect(tools.get("android_shell")).toBeUndefined();
  });

  it("un pont activé revient avec l'app ; l'arrêt du kernel ferme le port sans l'éteindre", async () => {
    const dataDir = tempDir();
    const first = await boot(dataDir, false);
    const settings = first.agent.settings;
    settings.set("mobile", { ...settings.get("mobile"), enabled: true, port: 0 });
    await shutdown(first);

    const second = await boot(dataDir, true);
    const bridge = second.gateways.mobile;
    await expect.poll(() => bridge.status().running).toBe(true);
    const base = `http://127.0.0.1:${bridge.status().port}`;
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    await shutdown(second);

    await expect(fetch(`${base}/api/status`)).rejects.toThrow();
    const third = await boot(dataDir, false);
    expect(third.agent.settings.get("mobile").enabled).toBe(true);
    await shutdown(third);
  });
});
