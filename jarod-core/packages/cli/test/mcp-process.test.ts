// SPECS-P5-MCP.md §4 (a)(e) en PROCESSUS RÉEL (`tsx src/main.ts mcp`) : stdout ne porte que du JSON-RPC même si un « plugin » fait console.log,
// la ligne de démarrage va sur stderr, la fin d'entrée arrête proprement le serveur sans processus orphelin.
// (SIGTERM n'est pas testé : sous Windows il tue sans exécuter de gestionnaire ; la fin d'entrée est le chemin normal des clients MCP.)
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isProcessAlive } from "@jarod/plugin-agent";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_TS = join(HERE, "..", "src", "main.ts");
const POLLUTER = join(HERE, "fixtures", "stdout-polluter.mjs");
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

const dirs: string[] = [];
const kids: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function profile(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "jarod-mcpproc-"));
  dirs.push(root);
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core } = await openCore({ env: { JAROD_HOME: root } });
  core.memory.add("Préférence : thé vert", "preference");
  await core.dispose();
  return root;
}

function launch(root: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [TSX, MAIN_TS, "mcp"], {
    env: { ...process.env, JAROD_HOME: root, VITEST: "", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  kids.push(child);
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const until = async (pred: () => boolean, ms = 30_000): Promise<void> => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`délai dépassé ; stdout=${out.slice(0, 400)} ; stderr=${err.slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);
  const lines = () => out.split("\n").filter(Boolean);
  return { child, send, until, exited, lines, stdout: () => out, stderr: () => err };
}

describe("jarod mcp en processus réel", () => {
  it("stdout = JSON-RPC seulement, même avec un plugin qui fait console.log ; ligne de démarrage sur stderr ; EOF → sortie 0 sans orphelin", { timeout: 120_000 }, async () => {
    const root = await profile();
    const marker = join(root, "pollue.marqueur");
    const s = launch(root, { NODE_OPTIONS: `--import=${pathToFileURL(POLLUTER).href}`, JAROD_POLLUTE_MARKER: marker });

    await s.until(() => /jarod mcp \(pid \d+\)/.test(s.stderr()));
    expect(s.stdout(), "rien sur stdout avant la première requête (G1 : la bannière va sur stderr)").toBe("");
    const pid = Number(/jarod mcp \(pid (\d+)\)/.exec(s.stderr())![1]);
    expect(isProcessAlive(pid)).toBe(true);

    s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await s.until(() => s.lines().length >= 1);
    writeFileSync(marker, "x"); // le « plugin » se met à parler
    await s.until(() => s.stderr().includes("PAS-DU-JSON"), 10_000);
    s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    s.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_list", arguments: {} } });
    await s.until(() => s.lines().length >= 3);

    for (const line of s.lines()) {
      const m = JSON.parse(line) as { jsonrpc: string; id: number };
      expect(m.jsonrpc).toBe("2.0");
    }
    expect(s.stdout()).not.toContain("PAS-DU-JSON");
    expect(s.lines().map((l) => (JSON.parse(l) as { id: number }).id).sort()).toEqual([1, 2, 3]);
    expect(s.stdout()).toContain("thé vert");

    const t0 = Date.now();
    s.child.stdin.end();
    expect(await s.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(isProcessAlive(pid), "le serveur a disparu (pas d'orphelin)").toBe(false);
    expect(existsSync(join(root, "mcp-server.log"))).toBe(true);
  });

  it("schéma/profil inconnu : sortie 1 avec un message sur stderr, rien sur stdout", { timeout: 120_000 }, async () => {
    const root = await profile();
    const child = spawn(process.execPath, [TSX, MAIN_TS, "mcp", "--profile", "inconnu"], {
      env: { ...process.env, JAROD_HOME: root, VITEST: "" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    kids.push(child);
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    expect(code).toBe(1);
    expect(err).toMatch(/Profil inconnu/);
    expect(out).toBe("");
  });
});
