/**
 * SPECS-P5-UI-PARITE.md §1 — accord des outils : l'agent attend la réponse de l'utilisateur au lieu de refuser d'office.
 * VRAI kernel, VRAIS handlers ; fournisseur LLM = stub scripté. Fail-closed vérifié : arrêt, délai, identifiant inconnu.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createApprovalBroker } from "../src/main/handlers/approvals.js";
import { say, scripted, setupKernel, toolCall, until } from "./ui-parite-helpers.js";

afterEach(cleanup);

type Req = { id: string; runId: string; sessionId: string; tool: string; description: string; args: string; canAlways: boolean };
type Done = { id: string; runId: string; allowed: boolean; reason: string };
type Tool = { callId: string; status: string; result?: string };

/** Un noyau dont le modèle demande `write_file` dans un dossier de travail réel. */
async function writing(extraSettings: Record<string, unknown> = {}, confirmAnswers: boolean[] = [], rounds = 1) {
  const dir = realpathSync.native(tempDir());
  const script = Array.from({ length: rounds }, (_, i) => [toolCall(`call-${i + 1}`, "write_file", { path: "note.txt", content: "bonjour" }), say("Terminé.")]).flat();
  const stub = await scripted(script);
  const k = await setupKernel(stub.port, confirmAnswers);
  k.app.agent.settings.patch({ workspace: dir, ...extraSettings } as never);
  const send = (runId = "run-a") => k.call("send-message", "Écris la note", undefined, undefined, [], [], undefined, runId) as Promise<{ response: string; sessionId: string }>;
  const requests = () => k.on("tool-approval-request").map(([r]) => r as Req);
  const resolved = () => k.on("tool-approval-resolved").map(([r]) => r as Done);
  const toolEvents = () => k.on("chat-tool-event").map(([, e]) => e as Tool);
  return { ...k, stub, dir, send, requests, resolved, toolEvents, file: join(dir, "note.txt") };
}

describe("accord des outils (send-message → fenêtre → réponse)", () => {
  it("la demande porte l'outil, sa description et les arguments exacts ; « autoriser » exécute l'outil", async () => {
    const w = await writing();
    try {
      const turn = w.send();
      await until(() => w.requests().length === 1, "demande d'accord");
      const req = w.requests()[0]!;
      expect(req).toMatchObject({ runId: "run-a", tool: "write_file" });
      expect(req.description).toMatch(/fichier/i);
      expect(JSON.parse(req.args)).toEqual({ path: "note.txt", content: "bonjour" });
      expect(req.sessionId).toBeTruthy();
      expect(req.id).not.toBe("call-1"); // identifiant tiré au hasard, jamais le callId du modèle
      expect(w.call("tool-approval-pending")).toEqual([expect.objectContaining({ id: req.id, tool: "write_file" })]);
      expect(existsSync(w.file)).toBe(false); // rien n'a tourné avant la réponse

      expect(await w.call("tool-approval-respond", req.id, true)).toBe(true);
      expect((await turn).response).toBe("Terminé.");
      expect(readFileSync(w.file, "utf8")).toBe("bonjour");
      expect(w.resolved()).toEqual([{ id: req.id, runId: "run-a", allowed: true, reason: "answered" }]);
      expect(w.call("tool-approval-pending")).toEqual([]);
      expect(w.toolEvents().map((e) => e.status)).toEqual(["running", "completed"]);
    } finally {
      w.stub.close();
    }
  });

  it("« refuser » : l'outil n'a pas tourné, le modèle reçoit le refus", async () => {
    const w = await writing();
    try {
      const turn = w.send();
      await until(() => w.requests().length === 1, "demande d'accord");
      expect(await w.call("tool-approval-respond", w.requests()[0]!.id, false)).toBe(true);
      await turn;
      expect(existsSync(w.file)).toBe(false);
      expect(w.toolEvents().map((e) => e.status)).toEqual(["running", "failed"]);
      expect(w.toolEvents()[1]!.result).toMatch(/refusé/i);
      expect(w.resolved()[0]).toMatchObject({ allowed: false, reason: "answered" });
    } finally {
      w.stub.close();
    }
  });

  it("arrêt du tour pendant l'attente : demande close « stopped », rien n'est écrit, une réponse tardive ne fait rien", async () => {
    const w = await writing();
    try {
      const turn = w.send().catch((e: Error) => e);
      await until(() => w.requests().length === 1, "demande d'accord");
      const id = w.requests()[0]!.id;
      w.call("abort-chat", "run-a");
      await until(() => w.resolved().length === 1, "demande close");
      expect(w.resolved()[0]).toEqual({ id, runId: "run-a", allowed: false, reason: "stopped" });
      expect(await w.call("tool-approval-respond", id, true)).toBe(false); // trop tard : rien n'est accordé
      await turn;
      expect(existsSync(w.file)).toBe(false);
      expect(w.call("tool-approval-pending")).toEqual([]);
    } finally {
      w.stub.close();
    }
  });

  it("identifiant inconnu : false, sans effet ; arguments invalides : refus explicite", async () => {
    const w = await writing();
    try {
      expect(await w.call("tool-approval-respond", "inconnu", true)).toBe(false);
      await expect(Promise.resolve(w.call("tool-approval-respond", "x", "oui"))).rejects.toThrow(/attendu/);
      await expect(Promise.resolve(w.call("tool-approval-respond", 42, true))).rejects.toThrow(/attendu/);
      await expect(Promise.resolve(w.call("tool-approval-respond", "x", true, "oui"))).rejects.toThrow(/attendu/);
    } finally {
      w.stub.close();
    }
  });

  it("autoApproveTools : aucune demande, l'outil tourne (le réglage global reste le seul interrupteur)", async () => {
    const w = await writing({ autoApproveTools: true });
    try {
      await w.send();
      expect(w.requests()).toEqual([]);
      expect(readFileSync(w.file, "utf8")).toBe("bonjour");
    } finally {
      w.stub.close();
    }
  });
});

describe("« toujours autoriser »", () => {
  it("accepté (boîte native qui NOMME l'outil) : l'outil tourne, entre dans alwaysAllowTools, et l'appel suivant ne demande plus rien", async () => {
    const w = await writing({}, [true], 2);
    try {
      const first = w.send("run-a");
      await until(() => w.requests().length === 1, "demande d'accord");
      expect(w.requests()[0]!.canAlways).toBe(true);
      expect(await w.call("tool-approval-respond", w.requests()[0]!.id, true, true)).toBe(true);
      await first;
      expect(w.confirms).toHaveLength(1);
      expect(w.confirms[0]!.message).toMatch(/write_file/);
      expect(w.confirms[0]!.detail).toMatch(/SANS vous demander/);
      expect(w.app.agent.settings.get("alwaysAllowTools")).toEqual(["write_file"]);
      expect(readFileSync(w.file, "utf8")).toBe("bonjour");

      await w.send("run-b"); // même outil : plus de demande
      expect(w.requests()).toHaveLength(1);
      expect(w.toolEvents().filter((e) => e.status === "completed")).toHaveLength(2);
    } finally {
      w.stub.close();
    }
  });

  it("boîte native refusée : erreur claire, la demande RESTE ouverte, rien n'est enregistré ; on peut encore autoriser une fois", async () => {
    const w = await writing({}, [false]);
    try {
      const turn = w.send();
      await until(() => w.requests().length === 1, "demande d'accord");
      const id = w.requests()[0]!.id;
      await expect(Promise.resolve(w.call("tool-approval-respond", id, true, true))).rejects.toThrow(/refusé par l'utilisateur/);
      expect(w.app.agent.settings.get("alwaysAllowTools")).toEqual([]);
      expect(w.call("tool-approval-pending")).toHaveLength(1);
      expect(await w.call("tool-approval-respond", id, true)).toBe(true);
      await turn;
      expect(readFileSync(w.file, "utf8")).toBe("bonjour");
      expect(w.app.agent.settings.get("alwaysAllowTools")).toEqual([]);
    } finally {
      w.stub.close();
    }
  });

  it("« toujours » avec un refus : erreur ; la demande close pendant la boîte n'enregistre rien", async () => {
    const w = await writing({}, [true]);
    try {
      const turn = w.send().catch((e: Error) => e);
      await until(() => w.requests().length === 1, "demande d'accord");
      const id = w.requests()[0]!.id;
      await expect(Promise.resolve(w.call("tool-approval-respond", id, false, true))).rejects.toThrow(/ne va pas avec un refus/);
      w.call("abort-chat", "run-a");
      await turn;
      expect(await w.call("tool-approval-respond", id, true, true)).toBe(false);
      expect(w.app.agent.settings.get("alwaysAllowTools")).toEqual([]);
    } finally {
      w.stub.close();
    }
  });

  it("une règle « demander » du garde garde la main : canAlways faux, « toujours » refusé ; une description de garde interne aussi", async () => {
    const sent: unknown[][] = [];
    const tool = { dangerous: true, description: "Écrit un fichier" };
    let verdict = "allow";
    const ctx = {
      kernel: () => ({ agent: { tools: { get: () => tool }, gate: { decide: () => verdict }, settings: { get: () => [], set: () => {} } } }) as never,
      shell: { send: (...a: unknown[]) => void sent.push(a), confirm: async () => true } as never,
    };
    const { broker, handlers } = createApprovalBroker(ctx, 60_000);
    void broker.request("o1", "r", "s", { name: "write_file" }, "Écrit un fichier");
    expect(broker.list()[0]!.canAlways).toBe(true);
    verdict = "ask";
    void broker.request("o2", "r", "s", { name: "write_file" }, "Écrit un fichier");
    void broker.request("o3", "r", "s", { name: "write_file" }, "Programme demandé par le garde du shell");
    expect(broker.list().map((r) => r.canAlways)).toEqual([true, false, false]);
    for (const r of broker.list().slice(1)) await expect(handlers["tool-approval-respond"](r.id, true, true)).rejects.toThrow(/indisponible/);
    expect(broker.list()).toHaveLength(3); // refusé « toujours » : les demandes restent
    for (const o of ["o1", "o2", "o3"]) broker.cancel(o);
  });
});

describe("courtier d'accord (délai et propriété du tour)", () => {
  const fakeCtx = () => {
    const sent: [string, unknown][] = [];
    return { sent, ctx: { kernel: () => ({ agent: { tools: { get: () => undefined }, gate: undefined } }) as never, shell: { send: (c: string, p: unknown) => void sent.push([c, p]) } as never } };
  };

  it("sans réponse au bout du délai : refusé et retiré (fail-closed)", async () => {
    const { ctx, sent } = fakeCtx();
    const { broker } = createApprovalBroker(ctx, 25);
    expect(await broker.request("o1", "run", "s1", { name: "write_file", args: { path: "a" } }, "écrit")).toBe(false);
    expect(broker.list()).toEqual([]);
    expect(sent.map(([c]) => c)).toEqual(["tool-approval-request", "tool-approval-resolved"]);
    expect(sent[1]![1]).toMatchObject({ allowed: false, reason: "timeout" });
  });

  it("annuler un tour ne touche pas la demande d'un autre tour, même sous le même runId", async () => {
    const { ctx } = fakeCtx();
    const { broker, handlers } = createApprovalBroker(ctx, 60_000);
    const old = broker.request("tour-1", "run", "s", { name: "t" }, "d");
    const fresh = broker.request("tour-2", "run", "s", { name: "t" }, "d");
    broker.cancel("tour-1");
    expect(await old).toBe(false);
    expect(broker.list()).toHaveLength(1);
    expect(await handlers["tool-approval-respond"](broker.list()[0]!.id, true)).toBe(true);
    expect(await fresh).toBe(true);
  });

  it("arguments énormes : coupés dans la demande", () => {
    const { ctx, sent } = fakeCtx();
    const { broker } = createApprovalBroker(ctx, 60_000);
    void broker.request("o", "r", "s", { name: "t", args: { x: "y".repeat(20_000) } }, "d");
    const req = sent[0]![1] as { args: string };
    expect(req.args.length).toBeLessThan(4100);
    expect(req.args.endsWith("…")).toBe(true);
    broker.cancel("o");
  });
});
