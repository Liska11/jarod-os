/**
 * SPECS-P5-UI-PARITE.md § 8.3 / § 8.4 — la portée « cette conversation » de l'accord des outils, et son interaction avec `autoApproveTools`.
 * Barres AS1 à AS9 figées dans la spec AVANT le code. VRAI noyau, VRAIS handlers, fournisseur LLM = stub scripté (comme `approvals.test.ts`).
 */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createApprovalBroker } from "../src/main/handlers/approvals.js";
import { say, scripted, setupKernel, toolCall, until } from "./ui-parite-helpers.js";

afterEach(cleanup);

type Req = { id: string; runId: string; sessionId: string; tool: string; description: string; args: string; canAlways: boolean };
type Done = { id: string; runId: string; allowed: boolean; reason: string };
type Tool = { callId: string; status: string };

/** Un noyau dont le modèle redemande `write_file` à chaque tour (`rounds` tours). */
async function writing(rounds: number) {
  const dir = realpathSync.native(tempDir());
  const script = Array.from({ length: rounds }, (_, i) => [toolCall(`call-${i + 1}`, "write_file", { path: "note.txt", content: `v${i + 1}` }), say("Terminé.")]).flat();
  const stub = await scripted(script);
  const k = await setupKernel(stub.port, []);
  k.app.agent.settings.patch({ workspace: dir } as never);
  const send = (runId: string, resume?: string) => k.call("send-message", "Écris la note", undefined, resume, [], [], undefined, runId) as Promise<{ response: string; sessionId: string }>;
  const requests = () => k.on("tool-approval-request").map(([r]) => r as Req);
  const resolved = () => k.on("tool-approval-resolved").map(([r]) => r as Done);
  const toolEvents = () => k.on("chat-tool-event").map(([, e]) => e as Tool);
  const respond = (id: string, allow: boolean, scope?: unknown) => Promise.resolve(k.call("tool-approval-respond", id, allow, ...(scope === undefined ? [] : [scope])));
  return { ...k, stub, dir, send, requests, resolved, toolEvents, respond, file: join(dir, "note.txt") };
}

describe("« cette conversation » (noyau réel)", () => {
  it("AS1, AS2, AS6, AS7 : la conversation ne redemande plus ; une AUTRE redemande ; rien d'écrit dans les réglages ni de boîte native ; « Tout retirer » redemande", async () => {
    const w = await writing(4);
    try {
      const before = JSON.stringify(await w.call("get-jarod-settings"));
      const first = w.send("run-a");
      await until(() => w.requests().length === 1, "1re demande");
      expect(w.requests()[0]!.canAlways).toBe(true);
      expect(await w.respond(w.requests()[0]!.id, true, "session")).toBe(true);
      const { sessionId } = await first;
      expect(readFileSync(w.file, "utf8")).toBe("v1");
      // (AS6) rien de persistant : réglages identiques, aucune boîte native
      expect(JSON.stringify(await w.call("get-jarod-settings"))).toBe(before);
      expect(w.app.agent.settings.get("alwaysAllowTools")).toEqual([]);
      expect(w.confirms).toHaveLength(0);
      expect(await w.call("tool-approval-grants")).toEqual({ session: 1 });

      // (AS1) même conversation : l'appel suivant passe SANS fenêtre
      await w.send("run-b", sessionId);
      expect(w.requests()).toHaveLength(1);
      expect(readFileSync(w.file, "utf8")).toBe("v2");
      expect(w.toolEvents().filter((e) => e.status === "completed")).toHaveLength(2);

      // (AS2) une AUTRE conversation redemande
      const third = w.send("run-c");
      await until(() => w.requests().length === 2, "demande d'une autre conversation");
      expect(w.requests()[1]!.sessionId).not.toBe(sessionId);
      expect(await w.respond(w.requests()[1]!.id, false)).toBe(true);
      await third;
      expect(readFileSync(w.file, "utf8")).toBe("v2"); // refusé : rien d'écrit

      // (AS7) « Tout retirer » : la conversation redemande
      expect(await w.call("tool-approval-grants-clear")).toBe(1);
      expect(await w.call("tool-approval-grants")).toEqual({ session: 0 });
      const fourth = w.send("run-d", sessionId);
      await until(() => w.requests().length === 3, "demande après retrait");
      expect(await w.respond(w.requests()[2]!.id, false)).toBe(true);
      await fourth;
    } finally {
      w.stub.close();
    }
  });

  it("AS8 : allumer autoApproveTools PENDANT une demande ouverte ne la résout pas ; elle reste répondable", async () => {
    const w = await writing(1);
    try {
      const turn = w.send("run-a");
      await until(() => w.requests().length === 1, "demande");
      w.app.agent.settings.patch({ autoApproveTools: true } as never);
      await new Promise((r) => setTimeout(r, 150));
      expect(w.call("tool-approval-pending")).toHaveLength(1);
      expect(w.resolved()).toEqual([]);
      expect(() => readFileSync(w.file, "utf8")).toThrow(); // rien n'a été écrit à son insu
      expect(await w.respond(w.requests()[0]!.id, false)).toBe(true);
      await turn;
      expect(w.resolved()).toEqual([expect.objectContaining({ allowed: false, reason: "answered" })]);
      expect(() => readFileSync(w.file, "utf8")).toThrow();
    } finally {
      w.stub.close();
    }
  });
});

describe("« cette conversation » (courtier, garde et validation)", () => {
  const tool = { dangerous: true, description: "Écrit un fichier" };
  const make = (verdict: () => string = () => "allow") => {
    const sent: [string, unknown][] = [];
    const ctx = {
      kernel: () => ({ agent: { tools: { get: () => tool }, gate: { decide: verdict }, settings: { get: () => [], set: () => {} } } }) as never,
      shell: { send: (c: string, p: unknown) => void sent.push([c, p]), confirm: async () => true } as never,
    };
    return { sent, ...createApprovalBroker(ctx, 60_000) };
  };
  const D = "Écrit un fichier";

  it("AS3 : un AUTRE outil de la même conversation redemande", async () => {
    const { broker, handlers } = make();
    const first = broker.request("o1", "r", "s1", { name: "write_file" }, D);
    expect(await handlers["tool-approval-respond"](broker.list()[0]!.id, true, "session")).toBe(true);
    expect(await first).toBe(true);
    expect(await broker.request("o2", "r", "s1", { name: "write_file" }, D)).toBe(true); // même outil, même conversation
    void broker.request("o3", "r", "s1", { name: "edit_file" }, D); // autre outil
    expect(broker.list().map((r) => r.tool)).toEqual(["edit_file"]);
    broker.cancel("o3");
  });

  it("AS4 : refusé quand « conversation » n'a pas de sens (règle « demander », garde interne) ; rien n'est accordé", async () => {
    let verdict = "allow";
    const { broker, handlers } = make(() => verdict);
    void broker.request("o1", "r", "s1", { name: "write_file" }, D);
    verdict = "ask";
    void broker.request("o2", "r", "s1", { name: "write_file" }, D);
    void broker.request("o3", "r", "s1", { name: "write_file" }, "Programme demandé par le garde du shell");
    expect(broker.list().map((r) => r.canAlways)).toEqual([true, false, false]);
    for (const r of broker.list().slice(1)) await expect(handlers["tool-approval-respond"](r.id, true, "session")).rejects.toThrow(/indisponible/);
    expect(broker.list()).toHaveLength(3);
    expect(handlers["tool-approval-grants"]()).toEqual({ session: 0 });
    for (const o of ["o1", "o2", "o3"]) broker.cancel(o);
  });

  it("AS4 bis : une règle « demander » posée APRÈS l'accord reprend la main (l'accord n'est jamais rejoué sans réévaluation)", async () => {
    let verdict = "allow";
    const { broker, handlers } = make(() => verdict);
    const first = broker.request("o1", "r", "s1", { name: "write_file" }, D);
    await handlers["tool-approval-respond"](broker.list()[0]!.id, true, "session");
    await first;
    verdict = "ask";
    void broker.request("o2", "r", "s1", { name: "write_file" }, D);
    expect(broker.list()).toHaveLength(1); // la fenêtre s'affiche
    broker.cancel("o2");
  });

  it("AS5 : portée invalide, ou « conversation » avec un refus, ou sans conversation : erreur, rien d'accordé, la demande reste ouverte", async () => {
    const { broker, handlers } = make();
    void broker.request("o1", "r", "s1", { name: "write_file" }, D);
    void broker.request("o2", "r", "", { name: "write_file" }, D);
    const [a, b] = broker.list();
    for (const bad of ["forever", "SESSION", 1, null, {}, ["session"]]) await expect(handlers["tool-approval-respond"](a!.id, true, bad)).rejects.toThrow(/attendu/);
    await expect(handlers["tool-approval-respond"](a!.id, false, "session")).rejects.toThrow(/ne va pas avec un refus/);
    await expect(handlers["tool-approval-respond"](b!.id, true, "session")).rejects.toThrow(/conversation inconnue/);
    expect(broker.list()).toHaveLength(2);
    expect(handlers["tool-approval-grants"]()).toEqual({ session: 0 });
    for (const o of ["o1", "o2"]) broker.cancel(o);
  });

  it("AS9 : un courtier neuf (redémarrage) ne connaît aucun accord de conversation", async () => {
    const a = make();
    const first = a.broker.request("o1", "r", "s1", { name: "write_file" }, D);
    await a.handlers["tool-approval-respond"](a.broker.list()[0]!.id, true, "session");
    await first;
    expect(a.handlers["tool-approval-grants"]()).toEqual({ session: 1 });
    const b = make(); // après un redémarrage : mémoire neuve
    expect(b.handlers["tool-approval-grants"]()).toEqual({ session: 0 });
    void b.broker.request("o1", "r", "s1", { name: "write_file" }, D);
    expect(b.broker.list()).toHaveLength(1); // la fenêtre s'affiche
    b.broker.cancel("o1");
  });

  it("(id, true, false) vaut une seule fois et ne retient rien ; (id, true, true) reste « toujours » (couvert par approvals.test.ts)", async () => {
    const { broker, handlers } = make();
    const once = broker.request("o1", "r", "s1", { name: "write_file" }, D);
    expect(await handlers["tool-approval-respond"](broker.list()[0]!.id, true, false)).toBe(true);
    expect(await once).toBe(true);
    expect(handlers["tool-approval-grants"]()).toEqual({ session: 0 });
    void broker.request("o2", "r", "s1", { name: "write_file" }, D);
    expect(broker.list()).toHaveLength(1); // « une fois » n'a rien retenu
    broker.cancel("o2");
  });
});
