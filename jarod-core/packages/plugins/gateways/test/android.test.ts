// Portage de packages/core/test/android.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { AndroidService, parseDevices } from "../src/android.js";
import { makeCore } from "./helpers.js";

interface Rig {
  service: AndroidService;
  calls: string[][];
  fail: { value: { out: string; err: string; code: number } | null };
}

/** Records the adb command line instead of running it, so the guards are what is under test. */
async function rig(opts: { present?: boolean; out?: string; code?: number } = {}): Promise<Rig> {
  const calls: string[][] = [];
  const fail: Rig["fail"] = { value: null };
  const service = new AndroidService({
    events: (await makeCore()).events,
    adbPath: () => (opts.present === false ? "" : "C:/fake/adb.exe"),
    exists: () => true,
    env: { PATH: "" },
    run: async (args) => {
      calls.push(args);
      if (fail.value) return fail.value;
      return { out: opts.out ?? "", err: "", code: opts.code ?? 0 };
    },
  });
  return { service, calls, fail };
}

describe("android — the device list", () => {
  it("reads what adb prints, header and blanks aside", () => {
    const out = [
      "List of devices attached",
      "EMU1    device product:sdk_gphone model:sdk_gphone64_x86_64 device:emu transport_id:1",
      "",
      "0123456789ABCDEF       unauthorized usb:1-2 transport_id:2",
      "",
    ].join("\r\n");
    expect(parseDevices(out)).toEqual([
      { serial: "EMU1", state: "device", model: "sdk_gphone64_x86_64", product: "sdk_gphone" },
      { serial: "0123456789ABCDEF", state: "unauthorized", model: "", product: "" },
    ]);
  });

  it("asks adb for the long list", async () => {
    const r = await rig({ out: "List of devices attached\r\nEMU1 device model:x\r\n" });
    expect(await r.service.devices()).toHaveLength(1);
    expect(r.calls[0]).toEqual(["devices", "-l"]);
  });
});

describe("android — one command, one approval", () => {
  it("never lets a second command ride along", async () => {
    const r = await rig();
    for (const chained of [
      "ls; rm -rf /sdcard",
      "ls && reboot",
      "cat /proc/version | grep Linux",
      "echo `id`",
      "echo $HOME",
      "reboot > /sdcard/log",
      "ls\nreboot",
    ]) {
      const result = await r.service.shell(chained);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("ANDROID_CHAINED");
    }
    // Not one of them reached adb: the refusal happens before anything runs.
    expect(r.calls).toEqual([]);
  });

  it("passes the command as one argument, with the device when there is one", async () => {
    const r = await rig({ out: "Pixel" });
    const result = await r.service.shell("getprop ro.product.model", "EMU1");
    expect(r.calls[0]).toEqual(["-s", "EMU1", "shell", "getprop ro.product.model"]);
    expect(result.out).toBe("Pixel");
    expect(result.ok).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);

    await r.service.shell("getprop ro.product.model");
    expect(r.calls[1]).toEqual(["shell", "getprop ro.product.model"]);
  });

  it("refuses an empty command, and says when adb is not there at all", async () => {
    const r = await rig();
    expect((await r.service.shell("   ")).error).toContain("commande vide");
    expect(r.calls).toEqual([]);

    const none = await rig({ present: false });
    const result = await none.service.shell("ls");
    expect(result.error).toContain("ADB_ABSENT");
    expect(none.calls).toEqual([]);
    expect(none.service.available()).toBe(false);
  });

  it("reads a package version without piping anything", async () => {
    const r = await rig({ out: "Packages:\n  versionName=1.2.3\n" });
    expect(await r.service.packageVersion("com.example.app")).toBe("1.2.3");
    // Chaining is refused, so the reading happens on this side — no `| grep` in the command.
    expect(r.calls[0]).toEqual(["shell", "dumpsys package com.example.app"]);
    await expect(r.service.packageVersion("com/example; reboot")).rejects.toThrow("ANDROID_BAD_PACKAGE");
  });
});

describe("android — the journal", () => {
  it("writes down what ran, what it answered, and what was refused", async () => {
    const core = await makeCore();
    const calls: string[][] = [];
    const service = new AndroidService({
      events: core.events,
      adbPath: () => "C:/fake/adb.exe",
      exists: () => true,
      env: { PATH: "" },
      run: async (args) => {
        calls.push(args);
        return args[3] === "false" ? { out: "", err: "boom", code: 1 } : { out: "ok", err: "", code: 0 };
      },
    });

    await service.shell("true", "EMU1");
    await service.shell("false", "EMU1");
    await service.shell("ls; reboot", "EMU1");

    const journal = service.journal(10, "EMU1");
    // Newest first, and the refusal is in there: a command that was asked for belongs to the record.
    expect(journal.map((entry) => [entry.command, entry.ok])).toEqual([
      ["ls; reboot", false],
      ["false", false],
      ["true", true],
    ]);
    expect(journal[1]?.code).toBe(1);
    expect(journal[0]?.serial).toBe("EMU1");
    expect(journal[0]?.error).toContain("ANDROID_CHAINED");

    // Every step is in the device's own stream, in order.
    const stream = core.events.list({ stream: "android:EMU1" }).map((e) => e.type);
    expect(stream).toEqual([
      "command.started",
      "command.finished",
      "command.started",
      "command.finished",
      "command.refused",
    ]);
  });

  it("never writes a secret down: a command is redacted before it is recorded", async () => {
    const core = await makeCore();
    const service = new AndroidService({
      events: core.events,
      adbPath: () => "C:/fake/adb.exe",
      exists: () => true,
      env: { PATH: "" },
      run: async () => ({ out: "", err: "", code: 0 }),
    });
    const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
    await service.shell(`curl -H "Authorization: Bearer ${secret}" https://exemple.test`, "EMU1");

    const entry = service.journal(1, "EMU1")[0]!;
    expect(entry.command).not.toContain(secret);
    // What the device stream holds is the same redacted form — the journal is read by others.
    const raw = JSON.stringify(core.events.list({ stream: "android:EMU1" }));
    expect(raw).not.toContain(secret);
    expect(raw).toContain("Authorization");
  });
});

// SPECS-P5-UI-PARITE.md § 21 : aucun lancement sans adb résolu (et existant) ; l'état se dit ; le comportement gardé est épinglé.
describe("android — state and spawning (§ 21)", () => {
  const make = (over: { path?: string; exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv }) => {
    const calls: string[][] = [];
    const service = new AndroidService({
      adbPath: () => over.path ?? "",
      ...(over.exists ? { exists: over.exists } : {}),
      env: over.env ?? { PATH: "" },
      run: async (args) => {
        calls.push(args);
        return { out: "List of devices attached\nEMU1 device model:x\n", err: "", code: 0 };
      },
    });
    return { service, calls };
  };

  it("AD1 rien de configuré et PATH sans adb : « unconfigured », aucune liste, le lanceur n'est JAMAIS appelé", async () => {
    const { service, calls } = make({});
    expect(service.state()).toBe("unconfigured");
    for (let i = 0; i < 3; i++) expect(await service.devices()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("AD2 chemin configuré qui n'existe pas : « missing », le lanceur n'est jamais appelé, shell refuse ADB_ABSENT et le journalise", async () => {
    const { service, calls } = make({ path: "C:/disparu/adb.exe", exists: () => false });
    expect(service.state()).toBe("missing");
    expect(service.available()).toBe(false);
    expect(await service.devices()).toEqual([]);
    const r = await service.shell("getprop ro.product.model");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ADB_ABSENT");
    expect(calls).toEqual([]);
  });

  it("AD3 adb résolu et présent : « ready », UN appel [devices, -l] par devices() (comportement gardé)", async () => {
    const { service, calls } = make({ path: "C:/ok/adb.exe", exists: () => true });
    expect(service.state()).toBe("ready");
    expect(await service.devices()).toHaveLength(1);
    expect(await service.devices()).toHaveLength(1);
    expect(calls).toEqual([["devices", "-l"], ["devices", "-l"]]);
  });

  it("AD4 le fichier disparaît entre deux appels : le second ne lance rien (l'existence est relue)", async () => {
    let there = true;
    const { service, calls } = make({ path: "C:/ok/adb.exe", exists: () => there });
    expect(await service.devices()).toHaveLength(1);
    there = false;
    expect(service.state()).toBe("missing");
    expect(await service.devices()).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("android — the real adb on this computer", () => {
  // Only the availability check lives here: a core built now would hold a database that the test
  // runner closes before the test body runs.
  const probe = new AndroidService();

  it.skipIf(!probe.available())("answers through the adb that is installed here", async () => {
    const real = new AndroidService({ events: (await makeCore()).events });
    // No phone is attached in a test environment, so the honest expectation is the device list
    // coming back empty and a command failing *with adb's own words* — proving the chain end to end.
    expect(Array.isArray(await real.devices())).toBe(true);
    const result = await real.shell("getprop ro.product.model");
    expect(result.ok).toBe(false);
    expect(`${result.error}`.toLowerCase()).toContain("no devices");
    expect(real.journal(1)[0]?.command).toBe("getprop ro.product.model");
  });
});
