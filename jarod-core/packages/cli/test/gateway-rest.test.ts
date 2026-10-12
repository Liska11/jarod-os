// Passerelle compatible Hermes (essai) : les routes REST en lecture (planifications, mémoire). Traduction pure, puis le VRAI noyau
// (planificateur et mémoire réels, profil temporaire) lu par HTTP avec le jeton.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import { cronJobs, cronSchedule, memoryStatus, type ScheduleLike } from "../src/gateway/rest.js";
import { createGateway } from "../src/gateway/server.js";

const base: ScheduleLike = { id: "s1", name: "Bilan", prompt: "résume", spec: { kind: "interval", minutes: 30 }, enabled: true, lastRun: null, nextRun: 1_800_000_000_000, lastStatus: null };

describe("traduction des planifications", () => {
  it("rend chaque forme de règle dans le vocabulaire que lit le shell", () => {
    expect(cronSchedule({ kind: "interval", minutes: 15 })).toMatchObject({ kind: "interval", minutes: 15 });
    expect(cronSchedule({ kind: "cron", expr: "0 9 * * 1" })).toMatchObject({ kind: "cron", expr: "0 9 * * 1" });
    expect(cronSchedule({ kind: "daily", time: "07:05" })).toMatchObject({ kind: "cron", expr: "5 7 * * *" });
    expect(cronSchedule({ kind: "daily", time: "18:00", days: [5, 1] })).toMatchObject({ expr: "0 18 * * 1,5" });
    expect(cronSchedule({ kind: "once", at: Date.UTC(2030, 0, 2, 3, 4, 5) })).toMatchObject({ kind: "once", run_at: "2030-01-02T03:04:05.000Z" });
  });

  it("une planification coupée est « paused » et n'annonce plus de prochain passage", () => {
    const [on, off] = cronJobs([base, { ...base, id: "s2", enabled: false }]);
    expect(on).toMatchObject({ id: "s1", enabled: true, state: "scheduled", next_run_at: 1_800_000_000_000 });
    expect(off).toMatchObject({ id: "s2", enabled: false, state: "paused", next_run_at: null });
  });

  it("la mémoire n'expose que le nombre d'entrées", () => {
    expect(memoryStatus(3)).toEqual({ builtin_files: { memory: 3, user: 0 } });
  });
});

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("routes REST devant le vrai noyau", { timeout: 60_000 }, () => {
  it("sert les planifications et la mémoire réelles, avec le jeton, et refuse le reste", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarod-gw-rest-"));
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
    const get = (path: string, token: string | null = gw.token) =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { "x-hermes-session-token": token } : {} });

    expect((await get("/api/cron/jobs")).headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await (await get("/api/cron/jobs")).json()).toEqual([]);
    expect(await (await get("/api/memory")).json()).toEqual({ builtin_files: { memory: 0, user: 0 } });

    const saved = core.scheduler.save({ name: "Bilan du matin", prompt: "résume ma journée", spec: { kind: "interval", minutes: 60 } });
    core.memory.add("Je préfère les réponses courtes");
    core.memory.add("Mon dossier de travail est D:\\store");

    const jobs = (await (await get("/api/cron/jobs")).json()) as Record<string, any>[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: saved.id, name: "Bilan du matin", prompt: "résume ma journée", enabled: true, state: "scheduled", schedule: { kind: "interval", minutes: 60 } });
    expect(typeof jobs[0]!.next_run_at).toBe("number");
    expect(await (await get("/api/memory")).json()).toEqual({ builtin_files: { memory: 2, user: 0 } });

    // Sans le bon jeton, rien ; les écritures et les routes sans service restent non servies et consignées.
    expect((await get("/api/memory", null)).status).toBe(401);
    expect((await get("/api/memory", "mauvais")).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/memory`, { method: "POST", headers: { "x-hermes-session-token": gw.token }, body: "{}" })).status).toBe(404);
    expect((await get("/api/env")).status).toBe(404);
    expect(gw.unhandled()).toMatchObject({ "POST /api/memory": 1, "GET /api/env": 1 });
  });

  it("écritures des automatisations : créer, modifier, mettre en pause, reprendre, déclencher, supprimer — dans le vrai planificateur", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarod-gw-cron-"));
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
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { "x-hermes-session-token": gw.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: (await r.json()) as any };
    };

    // Créer (le corps exact que le shell envoie).
    const created = await call("POST", "/api/cron/jobs", { name: "Bilan du matin", schedule: "daily at 8:30am", prompt: "Résume ma journée", deliver: "local", no_agent: false });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Bilan du matin", prompt: "Résume ma journée", enabled: true, state: "scheduled", schedule: { kind: "cron", expr: "30 8 * * *" } });
    const id = created.body.id as string;
    expect(core.scheduler.get(id)?.spec).toEqual({ kind: "daily", time: "08:30" });

    // Refus nets, rien n'est créé : format inconnu, script seul, livraison vers une messagerie, compétences.
    const bad = await call("POST", "/api/cron/jobs", { name: "x", schedule: "whenever", prompt: "p" });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toMatch(/every 30m/);
    expect((await call("POST", "/api/cron/jobs", { name: "x", schedule: "every 5m", prompt: "p", no_agent: true })).status).toBe(400);
    expect((await call("POST", "/api/cron/jobs", { name: "x", schedule: "every 5m", prompt: "p", deliver: "telegram" })).status).toBe(400);
    expect((await call("POST", "/api/cron/jobs", { name: "x", schedule: "every 5m", prompt: "p", skills: ["a"] })).status).toBe(400);
    expect((await call("POST", "/api/cron/jobs", { name: "x", schedule: "every 5m", prompt: "   " })).status).toBe(400);
    expect(core.scheduler.list()).toHaveLength(1);

    // Modifier : seul ce qui est envoyé change.
    const edited = await call("PUT", `/api/cron/jobs/${id}`, { updates: { schedule: "every 2h", name: "Bilan" } });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id, name: "Bilan", prompt: "Résume ma journée", schedule: { kind: "interval", minutes: 120 } });
    expect((await call("PUT", `/api/cron/jobs/${id}`, { updates: { schedule: "nope" } })).status).toBe(400);
    expect(core.scheduler.get(id)?.spec).toEqual({ kind: "interval", minutes: 120 });
    expect((await call("PUT", "/api/cron/jobs/inconnu", { updates: { name: "z" } })).status).toBe(404);
    expect((await call("PUT", `/api/cron/jobs/${id}`, {})).status).toBe(400);

    // Pause puis reprise ; une modification ne réveille pas une planification en pause.
    const paused = await call("POST", `/api/cron/jobs/${id}/pause`);
    expect(paused.body).toMatchObject({ enabled: false, state: "paused", next_run_at: null });
    await call("PUT", `/api/cron/jobs/${id}`, { updates: { name: "Bilan 2" } });
    expect(core.scheduler.get(id)).toMatchObject({ name: "Bilan 2", enabled: false });
    const resumed = await call("POST", `/api/cron/jobs/${id}/resume`);
    expect(resumed.body).toMatchObject({ enabled: true, state: "scheduled" });
    expect(typeof resumed.body.next_run_at).toBe("number");

    // Historique : pas de conversation tant que rien n'a tourné.
    expect((await call("GET", `/api/cron/jobs/${id}/runs?limit=10`)).body).toEqual({ runs: [] });
    expect((await call("GET", "/api/cron/delivery-targets")).body).toEqual({ targets: [] });

    // « Run now » répond tout de suite ; l'issue (réussie ou non) se lit ensuite dans la liste.
    expect((await call("POST", `/api/cron/jobs/${id}/trigger`)).body).toEqual({ ok: true, status: "triggered" });
    const end = Date.now() + 20_000;
    while (!core.scheduler.get(id)?.lastStatus && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(core.scheduler.get(id)?.lastRun).not.toBeNull();
    expect(core.scheduler.get(id)?.lastStatus).toBeTruthy();
    expect((await call("POST", "/api/cron/jobs/inconnu/trigger")).status).toBe(404);

    // Supprimer.
    expect((await call("DELETE", `/api/cron/jobs/${id}`)).body).toEqual({ ok: true });
    expect(core.scheduler.list()).toHaveLength(0);
    expect((await call("DELETE", `/api/cron/jobs/${id}`)).status).toBe(404);
  });
});
