import { describe, expect, it } from "vitest";
import { JarodConfig, ScheduleDto, ScheduleSpec, SchedulerConfig, StorageConfig } from "../src/index.js";

describe("contracts", () => {
  it("ScheduleSpec accepte les 4 formes de scheduler.ts:6-13 et refuse le reste", () => {
    for (const spec of [
      { kind: "interval", minutes: 720 },
      { kind: "daily", time: "08:00", days: [1, 2] },
      { kind: "cron", expr: "0 4 * * 0" },
      { kind: "once", at: 1 },
    ]) expect(ScheduleSpec.parse(spec)).toEqual(spec);
    expect(ScheduleSpec.safeParse({ kind: "weekly" }).success).toBe(false);
  });

  it("valeurs par défaut identiques à Jarod-One (tick 30 s, base chiffrée)", () => {
    expect(SchedulerConfig.parse({})).toEqual({ tickMs: 30_000, autoStart: true });
    expect(StorageConfig.parse({ dataDir: "x" }).encryptDb).toBe(true);
    expect(StorageConfig.safeParse({}).success).toBe(false);
    expect(JarodConfig.parse({}).plugins).toEqual({});
  });

  it("ScheduleDto décrit un Schedule tel que le planificateur le rend", () => {
    const s = {
      id: "a", name: "n", prompt: "p", spec: { kind: "cron", expr: "* * * * *" }, sessionId: null, enabled: true,
      lastRun: null, nextRun: 1, lastStatus: null, deliver: { gateway: "telegram", chatId: "42" }, createdAt: 0,
    };
    expect(ScheduleDto.parse(s)).toEqual(s);
  });
});
