// Lot 5 (30/10) : capacités de Mark-LVI réécrites pour Jarod — alertes matériel, « ouvrir ce qui tourne déjà ramène la fenêtre ».
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/registry.js";
import { systemActTools } from "../src/system/act.js";
import { everydayTools, hardwareAlerts, HARDWARE_LIMITS } from "../src/system/everyday.js";
import * as S from "../src/system/scripts.js";
import * as E from "../src/system/scripts-everyday.js";

const ctx = { sessionId: "s", workspace: null } as ToolContext;
const GB = 1e9;

describe("hardwareAlerts (pure)", () => {
  it("tout va bien : aucune alerte", () => {
    const info = { memory_total_bytes: 32 * GB, memory_used_bytes: 12 * GB, disks: [{ mount: "C:", total_bytes: 1000 * GB, free_bytes: 400 * GB }], battery: { percent: 80, state: "charging" } };
    expect(hardwareAlerts(info)).toEqual([]);
  });

  it("mémoire, disque et batterie hors limites : une alerte lisible chacune", () => {
    const alerts = hardwareAlerts({
      memory_total_bytes: 16 * GB,
      memory_used_bytes: 15.5 * GB,
      disks: [{ mount: "C:", total_bytes: 500 * GB, free_bytes: 100 * GB }, { mount: "D:", total_bytes: 500 * GB, free_bytes: 3 * GB }],
      battery: { percent: 12, state: "discharging" },
    });
    expect(alerts.map((a) => a.what)).toEqual(["memory", "disk", "battery"]);
    expect(alerts[1]!.message).toMatch(/^Disque D: presque plein : 3\.0 Go libres/);
  });

  it("une batterie faible qui charge n'alerte pas ; un PC sans batterie non plus", () => {
    expect(hardwareAlerts({ battery: { percent: 5, state: "charging" } })).toEqual([]);
    expect(hardwareAlerts({ battery: null })).toEqual([]);
    expect(HARDWARE_LIMITS.memoryPercent).toBe(90);
  });
});

describe("hardware_check (PowerShell simulé)", () => {
  it("rend les alertes du relevé", async () => {
    const ps = {
      json: async (script: string) => (script === S.SYSTEM_INFO ? { total_kb: 16 * 1024 * 1024, free_kb: 0.5 * 1024 * 1024, logical: 8, disks: [] } : null),
    };
    const tool = everydayTools({ platform: "win32", ps }).find((t) => t.name === "hardware_check")!;
    const out = JSON.parse(await tool.run({}, ctx));
    expect(out.ok).toBe(false);
    expect(out.alerts[0]).toMatch(/Mémoire presque pleine/);
  });
});

describe("system_open : ramener au lieu de dupliquer", () => {
  const apps = [{ name: "Bloc-notes", id: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" }];
  const running = [{ pid: 4242, process: "Notepad", description: "Bloc-notes", path: "C:\\Windows\\notepad.exe", title: "sans titre" }];

  function rig(runningRows: unknown[], raised: boolean) {
    const launched: string[] = [];
    const raisedPids: unknown[] = [];
    const ps = {
      json: async (script: string, args?: Record<string, unknown>) => {
        if (script === S.INSTALLED_APPS) return apps;
        if (script === S.RUNNING_APPS) return runningRows;
        if (script === E.RAISE_WINDOW) return (raisedPids.push(args?.pid), { raised });
        return null;
      },
    };
    const tool = systemActTools({ platform: "win32", ps, launch: async (file) => void launched.push(file), verifyDelaysMs: [0] }).find((t) => t.name === "system_open")!;
    return { tool, launched, raisedPids };
  }

  it("déjà ouverte : la fenêtre vient devant, rien n'est relancé", async () => {
    const { tool, launched, raisedPids } = rig(running, true);
    const args = { target: "app", app: "Bloc-notes" };
    await tool.precheck!(args, ctx);
    expect(JSON.parse(await tool.run(args, ctx))).toEqual({ opened: "Bloc-notes", raised: true });
    expect(launched).toEqual([]);
    expect(raisedPids).toEqual([4242]);
  });

  it("pas ouverte, ou fenêtre impossible à ramener : l'application est lancée", async () => {
    for (const r of [rig([], true), rig(running, false)]) {
      const args = { target: "app", app: "Bloc-notes" };
      await r.tool.precheck!(args, ctx);
      expect(JSON.parse(await r.tool.run(args, ctx))).toEqual({ opened: "Bloc-notes" });
      expect(r.launched).toEqual(["explorer.exe"]);
    }
  });
});
