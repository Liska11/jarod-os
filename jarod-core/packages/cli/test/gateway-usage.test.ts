// Passerelle compatible Hermes (essai) : GET /api/analytics/usage (la page « Usage » de Herald), tiré des jetons des messages de l'assistant.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import { createGateway } from "../src/gateway/server.js";
import { analytics, dayKey, parseDays, periodStart, type UsageRow } from "../src/gateway/usage.js";

const DAY = 86_400_000;
// Midi local, 15 octobre 2026 : loin des bascules de jour, quel que soit le fuseau.
const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime();
const row = (over: Partial<UsageRow> & { ago?: number } = {}): UsageRow => ({
  session_id: "s1", model: "claude-sonnet-4-5", input_tokens: 1000, output_tokens: 500, created_at: NOW - (over.ago ?? 0) * DAY, ...over,
});

describe("analytics (pur)", () => {
  it("zéro lignes : tous les jours de la période sont là, à zéro, coût inconnu", () => {
    const a = analytics([], 7, NOW);
    expect(a.daily).toHaveLength(7);
    expect(a.daily.map((d) => d.day)).toEqual(["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
    expect(a.daily.every((d) => d.input_tokens === 0 && d.sessions === 0 && d.estimated_cost === null)).toBe(true);
    expect(a.totals).toEqual({ total_input: 0, total_output: 0, total_estimated_cost: null, total_actual_cost: null, total_sessions: 0 });
    expect(a).toMatchObject({ by_model: [], period_days: 7 });
  });

  it("additionne par jour et par modèle ; une session compte une fois par jour et une fois au total", () => {
    const a = analytics([row({ session_id: "a" }), row({ session_id: "a", input_tokens: 10, output_tokens: 5 }), row({ session_id: "b", ago: 1, model: "inconnu-x" }), row({ session_id: "a", ago: 2 })], 7, NOW);
    const today = a.daily.at(-1)!;
    expect(today).toMatchObject({ day: "2026-10-15", input_tokens: 1010, output_tokens: 505, sessions: 1 });
    expect(a.daily.at(-2)).toMatchObject({ day: "2026-10-14", input_tokens: 1000, sessions: 1, estimated_cost: null }); // modèle sans prix connu : coût inconnu, pas zéro
    expect(a.totals).toMatchObject({ total_input: 3010, total_output: 1505, total_sessions: 2 });
    expect(a.by_model.map((m) => m.model)).toEqual(["claude-sonnet-4-5", "inconnu-x"]); // trié par jetons décroissants
    expect(a.by_model[0]).toMatchObject({ input_tokens: 2010, output_tokens: 1005, sessions: 1 });
  });

  it("le coût n'est estimé que pour les modèles dont le prix est connu, et les jours se cumulent", () => {
    const a = analytics([row({ input_tokens: 1_000_000, output_tokens: 0 }), row({ model: "inconnu-x", input_tokens: 5_000_000 })], 1, NOW);
    expect(a.daily[0]!.estimated_cost).toBeGreaterThan(0);
    expect(a.totals.total_estimated_cost).toBe(a.daily[0]!.estimated_cost);
    expect(a.totals.total_actual_cost).toBeNull();
  });

  it("hors période (trop ancien ou dans le futur) : ignoré ; modèle absent : « unknown »", () => {
    const a = analytics([row({ ago: 8 }), row({ created_at: NOW + DAY }), row({ model: null })], 7, NOW);
    expect(a.totals.total_input).toBe(1000);
    expect(a.by_model.map((m) => m.model)).toEqual(["unknown"]);
  });

  it("parseDays : 7 par défaut, entier de 1 à 365, le reste est refusé", () => {
    expect(parseDays(null)).toBe(7);
    expect(parseDays("30")).toBe(30);
    for (const bad of ["0", "366", "1.5", "abc", "-3"]) expect(() => parseDays(bad), bad).toThrow(/entre 1 et 365/);
    expect(dayKey(periodStart(1, NOW))).toBe("2026-10-15");
    expect(dayKey(periodStart(30, NOW))).toBe("2026-09-16");
  });
});

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("GET /api/analytics/usage devant le vrai noyau", { timeout: 60_000 }, () => {
  it("lit les vrais messages : aujourd'hui, hier, un message ancien hors de la période", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarod-gw-usage-"));
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
    const get = async (path: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-hermes-session-token": gw.token } });
      return { status: r.status, body: (await r.json()) as any };
    };

    const s = core.sessions.create("Essai");
    const add = (inputTokens: number, outputTokens: number, model: string) => core.messages.add(s.id, { role: "assistant", content: "x", inputTokens, outputTokens, model } as never);
    const a = add(100, 40, "claude-sonnet-4-5");
    const b = add(200, 60, "claude-sonnet-4-5");
    const old = add(999, 999, "claude-sonnet-4-5");
    core.messages.add(s.id, { role: "user", content: "pas de jetons pour l'utilisateur" } as never);
    const set = (id: string, ms: number) => core.db.run("UPDATE messages SET created_at = ? WHERE id = ?", ms, id);
    const now = Date.now();
    set(b.id, now - DAY);
    set(old.id, now - 20 * DAY);
    void a;

    const week = await get("/api/analytics/usage?days=7");
    expect(week.status).toBe(200);
    expect(week.body.period_days).toBe(7);
    expect(week.body.daily).toHaveLength(7);
    expect(week.body.totals).toMatchObject({ total_input: 300, total_output: 100, total_sessions: 1 });
    expect(week.body.by_model).toEqual([{ model: "claude-sonnet-4-5", input_tokens: 300, output_tokens: 100, sessions: 1 }]);
    expect(week.body.daily.at(-1)).toMatchObject({ input_tokens: 100 });
    expect(week.body.daily.at(-2)).toMatchObject({ input_tokens: 200 });
    expect(week.body.totals.total_estimated_cost).toBeGreaterThan(0);

    expect((await get("/api/analytics/usage?days=30")).body.totals).toMatchObject({ total_input: 1299, total_output: 1099 });
    expect((await get("/api/analytics/usage")).body.period_days).toBe(7);
    expect((await get("/api/analytics/usage?days=0")).status).toBe(400);
  });
});
