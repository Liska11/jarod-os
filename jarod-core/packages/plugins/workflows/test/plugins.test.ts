/**
 * Portage de `packages/core/test/plugins.test.ts` (71 l.) et `example-plugin.test.ts` (45 l.) (rév. 2e180305)
 * sur le kernel : `core.plugins` → `app.pluginHost`, `core.router` → `app.llm.router`, `core.webhooks` →
 * `WebhookService` construit comme `plugins/scheduler/test/webhook-routes.test.ts`. Seul changement du
 * plugin de test : il DÉCLARE ce qu'il utilise (`permissions: ["routes", "pages"]`), sinon l'hôte isolé
 * (fail-closed) le refuse. Mêmes assertions ; le plugin tourne ici dans son propre processus.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootApp, cleanup, discoverPlugins, tempDir } from "@jarod/kernel/testing";
import type { LlmService } from "@jarod/plugin-llm";
import { WebhookService } from "@jarod/plugin-scheduler";
import { type Db, memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { EXAMPLE_PLUGIN, type PluginHost } from "../src/index.js";

afterEach(cleanup);

/** Le premier plugin du dépôt : un vrai module, chargé pour de vrai, avec une vraie route. */
function installPlugin(dataDir: string, id: string) {
  const root = join(dataDir, "plugins", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({ id, name: `Plugin ${id}`, version: "1.0.0", main: "index.js", permissions: ["routes", "pages"] }),
  );
  writeFileSync(
    join(root, "index.js"),
    `exports.activate = (api) => {
  api.registerRoute("GET", "/salut/:nom", ({ params }) => ({ body: { nom: params.nom, plugin: api.id } }));
  api.registerPage({ id: "salut", title: "Salut", render: () => "<h1>bonjour</h1>" });
};
`,
  );
  return root;
}

export async function newCore() {
  const dataDir = tempDir();
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir, keyStores: [memoryKeyStore()] };
  plugins.scheduler = { autoStart: false };
  plugins.gateways = { autoStart: false };
  plugins.mcp = { autoSync: false };
  plugins.agent = { runtimeLock: false, curatorTimer: false };
  plugins.workflows = { seed: false, load: false };
  const app = (await bootApp(plugins)) as unknown as { pluginHost: PluginHost; llm: LlmService; storage: { db: Db } };
  const webhooks = new WebhookService({ db: app.storage.db, port: 0, router: app.llm.router, onHook: () => {} });
  const core = { plugins: app.pluginHost, router: app.llm.router, webhooks, dispose: async () => app.pluginHost.unloadAll() };
  return { core, dataDir, app };
}

describe("un plugin expose une route, et la perd en se désactivant", () => {
  it("sert la route du plugin en HTTP réel, et publie sa page", async () => {
    const { core, dataDir } = await newCore();
    installPlugin(dataDir, "salut");
    core.plugins.attachRouter(core.router);
    await core.plugins.reload();

    // La route est bien celle du plugin, et le plugin sait de qui elle vient.
    expect(core.router.list()).toEqual([{ owner: "salut", method: "GET", path: "/salut/:nom" }]);
    expect(core.plugins.pageList().map((page) => `${page.pluginId}:${page.id}`)).toEqual(["salut:salut"]);

    await core.webhooks.start(0);
    const answer = await fetch(`http://127.0.0.1:${core.webhooks.status().port}/salut/demba`);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ nom: "demba", plugin: "salut" });

    await core.webhooks.stop();
    await core.dispose();
  });

  it("désactivé, le plugin ne répond plus et sa page disparaît", async () => {
    const { core, dataDir } = await newCore();
    installPlugin(dataDir, "salut");
    core.plugins.attachRouter(core.router);
    await core.plugins.reload();
    await core.webhooks.start(0);
    const port = core.webhooks.status().port;
    expect((await fetch(`http://127.0.0.1:${port}/salut/demba`)).status).toBe(200);

    await core.plugins.setEnabled("salut", false);

    expect(core.router.list()).toEqual([]);
    expect(core.plugins.pageList()).toEqual([]);
    const after = await fetch(`http://127.0.0.1:${port}/salut/demba`);
    expect(after.status).toBe(404);

    await core.webhooks.stop();
    await core.dispose();
  });
});

/** Installe le modèle livré aux auteurs tel quel. S'il ne se charge pas, le modèle ment. */
function installExample(dataDir: string) {
  const root = join(dataDir, "plugins", EXAMPLE_PLUGIN.manifest.id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "plugin.json"), JSON.stringify(EXAMPLE_PLUGIN.manifest));
  writeFileSync(join(root, "index.js"), EXAMPLE_PLUGIN.code);
}

describe("le modèle de plugin livré", () => {
  it("se charge tel quel et exerce les quatre surfaces : commande, outil, route, page", async () => {
    const { core, dataDir } = await newCore();
    installExample(dataDir);
    core.plugins.attachRouter(core.router);
    const infos = await core.plugins.reload();

    const info = infos.find((plugin) => plugin.id === EXAMPLE_PLUGIN.manifest.id);
    expect(info?.state).toBe("active");
    expect(info?.error).toBeUndefined();
    // L'inventaire dit ce que le plugin tient VRAIMENT, pas ce que son manifeste espérait.
    expect(info?.tools).toEqual(["des_roll_dice"]);
    expect(info?.commands).toEqual(["roll"]);
    expect(info?.routes).toEqual(["GET /des/:spec"]);
    expect(info?.pages).toEqual(["des"]);

    // Et la route répond en HTTP réel, avec le résultat du lancer.
    await core.webhooks.start(0);
    const answer = await fetch(`http://127.0.0.1:${core.webhooks.status().port}/des/2d6`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { rolls: number[]; total: number };
    expect(body.rolls).toHaveLength(2);
    expect(body.total).toBe(body.rolls[0]! + body.rolls[1]!);

    await core.webhooks.stop();
    await core.dispose();
  });
});
