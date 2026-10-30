// Dictée locale (analyse du 30/10) : le serveur OpenVINO est trouvé à côté du profil, lancé une seule fois, adopté s'il tourne déjà, arrêté
// seulement s'il a été lancé ici ; une absence ou un arrêt se dit en une phrase lisible.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSttServer, SttService } from "../src/stt-service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeChild() {
  const listeners: ((...a: unknown[]) => void)[] = [];
  return {
    pid: 4242,
    killed: false,
    kill() {
      this.killed = true;
      for (const l of listeners) l(0);
      return true;
    },
    on: (_e: string, l: (...a: unknown[]) => void) => void listeners.push(l),
    exit: (code: number) => listeners.forEach((l) => l(code)),
  };
}

const cfg = { python: "python.exe", script: join("X", "stt", "server.py"), port: 8790 };

describe("findSttServer", () => {
  it("trouve stt/server.py et son venv dans un dossier parent du profil", () => {
    const root = mkdtempSync(join(tmpdir(), "jarod-stt-"));
    dirs.push(root);
    const profile = join(root, "data", "profile", "profiles", "default");
    mkdirSync(profile, { recursive: true });
    mkdirSync(join(root, "stt", "venv", process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
    writeFileSync(join(root, "stt", "server.py"), "");
    writeFileSync(join(root, "stt", "venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"), "");
    expect(findSttServer(profile, {})?.script).toBe(join(root, "stt", "server.py"));
  });

  it("rien d'installé : null", () => {
    const root = mkdtempSync(join(tmpdir(), "jarod-stt-"));
    dirs.push(root);
    expect(findSttServer(root, {})).toBeNull();
  });
});

describe("SttService", () => {
  it("lancé une seule fois pour plusieurs dictées simultanées, prêt quand /health dit ok", async () => {
    let spawns = 0;
    let up = false;
    const child = fakeChild();
    const s = new SttService(cfg, {
      spawn: () => {
        spawns++;
        setTimeout(() => (up = true), 5);
        return child;
      },
      health: async () => (up ? { status: "ok" } : null),
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    });
    await Promise.all([s.ensure(), s.ensure(), s.ensure()]);
    expect(spawns).toBe(1);
    s.stop();
    expect(child.killed).toBe(true);
  });

  it("un serveur qui tourne déjà est adopté et jamais arrêté", async () => {
    let spawns = 0;
    const s = new SttService(cfg, { spawn: () => (spawns++, fakeChild()), health: async () => ({ status: "ok" }) });
    await s.ensure();
    s.stop();
    expect(spawns).toBe(0);
    expect(s.status().ownedPid).toBeNull();
  });

  it("non installé ou arrêté aussitôt : une phrase lisible", async () => {
    await expect(new SttService(null, { spawn: () => fakeChild(), health: async () => null }).ensure()).rejects.toThrow(/n'est pas installée/);
    const child = fakeChild();
    const s = new SttService(cfg, {
      spawn: () => {
        setTimeout(() => child.exit(1), 1);
        return child;
      },
      health: async () => null,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    });
    await expect(s.ensure()).rejects.toThrow(/n'a pas pu démarrer : le serveur de dictée s'est arrêté \(code 1\)/);
  });
});
