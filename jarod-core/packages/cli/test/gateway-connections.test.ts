// Passerelle compatible Hermes (essai) : pages « Connexions » et « Réseau » de Herald — serveurs MCP et plateformes de messagerie. Logique pure, puis le VRAI
// noyau avec un vrai petit serveur MCP de test (celui du paquet plugin-mcp).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/gateway/config.js";
import { MASK, type McpConfigLike, mcpServers, messagingPlatforms, probeResult, refusePlatformToggle, removeMcp, setMcpEnabled } from "../src/gateway/connections.js";
import { openCore } from "../src/context.js";
import { createGateway } from "../src/gateway/server.js";

const FAKE_MCP = fileURLToPath(new URL("../../plugins/mcp/test/fixtures/fake-mcp.mjs", import.meta.url));

const stdio: McpConfigLike = { id: "m1", name: "fake", command: "node", args: ["serveur.js", "--x"], env: { API_KEY: "sk-secret-123", MODE: "prod" }, enabled: true };
const remote: McpConfigLike = { id: "m2", name: "distant", command: "", args: [], env: {}, enabled: false, url: "https://mcp.exemple.fr", headers: { Authorization: "Bearer abc" } };

describe("serveurs MCP (pur)", () => {
  it("transport, authentification, état ; les VALEURS d'environnement et les en-têtes ne sortent pas", () => {
    const out = mcpServers([stdio, remote], [{ id: "m1", state: "running", tools: ["a", "b"] }, { id: "m2", state: "error", error: "refusé", tools: [] }]);
    expect(out.servers).toEqual([
      { name: "fake", transport: "stdio", url: null, command: "node", args: ["serveur.js", "--x"], env: { API_KEY: MASK, MODE: MASK }, auth: "none", enabled: true, tools: null, state: "running", running_tools: 2 },
      { name: "distant", transport: "http", url: "https://mcp.exemple.fr", command: null, args: [], env: {}, auth: "header", enabled: false, tools: null, state: "error", error: "refusé", running_tools: 0 },
    ]);
    const text = JSON.stringify(out);
    expect(text).not.toContain("sk-secret-123");
    expect(text).not.toContain("Bearer abc");
    expect(mcpServers([{ ...stdio, command: "" }], []).servers[0]).toMatchObject({ transport: "unknown", state: "stopped" });
  });

  it("activer, couper, retirer ; un serveur inconnu ou un booléen invalide est une erreur nette", () => {
    const { next, changed } = setMcpEnabled([stdio, remote], "distant", true);
    expect(changed).toMatchObject({ id: "m2", enabled: true });
    expect(next.map((c) => [c.name, c.enabled])).toEqual([["fake", true], ["distant", true]]);
    expect(removeMcp([stdio, remote], "fake").map((c) => c.name)).toEqual(["distant"]);
    expect(() => setMcpEnabled([stdio], "x", true)).toThrow(/inconnu/);
    expect(() => setMcpEnabled([stdio], "fake", "oui")).toThrow(ConfigError);
    expect(() => removeMcp([stdio], "x")).toThrow(/inconnu/);
  });

  it("probeResult : succès, et échec rendu comme ok:false avec le message", () => {
    expect(probeResult([{ name: "echo", description: "Répète" }, { name: "boom" }])).toEqual({ ok: true, tools: [{ name: "echo", description: "Répète" }, { name: "boom" }] });
    expect(probeResult(new Error("connexion refusée"))).toEqual({ ok: false, error: "connexion refusée", tools: [] });
  });
});

describe("plateformes de messagerie (pur)", () => {
  it("cinq plateformes ; désactivée, arrêtée, en marche, en erreur", () => {
    const enabled = new Set(["telegram", "discord", "slack"]);
    const states: Record<string, { state: "stopped" | "running" | "error"; error?: string }> = { telegram: { state: "running" }, discord: { state: "error", error: "jeton refusé" }, slack: { state: "stopped" } };
    const { platforms } = messagingPlatforms((id) => ({ enabled: enabled.has(id) }), (id) => states[id] ?? { state: "stopped" });
    expect(platforms.map((p) => [p.id, p.state, p.gateway_running])).toEqual([["telegram", null, true], ["discord", "startup_failed", false], ["slack", "gateway_stopped", false], ["email", "disabled", false], ["whatsapp", "disabled", false]]);
    expect(platforms[1]).toMatchObject({ error_message: "jeton refusé", enabled: true, name: "Discord" });
  });

  it("l'activation est refusée avec le chemin à suivre", () => {
    expect(() => refusePlatformToggle("telegram")).toThrow(/écran « Passerelles » de Jarod/);
  });
});

const dirs: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig() {
  const root = mkdtempSync(join(tmpdir(), "jarod-gw-mcp-"));
  dirs.push(root);
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core } = await openCore({ env: { JAROD_HOME: root } });
  const gw = createGateway({ core, version: "test" });
  const port = await gw.listen(0);
  closers.push(async () => {
    await gw.close();
    await core.dispose();
  });
  const http = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "x-hermes-session-token": gw.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, text: await r.text() };
  };
  const json = async (method: string, path: string, body?: unknown) => {
    const r = await http(method, path, body);
    return { status: r.status, body: JSON.parse(r.text) as any, text: r.text };
  };
  return { core, gw, http, json };
}

describe("devant le vrai noyau", { timeout: 90_000 }, () => {
  it("MCP : liste sans secret, essai de connexion réel, activation (les outils arrivent au registre), coupure, suppression", async () => {
    const { core, json } = await rig();
    core.settings.patch({
      mcpServers: [
        { id: "m1", name: "fake", command: process.execPath, args: [FAKE_MCP], env: { API_KEY: "sk-secret-123" }, enabled: false },
        { id: "m2", name: "distant", command: "", args: [], env: {}, enabled: false, url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer abc" } },
      ],
    });

    const list = await json("GET", "/api/mcp/servers");
    expect(list.body.servers.map((s: any) => [s.name, s.transport, s.enabled, s.state])).toEqual([["fake", "stdio", false, "stopped"], ["distant", "http", false, "stopped"]]);
    expect(list.text).not.toContain("sk-secret-123");
    expect(list.text).not.toContain("Bearer abc");

    // Essai de connexion RÉEL : le serveur de test répond avec ses outils ; un serveur injoignable donne ok:false.
    const good = await json("POST", "/api/mcp/servers/fake/test");
    expect(good.body).toMatchObject({ ok: true, tools: [{ name: "echo" }, { name: "boom" }] });
    const bad = await json("POST", "/api/mcp/servers/distant/test");
    expect(bad.body).toMatchObject({ ok: false, tools: [] });
    expect(bad.body.error).toBeTruthy();
    expect(core.tools.get("mcp_fake_echo")).toBeUndefined(); // un essai n'enregistre rien

    // Activer : le réglage change, le serveur démarre, ses outils rejoignent le registre (toujours à accord : `dangerous`).
    expect((await json("PUT", "/api/mcp/servers/fake/enabled", { enabled: true })).body).toEqual({ ok: true });
    expect((core.settings.get("mcpServers") as McpConfigLike[]).find((c) => c.name === "fake")?.enabled).toBe(true);
    const until = async (cond: () => boolean) => {
      const end = Date.now() + 15_000;
      while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      return cond();
    };
    expect(await until(() => core.tools.get("mcp_fake_echo") !== undefined)).toBe(true);
    expect(core.tools.get("mcp_fake_echo")?.dangerous).toBe(true);
    const running = (await json("GET", "/api/mcp/servers")).body.servers.find((s: any) => s.name === "fake");
    expect(running).toMatchObject({ state: "running", enabled: true, running_tools: 2 });

    // Couper : le serveur s'arrête et ses outils quittent le registre.
    await json("PUT", "/api/mcp/servers/fake/enabled", { enabled: false });
    expect(await until(() => core.tools.get("mcp_fake_echo") === undefined)).toBe(true);

    // Supprimer.
    expect((await json("DELETE", "/api/mcp/servers/distant")).body).toEqual({ ok: true });
    expect((core.settings.get("mcpServers") as McpConfigLike[]).map((c) => c.name)).toEqual(["fake"]);
    expect((await json("DELETE", "/api/mcp/servers/distant")).status).toBe(400);
    expect((await json("PUT", "/api/mcp/servers/fake/enabled", { enabled: "oui" })).status).toBe(400);
    expect((await json("POST", "/api/mcp/servers/fake/auth")).status).toBe(400);
  });

  it("catalogue vide et sans installation ; plateformes de messagerie lisibles, leur activation refusée sans rien changer", async () => {
    const { core, json } = await rig();
    expect((await json("GET", "/api/mcp/catalog")).body).toEqual({ entries: [] });
    const install = await json("POST", "/api/mcp/catalog/install", { name: "x", env: {}, enable: true });
    expect(install.status).toBe(400);
    expect(install.body.detail).toMatch(/pas de catalogue/);

    const platforms = (await json("GET", "/api/messaging/platforms")).body.platforms;
    expect(platforms.map((p: any) => p.id)).toEqual(["telegram", "discord", "slack", "email", "whatsapp"]);
    expect(platforms.every((p: any) => p.enabled === false && p.state === "disabled")).toBe(true);

    const refused = await json("PUT", "/api/messaging/platforms/telegram", { enabled: true });
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toMatch(/Passerelles/);
    expect((core.settings.get("telegram") as { enabled: boolean }).enabled).toBe(false);
  });
});
