/**
 * plugin-kanban (Q17) sur un vrai kernel (storage + kanban, base v17) : tableaux, cycle de vie calqué sur
 * Hermes, dépendances parent/enfant, exécution (réservation → fin de tour), reprise au démarrage.
 */
import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { KanbanError, type KanbanService, parseSpecifyReply, specifyPrompt } from "../src/index.js";

afterEach(cleanup);

const keys = memoryKeyStore();

async function boot(dataDir = tempDir()) {
  const app = (await bootApp({ storage: { dataDir, keyStores: [keys] }, kanban: {} })) as unknown as {
    kanban: KanbanService;
    storage: { db: { get<T>(sql: string, ...p: unknown[]): T | undefined; run(sql: string, ...p: unknown[]): unknown } };
  };
  return { app, kanban: app.kanban, db: app.storage.db, dataDir };
}

describe("plugin-kanban : tableaux", () => {
  it("« default » toujours présent et courant ; création, bascule, archivage, suppression en deux gestes", async () => {
    const { kanban } = await boot();
    expect(kanban.listBoards()).toEqual([{ slug: "default", name: "Default", description: null, icon: null, color: null, is_current: true, archived: false, total: 0, counts: {} }]);
    kanban.createBoard("Projet-X", "Projet X", true);
    expect(kanban.currentBoard()).toBe("projet-x");
    kanban.createBoard("projet-x"); // « mkdir -p » : existant gardé
    kanban.createBoard("atm10_server");
    expect(kanban.listBoards().map((b) => [b.slug, b.name, b.is_current])).toEqual([
      ["default", "Default", false],
      ["atm10_server", "Atm10 Server", false],
      ["projet-x", "Projet X", true],
    ]);
    expect(() => kanban.createBoard("pas bon")).toThrow(KanbanError);
    expect(() => kanban.switchBoard("inconnu")).toThrow(/Tableau inconnu/);
    expect(() => kanban.removeBoard("default")).toThrow(/ne peut pas être retiré/);

    kanban.createTask({ title: "dans X" });
    expect(() => kanban.removeBoard("projet-x", true)).toThrow(/archivez-le avant/);
    kanban.removeBoard("projet-x");
    expect(kanban.currentBoard()).toBe("default");
    expect(kanban.listBoards().map((b) => b.slug)).toEqual(["default", "atm10_server"]);
    expect(kanban.listBoards(true).find((b) => b.slug === "projet-x")).toMatchObject({ archived: true, total: 1, counts: { ready: 1 } });
    expect(() => kanban.switchBoard("projet-x")).toThrow(/archivé/);
    expect(() => kanban.createBoard("projet-x")).toThrow(/archivé porte déjà ce nom/);
    kanban.removeBoard("projet-x", true);
    expect(kanban.listBoards(true).map((b) => b.slug)).toEqual(["default", "atm10_server"]);
  });
});

describe("plugin-kanban : cycle de vie (sémantique Hermes)", () => {
  it("création : prête par défaut, triage sur demande, todo derrière un parent ouvert ; comptes par statut", async () => {
    const { kanban } = await boot();
    const a = kanban.createTask({ title: "  A  ", body: "corps", assignee: "default", priority: 5, skills: ["x", "x", " y "], maxRetries: 2 });
    const b = kanban.createTask({ title: "B", triage: true });
    const c = kanban.createTask({ title: "C", parents: [a] });
    expect(kanban.getTaskRow(a)).toMatchObject({ title: "A", status: "ready", priority: 5, skills: ["x", "y"], max_retries: 2, workspace_kind: "scratch", workspace_path: null });
    expect(kanban.getTaskRow(b)!.status).toBe("triage");
    expect(kanban.getTaskRow(c)!.status).toBe("todo");
    expect(kanban.getTask(c).events.map((e) => e.kind)).toEqual(["created", "dependency_wait"]);
    expect(kanban.getTask(a).children).toEqual([c]);
    expect(kanban.getTask(c).parents).toEqual([a]);
    expect(kanban.listBoards()[0]).toMatchObject({ total: 3, counts: { ready: 1, triage: 1, todo: 1 } });
    expect(kanban.listTasks().map((t) => t.id)).toEqual([a, b, c]); // priorité puis ancienneté
    expect(kanban.listTasks({ status: "todo" }).map((t) => t.id)).toEqual([c]);
    expect(() => kanban.createTask({ title: "  " })).toThrow(/titre est obligatoire/);
    expect(() => kanban.createTask({ title: "x", parents: ["t_absent"] })).toThrow(/parente inconnue/);
  });

  it("promote refusé derrière un parent ouvert ; terminer le parent libère l'enfant ; archiver aussi", async () => {
    const { kanban } = await boot();
    const p = kanban.createTask({ title: "parent" });
    const c = kanban.createTask({ title: "enfant", parents: [p] });
    expect(() => kanban.promote(c)).toThrow(/parents non terminés \(t_/);
    expect(() => kanban.complete(c)).toThrow(/n'est possible que depuis/);
    kanban.complete(p, "  fait  ");
    expect(kanban.getTaskRow(p)).toMatchObject({ status: "done", result: "fait" });
    expect(kanban.getTaskRow(c)!.status).toBe("ready");
    expect(kanban.getTask(c).events.at(-1)!.kind).toBe("promoted");

    const p2 = kanban.createTask({ title: "parent 2" });
    const c2 = kanban.createTask({ title: "enfant 2", parents: [p2] });
    kanban.archive(p2);
    expect(kanban.getTaskRow(c2)!.status).toBe("ready");
    expect(() => kanban.archive(p2)).toThrow(/déjà archivée/);
    expect(kanban.listTasks().map((t) => t.id)).not.toContain(p2);
    expect(kanban.listTasks({ includeArchived: true }).map((t) => t.id)).toContain(p2);
  });

  it("bloquer / débloquer / planifier / assigner / commenter / spécifier", async () => {
    const { kanban } = await boot();
    const t = kanban.createTask({ title: "t" });
    kanban.block(t, " attend une réponse ");
    expect(kanban.getTaskRow(t)!.status).toBe("blocked");
    expect(kanban.getTask(t).events.at(-1)).toMatchObject({ kind: "blocked", payload: { reason: "attend une réponse", source_status: "ready" } });
    kanban.unblock(t);
    expect(kanban.getTaskRow(t)!.status).toBe("ready");
    kanban.schedule(t);
    expect(kanban.getTaskRow(t)!.status).toBe("scheduled");
    expect(() => kanban.promote(t)).toThrow(/n'est possible que depuis/);
    kanban.unblock(t);
    kanban.assign(t, "default");
    kanban.assign(t, "none");
    expect(kanban.getTaskRow(t)!.assignee).toBeNull();
    expect(kanban.getTask(t).events.filter((e) => e.kind === "assigned").map((e) => e.payload)).toEqual([
      { assignee: "default", from: null },
      { assignee: null, from: "default" },
    ]);
    kanban.comment(t, "  premier  ", "moi");
    expect(() => kanban.comment(t, "   ")).toThrow(/Commentaire vide/);
    expect(kanban.getTask(t).comments).toMatchObject([{ author: "moi", body: "premier" }]);

    const idea = kanban.createTask({ title: "idée", triage: true });
    expect(kanban.specify(idea, { title: "Faire la chose", body: "**Objectif** — x" }, "default")).toEqual(["title", "body"]);
    const d = kanban.getTask(idea);
    expect(d.task).toMatchObject({ title: "Faire la chose", body: "**Objectif** — x", status: "ready" }); // todo → ready (aucun parent)
    expect(d.comments[0]!.body).toMatch(/^Spécifiée — title, body mis à jour/);
    expect(d.events.map((e) => e.kind)).toEqual(["created", "specified", "promoted"]);
    expect(() => kanban.specify(idea, {})).toThrow(/seule une tâche « triage »/);
  });
});

describe("plugin-kanban : exécution (tour d'agent déclenché à la main)", () => {
  it("plan : prête + assignée au profil servi ; une seule par répartition ; raisons des autres", async () => {
    const { kanban } = await boot();
    const none = kanban.createTask({ title: "sans assigné", priority: 9 });
    const other = kanban.createTask({ title: "autre profil", assignee: "pro", priority: 8 });
    const mine = kanban.createTask({ title: "la mienne", assignee: "default", priority: 5 });
    const next = kanban.createTask({ title: "la suivante", assignee: "default" });
    const plan = kanban.dispatchPlan("default");
    expect(plan.task?.id).toBe(mine);
    expect(plan.skipped).toEqual([
      { task_id: none, reason: "non assignée" },
      { task_id: other, reason: "assignée au profil « pro », non servi (profil servi : « default »)" },
      { task_id: next, reason: "une tâche par répartition (déclenchée à la main)" },
    ]);
  });

  it("réservation → running (aucune autre transition) → fin de tour : réponse = review, erreur = blocked ; reprise", async () => {
    const { kanban, db } = await boot();
    db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'tour', 1, 1), ('s2', 'tour', 1, 1), ('s3', 'tour', 1, 1)");
    const t = kanban.createTask({ title: "t", assignee: "default" });
    const run = kanban.claim(t, "default", "s1");
    expect(kanban.getTaskRow(t)).toMatchObject({ status: "running", current_run_id: run, session_id: "s1" });
    for (const f of [() => kanban.block(t), () => kanban.complete(t), () => kanban.archive(t), () => kanban.assign(t, "x"), () => kanban.schedule(t)])
      expect(f).toThrow(/en cours d'exécution/);
    expect(() => kanban.claim(t, "default", "s1")).toThrow(/seule une tâche prête/);
    expect(kanban.finishRun(run, { text: "  compte rendu  " })).toBe("review");
    expect(kanban.getTaskRow(t)).toMatchObject({ status: "review", result: "compte rendu", current_run_id: null });
    expect(kanban.getTask(t).runs).toMatchObject([{ id: run, status: "done", outcome: "completed", summary: "compte rendu", session_id: "s1" }]);
    expect(kanban.getTask(t).latest_summary).toBe("compte rendu");
    expect(kanban.finishRun(run, { text: "encore" })).toBeNull(); // plus la courante
    kanban.complete(t);
    expect(kanban.getTaskRow(t)!.status).toBe("done");

    const u = kanban.createTask({ title: "u", assignee: "default" });
    const r2 = kanban.claim(u, "default", "s2");
    expect(kanban.finishRun(r2, { text: "", error: "fournisseur injoignable" })).toBe("blocked");
    expect(kanban.getTask(u).events.at(-1)).toMatchObject({ kind: "blocked", payload: { reason: "fournisseur injoignable", kind: "turn_failed" }, run_id: r2 });
    kanban.unblock(u);
    const r3 = kanban.claim(u, "default", "s3");
    expect(kanban.reclaim(u, "trop long")).toEqual({ sessionId: "s3" });
    expect(kanban.getTaskRow(u)).toMatchObject({ status: "ready", current_run_id: null });
    expect(kanban.getTask(u).runs.at(-1)).toMatchObject({ id: r3, status: "reclaimed", error: "reprise manuelle : trop long" });
    expect(kanban.finishRun(r3, { text: "trop tard" })).toBeNull();
    expect(kanban.getTaskRow(u)!.status).toBe("ready");
    expect(() => kanban.reclaim(u)).toThrow(/rien à reprendre/);
    // Une réponse vide est un échec (rien à relire).
    const r4 = kanban.claim(u, "default", "s3");
    expect(kanban.finishRun(r4, { text: "   " })).toBe("blocked");
  });

  it("au démarrage : une tâche restée « running » (arrêt pendant le tour) redevient prête, exécution close « crashed »", async () => {
    const dataDir = tempDir();
    const first = await boot(dataDir);
    first.db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'tour', 1, 1)");
    const t = first.kanban.createTask({ title: "t", assignee: "default" });
    const run = first.kanban.claim(t, "default", "s1");
    await shutdown(first.app as never);
    const again = await boot(dataDir);
    expect(again.kanban.getTaskRow(t)).toMatchObject({ status: "ready", current_run_id: null });
    expect(again.kanban.getTask(t).runs).toMatchObject([{ id: run, status: "crashed", error: "interrompue par l'arrêt de Jarod" }]);
    expect(again.kanban.getTask(t).events.at(-1)!.kind).toBe("crashed");
  });

  it("message du tour : carte, skills, dossier, résultats des parents, commentaires", async () => {
    const { kanban } = await boot();
    const p = kanban.createTask({ title: "parent" });
    kanban.complete(p, "résultat du parent");
    const t = kanban.createTask({ title: "Écrire le rapport", body: "Détails.", skills: ["rédaction"], workspacePath: "S:\\travail", parents: [p] });
    kanban.comment(t, "en français", "moi");
    const prompt = kanban.workerPrompt(t);
    expect(prompt).toContain(`Tâche du tableau Kanban « default » (${t}) : Écrire le rapport`);
    expect(prompt).toContain("Détails.");
    expect(prompt).toContain("Skills demandés : rédaction");
    expect(prompt).toContain("Dossier de travail : S:\\travail");
    expect(prompt).toContain(`- ${p} « parent » : résultat du parent`);
    expect(prompt).toContain("- moi : en français");
  });
});

describe("plugin-kanban : spécification (réponse du LLM)", () => {
  it("objet JSON (même entouré d'un bloc de code) ; sinon la réponse entière devient le corps ; vide = échec", () => {
    expect(parseSpecifyReply('```json\n{"title": " T ", "body": "**Objectif** — x"}\n```')).toEqual({ title: "T", body: "**Objectif** — x" });
    expect(parseSpecifyReply("Juste du texte.")).toEqual({ title: null, body: "Juste du texte." });
    expect(parseSpecifyReply('{"title": "", "body": ""}')).toBeNull();
    expect(parseSpecifyReply("   ")).toBeNull();
    expect(specifyPrompt({ id: "t_1", title: "idée", body: null })).toBe("Tâche : t_1\nTitre actuel : idée\nCorps actuel :\n(pas de corps)\n");
  });
});
