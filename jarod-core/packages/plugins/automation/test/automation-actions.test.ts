/**
 * AV2-007 — ce que l'automatisation DIT avoir fait doit être ce qu'elle a fait :
 *
 *  (a) le mode de l'action `agent` arrive à l'exécutant (Plan par défaut, « build » seulement s'il est
 *      écrit — SPECS-P5-AUTOMATION § 2.3, Q2) ; avant, le paramètre était ignoré ;
 *  (b) un tour agent qui échoue (`ok: false`) marque le job en échec, il n'est plus « ok » ;
 *  (c) l'action `webhook`, non implémentée, échoue FRANCHEMENT au lieu d'être marquée « ok ».
 */
import { describe, expect, it } from "vitest";
import { makeCore, tempDir, testKeys } from "./helpers.js";

type Core = Awaited<ReturnType<typeof makeCore>>;
const jobsAuto = (core: Core) => core.jobs.list().filter((j) => j.kind === "automation");

describe("AV2-007 (a) — le mode de l'action agent est transmis", () => {
  it("sans mode : Plan ; avec mode « build » : build", async () => {
    const core = await makeCore({ dataDir: tempDir(), keyStores: [testKeys] });
    const defaut = core.automation.create({ name: "d", trigger: { kind: "manual" }, actions: [{ type: "agent", prompt: "lis" }] });
    const build = core.automation.create({ name: "b", trigger: { kind: "manual" }, actions: [{ type: "agent", prompt: "écris", mode: "build" }] });
    await core.automation.run(defaut.id);
    await core.automation.run(build.id);
    expect(core.schedules.map((s) => [s.prompt, s.mode])).toEqual([
      ["lis", "plan"],
      ["écris", "build"],
    ]);
    await core.dispose();
  });
});

describe("AV2-007 (b) — l'échec d'un tour agent se voit", () => {
  it("ok:false ⇒ job « failed »/« pending », jamais « done »", async () => {
    const core = await makeCore({ dataDir: tempDir(), keyStores: [testKeys], agentFails: "modèle injoignable" });
    const r = core.automation.create({ name: "x", trigger: { kind: "manual" }, actions: [{ type: "agent", prompt: "p" }] });
    await core.automation.run(r.id);
    const [job] = jobsAuto(core);
    expect(job!.status).not.toBe("done");
    expect(job!.lastError).toContain("modèle injoignable");
    await core.dispose();
  });
});

describe("AV2-007 (c) — l'action webhook n'est plus un faux « ok »", () => {
  it("action webhook ⇒ échec dit, aucun appel agent", async () => {
    const core = await makeCore({ dataDir: tempDir(), keyStores: [testKeys] });
    const r = core.automation.create({
      name: "w",
      trigger: { kind: "manual" },
      actions: [{ type: "webhook", url: "http://127.0.0.1:9/x", payload: {} }],
    });
    await core.automation.run(r.id);
    const [job] = jobsAuto(core);
    expect(job!.status).not.toBe("done");
    expect(job!.lastError).toContain("non implémentée");
    expect(core.schedules).toHaveLength(0);
    await core.dispose();
  });
});
