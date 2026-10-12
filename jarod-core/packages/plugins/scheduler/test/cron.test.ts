// Portage de packages/core/test/cron.test.ts:1-81 (rév. 2e180305).
// `answer()` (faux fournisseur) retiré : l'exécutant de test `schedule/run` rend « ok ».
// Non portés ici : :83-101 (livraison Telegram) et :104-154 (outils cronjob) → Phase 1 (agent, tools).
import { describe, expect, it } from "vitest";
import { nextCronRun, parseCron } from "../src/cron.js";
import { describeSpec } from "../src/scheduler.js";
import { makeCore } from "./helpers.js";

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("cron expressions", () => {
  it("finds the next matching minute in local time", async () => {
    // Saturday 2026-09-26 10:00 → next weekday 09:00 is Monday the 28th.
    const sat = local(2026, 9, 26, 10);
    expect(nextCronRun("0 9 * * 1-5", sat)).toBe(local(2026, 9, 28, 9));
    expect(nextCronRun("*/15 * * * *", local(2026, 9, 26, 10, 7))).toBe(local(2026, 9, 26, 10, 15));
    expect(nextCronRun("@daily", sat)).toBe(local(2026, 9, 27));
    expect(nextCronRun("30 8 1 jan *", sat)).toBe(local(2027, 1, 1, 8, 30));
    expect(nextCronRun("0 12 * * sun", sat)).toBe(local(2026, 9, 27, 12));
    expect(nextCronRun("0 12 * * 7", sat)).toBe(local(2026, 9, 27, 12));
    // Strictly after `from`.
    expect(nextCronRun("0 10 * * *", sat)).toBe(local(2026, 9, 27, 10));
  });

  it("ORs the two day fields when both are restricted, like cron", async () => {
    // The 1st of the month OR any Monday: from Sat 26 Sep, Monday 28 comes first.
    expect(nextCronRun("0 0 1 * mon", local(2026, 9, 26, 10))).toBe(local(2026, 9, 28));
  });

  it("rejects malformed or impossible expressions", async () => {
    expect(() => parseCron("0 9 * *")).toThrow(/5 champs/);
    expect(() => parseCron("61 * * * *")).toThrow(/hors bornes/);
    expect(() => parseCron("0 9 * * 5-1")).toThrow(/inversé/);
    expect(() => nextCronRun("0 0 31 2 *", Date.now())).toThrow(/Aucune date/);
  });
});

describe("scheduler: cron, one-off and delivery", () => {
  it("runs a one-off once, then switches it off; a past date is refused", async () => {
    const core = await makeCore();
    const at = Date.now() + 60_000;
    const s = core.scheduler.save({ name: "Rappel", prompt: "Rappelle l'appel", spec: { kind: "once", at } });
    expect(s).toMatchObject({ enabled: true, nextRun: at });
    expect(describeSpec(s.spec)).toMatch(/^une fois, le/);

    await core.scheduler.tick(at + 1);
    expect(core.scheduler.get(s.id)).toMatchObject({ enabled: false, nextRun: null, lastStatus: "ok" });
    expect(() =>
      core.scheduler.save({ name: "Trop tard", prompt: "x", spec: { kind: "once", at: Date.now() - 1000 } }),
    ).toThrow(/passée/);
  });

  it("keeps the delivery when a screen saves without it, and removes it with null", async () => {
    const core = await makeCore();
    const s = core.scheduler.save({
      name: "Veille",
      prompt: "Résume",
      spec: { kind: "cron", expr: "0 8 * * *" },
      deliver: { gateway: "telegram", chatId: "42" },
    });
    const toggled = core.scheduler.save({ id: s.id, name: s.name, prompt: s.prompt, spec: s.spec, enabled: false });
    expect(toggled.deliver).toEqual({ gateway: "telegram", chatId: "42" });
    expect(core.scheduler.save({ ...toggled, deliver: null }).deliver).toBeNull();
    expect(() => core.scheduler.save({ ...toggled, deliver: { gateway: "fax" as never, chatId: "1" } })).toThrow(
      /inconnue/,
    );
  });
});
