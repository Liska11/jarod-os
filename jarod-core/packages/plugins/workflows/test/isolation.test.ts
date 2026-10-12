/**
 * U2 (gap G6) — isolation réelle des plugins utilisateur : un vrai processus par plugin, sous le modèle de
 * permissions de Node, permissions déclarées fail-closed, garde réseau, environnement vidé, panne et
 * délai dits, arrêt qui tue le processus. Chaque test lance de vrais processus.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { newCore } from "./plugins.test.js";
import { PluginHost, type PluginInfo, permissionArgs, validateManifest } from "../src/index.js";

afterEach(cleanup);

function install(dataDir: string, id: string, code: string, permissions?: string[]) {
  const root = join(dataDir, "plugins", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({ id, name: `P ${id}`, version: "1.0.0", main: "index.js", ...(permissions ? { permissions } : {}) }),
  );
  writeFileSync(join(root, "index.js"), code);
  return root;
}

/** Un outil `probe` qui exécute `body` (corps async) dans le processus du plugin et rend son résultat. */
const probe = (body: string) => `exports.activate = (api) => {
  api.registerTool({ name: "probe", description: "sonde", run: async (args) => {
    try { return JSON.stringify({ ok: true, value: await (async () => { ${body} })() }); }
    catch (e) { return JSON.stringify({ ok: false, code: e && e.code, error: String(e && e.message) }); }
  } });
};`;

async function runProbe(body: string, permissions: string[] = ["tools"], opts: { args?: Record<string, unknown> } = {}) {
  const { core, dataDir, app } = await newCore();
  install(dataDir, "sonde", probe(body), permissions);
  const [info] = await core.plugins.reload();
  expect(info?.state, info?.error).toBe("active");
  const tool = (app as unknown as { agent: { tools: { get(n: string): { run(a: unknown, c: unknown): Promise<string> } } } }).agent.tools.get("sonde_probe");
  const out = JSON.parse(await tool.run(opts.args ?? {}, { sessionId: "s", workspace: null })) as { ok: boolean; value?: unknown; code?: string; error?: string };
  return { out, info: info!, core, dataDir, app };
}

describe("U2 : un processus par plugin, sous le modèle de permissions de Node", () => {
  it("le plugin tourne ailleurs que le cœur, avec --permission actif", async () => {
    const { out, info, core } = await runProbe(`return { pid: process.pid, permission: Boolean(process.permission), fsRead: process.permission.has("fs.read", __filename) };`);
    expect(out.ok).toBe(true);
    const v = out.value as { pid: number; permission: boolean };
    expect(v.pid).not.toBe(process.pid);
    expect(v.pid).toBe(info.pid);
    expect(v.permission).toBe(true);
    await core.dispose();
  });

  it("disque : lit son dossier, écrit dans data/ ; rien hors de là (ni la base du profil, ni son propre code)", async () => {
    const { core, dataDir, app } = await newCore();
    const secret = join(dataDir, "secret.txt");
    writeFileSync(secret, "confidentiel");
    install(
      dataDir,
      "disque",
      `const fs = require("node:fs"); const path = require("node:path");
exports.activate = (api) => {
  api.registerTool({ name: "t", description: "t", run: async (args) => {
    const r = {};
    const tryIt = (k, f) => { try { r[k] = f(); } catch (e) { r[k] = e.code; } };
    tryIt("ownCode", () => fs.readFileSync(path.join(__dirname, "index.js"), "utf8").length > 0);
    tryIt("writeData", () => { fs.writeFileSync(path.join(api.dataDir, "note.txt"), "ok"); return fs.readFileSync(path.join(api.dataDir, "note.txt"), "utf8"); });
    tryIt("writeOwnCode", () => fs.writeFileSync(path.join(__dirname, "index.js"), "pirate"));
    tryIt("readSecret", () => fs.readFileSync(args.secret, "utf8"));
    tryIt("readDb", () => fs.readdirSync(path.dirname(args.secret)));
    tryIt("readWindows", () => fs.readdirSync(process.env.SystemRoot || "C:/Windows"));
    return JSON.stringify(r);
  } });
};`,
      ["tools"],
    );
    await core.plugins.reload();
    const tool = (app as never as { agent: { tools: { get(n: string): { run(a: unknown, c: unknown): Promise<string> } } } }).agent.tools.get("disque_t");
    const r = JSON.parse(await tool.run({ secret }, { sessionId: "s", workspace: null }));
    expect(r).toEqual({
      ownCode: true,
      writeData: "ok",
      writeOwnCode: "ERR_ACCESS_DENIED",
      readSecret: "ERR_ACCESS_DENIED",
      readDb: "ERR_ACCESS_DENIED",
      readWindows: "ERR_ACCESS_DENIED",
    });
    await core.dispose();
  });

  it("ni processus enfant, ni worker", async () => {
    const child = await runProbe(`return require("node:child_process").execSync("whoami").toString();`);
    expect(child.out).toMatchObject({ ok: false, code: "ERR_ACCESS_DENIED" });
    await child.core.dispose();
    const worker = await runProbe(`const { Worker } = require("node:worker_threads"); new Worker("1", { eval: true }); return "lancé";`);
    expect(worker.out).toMatchObject({ ok: false, code: "ERR_ACCESS_DENIED" });
    await worker.core.dispose();
  });

  it("environnement vidé : aucun secret du cœur ne passe", async () => {
    process.env.JAROD_TELEGRAM_TOKEN = "123:secret-de-test";
    try {
      const { out, core } = await runProbe(`return Object.keys(process.env).sort();`);
      expect(out.ok).toBe(true);
      expect(out.value).not.toContain("JAROD_TELEGRAM_TOKEN");
      // Rien que SystemRoot/windir passés par l'hôte + les variables que libuv exige sous Windows (make_program_env).
      const allowed = ["SystemRoot", "windir", "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE"];
      expect((out.value as string[]).filter((k) => !allowed.includes(k))).toEqual([]);
      await core.dispose();
    } finally {
      delete process.env.JAROD_TELEGRAM_TOKEN;
    }
  });
});

describe("U2 : réseau seulement si déclaré", () => {
  const withServer = async (fn: (url: string) => Promise<void>) => {
    const server = createServer((_q, s) => s.end("pong"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    try {
      await fn(url);
    } finally {
      server.close();
    }
  };

  it("sans « network » : fetch, http, net, dgram, dns, écoute refusés — et le garde ne se retire pas", async () => {
    await withServer(async (url) => {
      const body = `const r = {}; const u = args.url;
        const t = async (k, f) => { try { r[k] = await f(); } catch (e) { r[k] = (e && (e.cause && e.cause.code)) || (e && e.code) || String(e); } };
        await t("fetch", async () => (await fetch(u)).status);
        await t("http", () => new Promise((ok, ko) => { try { require("node:http").get(u, (res) => ok(res.statusCode)).on("error", ko); } catch (e) { ko(e); } }));
        await t("net", () => require("node:net").connect(Number(new URL(u).port), "127.0.0.1") && "connecté");
        await t("dgram", () => require("node:dgram").createSocket("udp4").bind(0) && "lié");
        await t("dns", () => new Promise((ok, ko) => { try { require("node:dns").lookup("localhost", (e, a) => e ? ko(e) : ok(a)); } catch (e) { ko(e); } }));
        await t("listen", () => require("node:net").createServer().listen(0) && "écoute");
        await t("unlock", () => { Object.defineProperty(require("node:net").Socket.prototype, "connect", { value: () => "libre" }); return "retiré"; });
        await t("binding", () => process.binding("tcp_wrap") && "binding");
        return r;`;
      const { out, core } = await runProbe(body, ["tools"], { args: { url } });
      expect(out.ok).toBe(true);
      const r = out.value as Record<string, unknown>;
      for (const k of ["fetch", "http", "net", "dgram", "dns", "listen"]) expect(r[k], k).toBe("ERR_ACCESS_DENIED");
      expect(r.unlock).toMatch(/Cannot redefine property: connect/);
      expect(r.binding).toBe("ERR_ACCESS_DENIED");
      await core.dispose();
    });
  });

  it("avec « network » : le même fetch passe", async () => {
    await withServer(async (url) => {
      const { out, core } = await runProbe(`return await (await fetch(args.url)).text();`, ["tools", "network"], { args: { url } });
      expect(out).toEqual({ ok: true, value: "pong" });
      await core.dispose();
    });
  });
});

describe("U2 : permissions déclarées, fail-closed", () => {
  it("surface non déclarée → activation refusée, rien d'exposé, notification", async () => {
    const { core, dataDir, app } = await newCore();
    install(dataDir, "sans-route", `exports.activate = (api) => { api.registerTool({ name: "a", description: "a", run: () => "a" }); api.registerRoute("GET", "/x", () => ({ body: 1 })); };`, ["tools"]);
    install(dataDir, "muet", `exports.activate = (api) => { api.registerCommand({ name: "coucou", description: "c", run: () => "c" }); };`);
    const infos = await core.plugins.reload();
    const byId = Object.fromEntries(infos.map((i) => [i.id, i])) as Record<string, PluginInfo>;
    expect(byId["sans-route"]).toMatchObject({ state: "error", tools: [], routes: [], pid: null });
    expect(byId["sans-route"]!.error).toMatch(/PERMISSION_DENIED: permission « routes » non déclarée/);
    expect(byId.muet).toMatchObject({ state: "error", permissions: [] });
    expect(byId.muet!.error).toMatch(/« commands » non déclarée/);
    const a = app as unknown as { agent: { tools: { get(n: string): unknown }; commands: { has(n: string): boolean } }; storage: { notifications: { list(): { title: string }[] } } };
    expect(a.agent.tools.get("sans_route_a")).toBeUndefined();
    expect(a.agent.commands.has("coucou")).toBe(false);
    expect(a.storage.notifications.list().map((n) => n.title).sort()).toEqual(["Plugin P muet en erreur", "Plugin P sans-route en erreur"]);
    await core.dispose();
  });

  it("permission inconnue → manifeste invalide", () => {
    expect(() => validateManifest({ id: "x", name: "x", version: "1.0.0", main: "i.js", permissions: ["tools", "root"] })).toThrow(/permission inconnue : root/);
    expect(() => validateManifest({ id: "x", name: "x", version: "1.0.0", main: "i.js", permissions: "tools" })).toThrow(/liste/);
  });

  it("hooks : beforeSend transforme le texte, afterResponse reçoit la réponse (dans le processus du plugin)", async () => {
    const { core, dataDir, app } = await newCore();
    install(
      dataDir,
      "hooks",
      `exports.activate = (api) => {
  api.onBeforeSend((t) => t.toUpperCase());
  api.onAfterResponse((text, sid) => api.notify("vu", sid + ":" + text));
};`,
      ["hooks", "notify"],
    );
    await core.plugins.reload();
    const a = app as unknown as { agent: { plugins: PluginHost }; storage: { notifications: { list(): { title: string; body: string }[] } } };
    expect(a.agent.plugins).toBe(core.plugins); // le runtime d'agent passe par l'hôte isolé
    expect(await core.plugins.beforeSend("bonjour")).toBe("BONJOUR");
    core.plugins.afterResponse("réponse", "s1");
    await new Promise((r) => setTimeout(r, 300));
    expect(a.storage.notifications.list()).toMatchObject([{ title: "vu", body: "s1:réponse" }]);
    await core.dispose();
  });
});

describe("U2 : pannes", () => {
  it("le processus meurt pendant un appel : appel rejeté, plugin en erreur, contributions retirées", async () => {
    const { core, dataDir, app } = await newCore();
    install(dataDir, "fragile", `exports.activate = (api) => { api.registerTool({ name: "boum", description: "b", run: () => process.exit(3) }); };`, ["tools"]);
    await core.plugins.reload();
    const a = app as unknown as { agent: { tools: { get(n: string): { run(a: unknown, c: unknown): Promise<string> } | undefined } } };
    await expect(a.agent.tools.get("fragile_boum")!.run({}, { sessionId: "s", workspace: null })).rejects.toThrow(/arrêté \(code 3\)/);
    expect(core.plugins.list()[0]).toMatchObject({ state: "error", error: "Le processus du plugin s'est arrêté (code 3)", pid: null });
    expect(a.agent.tools.get("fragile_boum")).toBeUndefined();
    await core.dispose();
  });

  it("un appel sans réponse expire (PLUGIN_TIMEOUT), le cœur n'attend pas indéfiniment", async () => {
    const dataDir = tempDir();
    const { core, app } = await newCore();
    const a = app as unknown as { agent: { tools: never; commands: never }; storage: { settings: never; notifications: never } };
    const host = new PluginHost(join(dataDir, "plugins"), a.agent.tools, a.agent.commands, a.storage.settings, a.storage.notifications, { callTimeoutMs: 300 });
    install(dataDir, "lent", `exports.activate = (api) => { api.registerCommand({ name: "attends", description: "a", run: () => new Promise(() => {}) }); };`, ["commands"]);
    await host.reload();
    const cmds = (app as unknown as { agent: { commands: { execute(i: string, c: unknown): Promise<{ text: string } | null> } } }).agent.commands;
    // Le registre dit l'erreur de la commande (commands.ts:54-64) : ici, le délai de l'appel isolé.
    expect(await cmds.execute("/attends", { sessionId: null })).toEqual({ text: "Erreur /attends : PLUGIN_TIMEOUT: lent n'a pas répondu en 300 ms (command attends)" });
    await host.unloadAll();
    await core.dispose();
  });

  it("unloadAll arrête vraiment les processus", async () => {
    const { core, dataDir } = await newCore();
    install(dataDir, "a", `exports.activate = () => {};`, []);
    install(dataDir, "b", `exports.activate = () => {};`, []);
    const pids = (await core.plugins.reload()).map((i) => i.pid!);
    expect(pids).toHaveLength(2);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(pids.every(alive)).toBe(true);
    await core.plugins.unloadAll();
    await new Promise((r) => setTimeout(r, 200));
    expect(pids.some(alive)).toBe(false);
  });
});

describe("U2 : drapeaux de permission selon le Node qui lance le plugin", () => {
  const args = (permissions: string[], hasAllowNet: boolean) => permissionArgs("/r/runner.cjs", "/r/p", "/r/p/data", permissions, hasAllowNet);

  it("`--allow-net` seulement si `network` est déclaré ET que ce Node le connaît (sinon le processus mourrait, code 9)", () => {
    expect(args(["tools", "network"], true)).toContain("--allow-net");
    expect(args(["tools", "network"], false)).not.toContain("--allow-net");
    expect(args(["tools"], true)).not.toContain("--allow-net");
  });

  it("le noyau des drapeaux est inchangé, avec ou sans `--allow-net`", () => {
    const base = ["--permission", "--allow-fs-read=/r/runner.cjs", "--allow-fs-read=/r/p", "--allow-fs-write=/r/p/data"];
    expect(args([], false)).toEqual(base);
    expect(args(["network"], true)).toEqual([...base, "--allow-net"]);
  });

  it("par défaut, la détection suit le Node courant : tout drapeau émis est connu de lui", () => {
    const emitted = permissionArgs("/r/runner.cjs", "/r/p", "/r/p/data", ["network"]).map((a) => a.split("=")[0]!);
    for (const flag of emitted) expect(process.allowedNodeEnvironmentFlags.has(flag), flag).toBe(true);
  });
});
