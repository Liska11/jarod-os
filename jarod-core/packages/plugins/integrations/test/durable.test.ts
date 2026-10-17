import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterAll, describe, expect, it } from "vitest";
import { AdapterRefused, DurableRuns } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "jarod-durable-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Adapte la base réelle (better-sqlite3-multiple-ciphers) à l'interface minimale. */
function open(file: string) {
  const db = new Database(file);
  const p = (a: (string | number | null)[]) => a;
  return {
    db,
    api: {
      all: <T>(sql: string, ...a: (string | number | null)[]) => db.prepare(sql).all(...p(a)) as T[],
      run: (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...p(a)),
      exec: (sql: string) => void db.exec(sql),
    },
  };
}

describe("R4 — exécutions durables sur SQLite réel", () => {
  it("rejoue une activité terminée sans la ré-exécuter, après un arrêt au milieu (reprise sur une AUTRE connexion)", async () => {
    const file = join(dir, "a.db");
    const calls: string[] = [];
    const wf = (crashAfter: string | null) => async (ctx: { activity: <A>(k: string, f: () => Promise<A>) => Promise<A> }) => {
      const a = await ctx.activity("fetch", async () => (calls.push("fetch"), "données"));
      if (crashAfter === "fetch") throw new Error("arrêt brutal");
      const b = await ctx.activity("transform", async () => (calls.push("transform"), `${a}!`));
      return b;
    };

    const first = open(file);
    const runs1 = new DurableRuns(first.api);
    runs1.start("r1", "demo", { x: 1 });
    await expect(runs1.run("r1", wf("fetch"))).rejects.toThrow("arrêt brutal");
    first.db.close();

    const second = open(file); // « redémarrage »
    const runs2 = new DurableRuns(second.api);
    expect(runs2.status("r1")).toMatchObject({ status: "running" });
    expect(await runs2.run("r1", wf(null))).toBe("données!");
    expect(calls).toEqual(["fetch", "transform"]); // fetch n'a PAS été rejoué
    expect(runs2.history("r1").map((e) => [e.key, e.kind])).toEqual([["fetch", "completed"], ["transform", "completed"]]);
    expect(runs2.status("r1")).toMatchObject({ status: "completed", result: "données!" });
    expect(await runs2.run("r1", wf(null))).toBe("données!"); // déjà terminée : le résultat est rendu, rien ne tourne
    expect(calls).toHaveLength(2);
    second.db.close();
  });

  it("plafonne les échecs par activité, historise chaque échec, et passe à « failed »", async () => {
    const o = open(join(dir, "b.db"));
    const runs = new DurableRuns(o.api);
    runs.start("r2", "demo", null);
    let tries = 0;
    const wf = async (ctx: { activity: <A>(k: string, f: () => Promise<A>, o?: { maxAttempts?: number }) => Promise<A> }) => ctx.activity("flaky", async () => { tries++; throw new Error("réseau"); }, { maxAttempts: 2 });
    await expect(runs.run("r2", wf)).rejects.toThrow("réseau");
    await expect(runs.run("r2", wf)).rejects.toThrow("réseau");
    await expect(runs.run("r2", wf)).rejects.toThrow(/plafond/);
    expect(tries).toBe(2);
    expect(runs.status("r2")?.status).toBe("failed");
    expect(runs.history("r2").filter((e) => e.kind === "failed")).toHaveLength(2);
    o.db.close();
  });

  it("refuse une clé en double (déroulé non déterministe), une clé invalide, un doublon d'exécution, une exécution inconnue, une charge énorme", async () => {
    const o = open(join(dir, "c.db"));
    const runs = new DurableRuns(o.api);
    runs.start("r3", "demo", null);
    await expect(runs.run("r3", async (ctx) => { await ctx.activity("k", async () => 1); await ctx.activity("k", async () => 2); })).rejects.toThrow(/en double/);
    await expect(runs.run("r3", async (ctx) => ctx.activity("a b", async () => 1))).rejects.toThrow(/invalide/);
    expect(() => runs.start("r3", "demo", null)).toThrow(AdapterRefused);
    await expect(runs.run("zz", async () => 1)).rejects.toThrow(/inconnue/);
    runs.start("r4", "demo", null);
    await expect(runs.run("r4", async (ctx) => ctx.activity("big", async () => "x".repeat(1_100_000)))).rejects.toThrow(/trop grande/);
    o.db.close();
  });

  it("le résultat est masqué dans l'historique par `redact`, pas pour l'appelant", async () => {
    const o = open(join(dir, "d.db"));
    const runs = new DurableRuns(o.api);
    runs.start("r5", "demo", null);
    const out = await runs.run("r5", (ctx) => ctx.activity("login", async () => ({ jeton: "TOKEN-123" }), { redact: () => ({ jeton: "[MASQUÉ]" }) }));
    expect(out).toEqual({ jeton: "TOKEN-123" });
    expect(JSON.stringify(runs.history("r5"))).not.toContain("TOKEN-123");
    o.db.close();
  });
});
