// Passerelle compatible Hermes : le pont vers les canaux de pilotage (`POST /api/jarod/invoke`), les événements poussés (`jarod.event`) et les gestes natifs
// demandés à la fenêtre (`jarod.shell`). Le VRAI noyau et les VRAIS handlers de @jarod/bridge ; la fenêtre est un client WebSocket de test.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOneaiChannel, createHandlers, desktopKernelOf } from "@jarod/bridge";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import { BridgeError, createBridgePort, parseInvokeBody } from "../src/gateway/bridge.js";
import { createBridgeShell } from "../src/gateway/bridge-shell.js";
import { createGateway } from "../src/gateway/server.js";

describe("createBridgePort / parseInvokeBody", () => {
  const port = createBridgePort(
    {
      ok: () => 42,
      boom: () => {
        throw new Error("raté");
      },
      async later() {
        return "tard";
      },
    },
    (c) => {
      if (c === "ok" || c === "boom" || c === "later" || c === "absent") return c;
      throw new Error("canal refusé");
    },
  );

  it("appelle le handler, attend une promesse, refuse un canal hors liste (400), dit « non porté » pour un canal permis sans handler (404)", async () => {
    expect(await port.invoke("ok", [])).toBe(42);
    expect(await port.invoke("later", [])).toBe("tard");
    await expect(port.invoke("rm", [])).rejects.toMatchObject({ status: 400, message: "canal refusé" });
    await expect(port.invoke("absent", [])).rejects.toMatchObject({ status: 404, message: expect.stringContaining("non porté") });
    await expect(port.invoke("boom", [])).rejects.toMatchObject({ status: 400, message: "raté" });
  });

  it("le nom d'un canal qui est une propriété du prototype n'est jamais appelé", async () => {
    const p = createBridgePort({}, (c) => String(c));
    await expect(p.invoke("toString", [])).rejects.toBeInstanceOf(BridgeError);
    await expect(p.invoke("constructor", [])).rejects.toMatchObject({ status: 404 });
  });

  it("le message d'une erreur de handler est masqué s'il porte une clé", async () => {
    const key = ["sk", "CANARI-BRIDGE-0123456789abcdef0123"].join("-");
    const p = createBridgePort({ leak: () => { throw new Error(`échec avec ${key}`); } }, (c) => String(c));
    await expect(p.invoke("leak", [])).rejects.toThrow(/échec avec/);
    await p.invoke("leak", []).catch((e: Error) => expect(e.message).not.toContain("CANARI"));
  });

  it("parseInvokeBody : channel texte non vide, args liste (vide par défaut)", () => {
    expect(parseInvokeBody({ channel: "a" })).toEqual({ channel: "a", args: [] });
    expect(parseInvokeBody({ channel: "a", args: [1, "x"] })).toEqual({ channel: "a", args: [1, "x"] });
    for (const bad of [{}, { channel: "" }, { channel: 3 }, { channel: "a", args: "x" }, { channel: "a", args: {} }]) expect(() => parseInvokeBody(bad)).toThrow(BridgeError);
  });
});

const dirs: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig(opts: { bridge?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jarod-gw-bridge-"));
  dirs.push(root);
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core, profile, dataDir } = await openCore({ env: { JAROD_HOME: root } });
  const gw = createGateway({ core, version: "9.9.9-test" });
  if (opts.bridge !== false) {
    const kernel = desktopKernelOf(core.app as never, { profile, dataRoot: root });
    const shell = createBridgeShell({ version: "9.9.9-test", dataDir, link: gw.link });
    gw.attachBridge(createBridgePort(createHandlers({ kernel: () => kernel, shell }), (c) => assertOneaiChannel("invoke", c)));
  }
  const port = await gw.listen(0);
  closers.push(async () => {
    await gw.close();
    await core.dispose();
  });
  const call = async (path: string, body: unknown, token: string | null = gw.token) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-hermes-session-token": token } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const invoke = (channel: string, args: unknown[] = []) => call("/api/jarod/invoke", { channel, args });
  return { gw, port, call, invoke };
}

describe("POST /api/jarod/invoke (vrai noyau, vrais handlers)", () => {
  it("rend le résultat d'un handler, y compris celui qui lit le noyau (fournisseurs, version)", async () => {
    const { invoke } = await rig();
    expect(await invoke("get-app-version")).toEqual({ status: 200, json: { result: "9.9.9-test" } });
    const env = await invoke("get-env");
    expect(env.status).toBe(200);
    expect(env.json.result).toEqual({});
  });

  it("un canal hors liste → 400 ; permis mais non porté (terminal) → 404 ; corps invalide → 400 ; sans jeton → 401", async () => {
    const { invoke, call } = await rig();
    expect((await invoke("rm-rf")).status).toBe(400);
    const terminal = await invoke("terminal-open");
    expect(terminal.status).toBe(404);
    expect(terminal.json.detail).toMatch(/non porté/);
    expect((await call("/api/jarod/invoke", { args: [] })).status).toBe(400);
    expect((await call("/api/jarod/invoke", { channel: "get-app-version" }, null)).status).toBe(401);
  });

  it("un refus d'un handler arrive en 400 avec son message (validation de l'origine conservée)", async () => {
    const { invoke } = await rig();
    const r = await invoke("local-models-load", ["inconnu", "x"]);
    expect(r.status).toBe(400);
    expect(r.json.detail).toMatch(/moteur attendu/);
  });

  it("sans pont branché : 404", async () => {
    const { invoke } = await rig({ bridge: false });
    const r = await invoke("get-app-version");
    expect(r.status).toBe(404);
    expect(r.json.detail).toMatch(/pas branchés/);
  });
});

describe("événements et gestes natifs, par la fenêtre connectée", () => {
  async function window(port: number, token: string, answer: (params: Record<string, unknown>) => unknown) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
    closers.push(() => ws.close());
    const events: { type: string; payload: any }[] = [];
    const asked: Record<string, unknown>[] = [];
    ws.addEventListener("message", (m) => {
      const f = JSON.parse(String(m.data));
      if (f.method === "event") events.push(f.params);
      else if (f.method === "jarod.shell") {
        asked.push(f.params);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: f.id, result: answer(f.params) }));
      }
    });
    await new Promise<void>((ok, bad) => {
      ws.addEventListener("open", () => ok());
      ws.addEventListener("error", () => bad(new Error("connexion refusée")));
    });
    return { events, asked };
  }
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  };

  it("`link.send` arrive à la fenêtre en `jarod.event` { channel, args }", async () => {
    const { gw, port } = await rig();
    const w = await window(port, gw.token, () => null);
    gw.link.send("local-models-activity", [{ model: "m", phase: "loading" }]);
    await until(() => w.events.some((e) => e.type === "jarod.event"));
    expect(w.events.find((e) => e.type === "jarod.event")?.payload).toEqual({ channel: "local-models-activity", args: [{ model: "m", phase: "loading" }] });
  });

  it("une boîte « Ouvrir » demandée par un handler est posée à la fenêtre ; sa réponse revient ; annulée = null", async () => {
    const { gw, port } = await rig();
    let reply: unknown = "C:\\Modeles\\a.gguf";
    const w = await window(port, gw.token, () => reply);
    const shell = createBridgeShell({ version: "x", dataDir: "d", link: gw.link });
    expect(await shell.pickFile!({ title: "Modèle GGUF", filters: [{ name: "GGUF", extensions: ["gguf"] }] })).toBe("C:\\Modeles\\a.gguf");
    expect(w.asked[0]).toMatchObject({ kind: "pickFile", title: "Modèle GGUF", filters: [{ name: "GGUF", extensions: ["gguf"] }] });
    reply = null;
    expect(await shell.pickFile!({ title: "x", filters: [] })).toBeNull();
    reply = true;
    expect(await shell.confirm!("Sûr ?", "détail", "Oui")).toBe(true);
    reply = "peut-être";
    expect(await shell.confirm!("Sûr ?", "détail")).toBe(false); // seul `true` vaut accord
  });

  it("sans fenêtre connectée, un geste natif est refusé (null / faux), jamais accordé", async () => {
    const { gw } = await rig();
    const shell = createBridgeShell({ version: "x", dataDir: "d", link: gw.link });
    expect(await shell.pickFolder!()).toBeNull();
    expect(await shell.confirm!("Sûr ?", "détail")).toBe(false);
    expect(await shell.confirmInstall!({ kind: "skill", id: "a", name: "a", source: "s", revision: "r", license: "MIT", sha256: "0", permissions: [], files: 1, target: "t" })).toBe(false);
  });
});
