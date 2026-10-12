import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JarodApp } from "../src/app.js";
import { start, stop } from "../src/lifecycle.js";
import { discoverPlugins } from "../src/registry.js";
import { cleanup, tempDir } from "../src/testing.js";

afterEach(cleanup);

/** Un dossier de plugins jetable : un package = un plugin déclaré par `"jarod"`. */
function pluginsDir(plugins: Record<string, { order: number; code: string }>): string {
  const dir = tempDir();
  for (const [name, p] of Object.entries(plugins)) {
    mkdirSync(join(dir, name));
    writeFileSync(
      join(dir, name, "package.json"),
      JSON.stringify({ name: `@test/${name}`, exports: { ".": "./index.mjs" }, jarod: { plugin: name, order: p.order } }),
    );
    writeFileSync(join(dir, name, "index.mjs"), p.code);
  }
  return dir;
}

describe("registry", () => {
  it("découvre les plugins locaux du dépôt, dans l'ordre déclaré", () => {
    const names = discoverPlugins().map((p) => p.name);
    expect(names.slice(0, 2)).toEqual(["storage", "scheduler"]);
  });

  it("ignore un package sans déclaration jarod", () => {
    const dir = pluginsDir({ a: { order: 1, code: "export function apply() {}" } });
    mkdirSync(join(dir, "autre"));
    writeFileSync(join(dir, "autre", "package.json"), JSON.stringify({ name: "autre" }));
    expect(discoverPlugins(dir).map((p) => p.name)).toEqual(["a"]);
  });
});

describe("lifecycle", () => {
  it("démarre les plugins activés, injecte les dépendances, libère à l'arrêt dans l'ordre inverse", async () => {
    const log: string[] = [];
    (globalThis as { __log?: string[] }).__log = log;
    const dir = pluginsDir({
      base: {
        order: 1,
        code: `export const name = "base";
export function apply(ctx) { ctx.provide("base", { v: 42 }); ctx.effect(() => () => globalThis.__log.push("base down")); }`,
      },
      user: {
        order: 2,
        code: `export const name = "user"; export const inject = ["base"];
export function apply(ctx) { globalThis.__log.push("user sees " + ctx.base.v); ctx.effect(() => () => globalThis.__log.push("user down")); }`,
      },
      off: { order: 3, code: `export function apply() { globalThis.__log.push("off chargé"); }` },
    });
    const app = new JarodApp({ pluginsDir: dir, plugins: { base: {}, user: {}, off: false } });
    const started = await start(app);
    expect(started.loaded.map((p) => p.name)).toEqual(["base", "user"]);
    await stop(started);
    expect(log).toEqual(["user sees 42", "user down", "base down"]);
  });

  it("échoue fort, avec l'erreur d'origine, si un plugin ne démarre pas", async () => {
    const dir = pluginsDir({ boom: { order: 1, code: `export function apply() { throw new Error("panne volontaire"); }` } });
    await expect(start(new JarodApp({ pluginsDir: dir, plugins: { boom: {} } }))).rejects.toThrow(/panne volontaire/);
  });

  it("dépendance optionnelle : attendue seulement si un plugin activé la fournit", async () => {
    const log: string[] = [];
    (globalThis as { __log?: string[] }).__log = log;
    const dir = pluginsDir({
      base: { order: 1, code: `export function apply(ctx) { ctx.provide("base", 1); }` },
      opt: { order: 2, code: `export function apply(ctx) { ctx.provide("opt", "présent"); }` },
      user: {
        order: 3,
        code: `export const inject = { base: { required: true }, opt: { required: false } };
export function apply(ctx) { globalThis.__log.push("opt=" + (ctx.get("opt") ?? "absent")); }`,
      },
    });
    const off = await start(new JarodApp({ pluginsDir: dir, plugins: { base: {}, opt: false, user: {} } }));
    expect(off.loaded.map((p) => p.name)).toEqual(["base", "user"]);
    await stop(off);
    const on = await start(new JarodApp({ pluginsDir: dir, plugins: { base: {}, opt: {}, user: {} } }));
    await stop(on);
    expect(log).toEqual(["opt=absent", "opt=présent"]);
    // Le requis reste requis.
    await expect(start(new JarodApp({ pluginsDir: dir, plugins: { opt: {}, user: {} } }))).rejects.toThrow(/en attente de dépendances/);
  });

  // Plugins réels du dépôt : plugin-agent déclare vision/mcp `required:false`.
  for (const off of ["vision", "mcp"]) {
    it(`boot réel avec ${off} désactivé → agent démarre`, async () => {
      const plugins: Record<string, Record<string, unknown> | false> = {};
      for (const p of discoverPlugins()) plugins[p.name] = {};
      Object.assign(plugins, {
        storage: { dataDir: tempDir(), encryptDb: false },
        scheduler: { autoStart: false },
        skills: { seed: false },
        mcp: { autoSync: false },
        gateways: { autoStart: false },
        agent: { runtimeLock: false, curatorTimer: false },
        [off]: false,
      });
      const app = new JarodApp({ plugins });
      const started = await start(app);
      try {
        expect(started.loaded.map((p) => p.name)).toContain("agent");
        expect(started.loaded.map((p) => p.name)).not.toContain(off);
        const ctx = app as unknown as { get(name: string): unknown };
        expect(ctx.get("agent")).toBeTruthy();
        expect(ctx.get(off)).toBeUndefined();
      } finally {
        await stop(started);
      }
    }, 60_000);
  }

  it("échoue si une dépendance injectée manque (jamais d'attente silencieuse)", async () => {
    const dir = pluginsDir({ user: { order: 1, code: `export const inject = ["absent"]; export function apply() {}` } });
    await expect(start(new JarodApp({ pluginsDir: dir, plugins: { user: {} } }))).rejects.toThrow(/en attente de dépendances/);
  });

  it("respecte plugins: { name: false } — plugin désactivé non chargé, son channel IPC injoignable", async () => {
    const dir = pluginsDir({
      a: { order: 1, code: `export const name = "a"; export function apply(ctx) { ctx.provide("a", { hello: "world" }); }` },
      b: { order: 2, code: `export const name = "b"; export function apply(ctx) { ctx.provide("b", "ok"); }` },
    });
    // a désactivé, b activé (sans dépendance sur a)
    const app = new JarodApp({ pluginsDir: dir, plugins: { a: false, b: {} } });
    const started = await start(app);
    expect(started.loaded.map((p) => p.name)).toEqual(["b"]);
    const ctx = app as unknown as { get(name: string): unknown };
    expect(ctx.get("a")).toBeUndefined(); // a non chargé
    expect(ctx.get("b")).toBeTruthy(); // b chargé
    await stop(started);
  });
});
