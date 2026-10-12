// Q19-3 (b) — livraison d'une tâche planifiée : la CIBLE est confirmée à la création (sauf le chat d'origine), et
// chaque envoi automatique laisse une ligne d'audit. Un kernel réel ; l'outil `cronjob` est appelé tel que le garde le fait.
import type { ChatResult, ProviderClient, ToolCall } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { makeCore, type TestCore } from "./helpers.js";

/** La conversation `sessionId` vient du chat Telegram `chatId` (origine de la tâche). */
function fromTelegram(core: TestCore, chatId: string): string {
  const sessionId = core.sessions.create("depuis Telegram").id;
  core.db.run("INSERT INTO gateway_chats (gateway, chat_id, session_id) VALUES (?, ?, ?)", "telegram", chatId, sessionId);
  return sessionId;
}

function harness(core: TestCore) {
  const asked: { call: ToolCall; description: string }[] = [];
  const cron = core.tools.get("cronjob")!;
  const run = (args: Record<string, unknown>, sessionId: string, answer: boolean | "sans-porte") =>
    cron.run(args, {
      sessionId,
      workspace: null,
      ...(answer === "sans-porte"
        ? {}
        : {
            approve: async (_sid: string, call: ToolCall, description: string) => {
              asked.push({ call, description });
              return answer;
            },
          }),
    });
  return { asked, run };
}

const BASE = { action: "create", name: "rapport", prompt: "résume le dépôt", every_minutes: 60 };

describe("Q19-3 (b) — le destinataire d'une tâche planifiée est confirmé à la création", () => {
  it("le chat d'origine n'a rien à confirmer : par défaut, `here`, ou le même chat écrit à la main (casse ignorée)", async () => {
    const core = await makeCore();
    const { asked, run } = harness(core);
    const session = fromTelegram(core, "chat-1");
    await run(BASE, session, false); // même refusant : aucun accord n'est demandé
    await run({ ...BASE, name: "b", deliver: "here" }, session, false);
    await run({ ...BASE, name: "c", deliver: "telegram:CHAT-1" }, session, false);
    expect(asked).toEqual([]);
    expect(core.scheduler.list().map((s) => s.deliver)).toEqual([
      { gateway: "telegram", chatId: "chat-1" },
      { gateway: "telegram", chatId: "chat-1" },
      { gateway: "telegram", chatId: "CHAT-1" },
    ]);
  });

  it("un autre destinataire (e-mail, autre chat) demande l'accord nommé ; accordé, la tâche est enregistrée avec cette cible", async () => {
    const core = await makeCore();
    const { asked, run } = harness(core);
    const session = fromTelegram(core, "chat-1");
    await run({ ...BASE, deliver: "email:paul@exemple.fr" }, session, true);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.call).toMatchObject({ name: "cronjob/deliver", args: { task: "rapport", gateway: "email", chatId: "paul@exemple.fr" } });
    expect(asked[0]!.description).toContain("email:paul@exemple.fr");
    expect(asked[0]!.description).toContain("telegram:chat-1"); // dit aussi d'où elle vient
    expect(core.scheduler.list()[0]!.deliver).toEqual({ gateway: "email", chatId: "paul@exemple.fr" });
  });

  it("refus, ou aucune porte d'accord (passerelle, tâche, sous-agent) : la tâche n'est PAS enregistrée", async () => {
    const core = await makeCore();
    const { asked, run } = harness(core);
    const session = fromTelegram(core, "chat-1");
    await expect(run({ ...BASE, deliver: "whatsapp:+33600000000" }, session, false)).rejects.toThrow(/non confirmée/);
    await expect(run({ ...BASE, deliver: "telegram:autre-chat" }, session, "sans-porte")).rejects.toThrow(/non confirmée/);
    expect(asked).toHaveLength(1); // le premier a demandé et essuyé un refus ; le second n'avait pas de porte
    expect(core.scheduler.list()).toEqual([]);
  });

  it("depuis une conversation sans origine (bureau) : une cible explicite est confirmée, `none` et l'absence de cible non", async () => {
    const core = await makeCore();
    const { asked, run } = harness(core);
    const desk = core.sessions.create("bureau").id;
    await run({ ...BASE, name: "a" }, desk, false);
    await run({ ...BASE, name: "b", deliver: "none" }, desk, false);
    expect(asked).toEqual([]);
    expect(core.scheduler.list().map((s) => s.deliver)).toEqual([null, null]);
    await run({ ...BASE, name: "c", deliver: "discord:12345" }, desk, true);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.description).not.toContain("chat d'origine");
    expect(core.scheduler.list().find((s) => s.name === "c")!.deliver).toEqual({ gateway: "discord", chatId: "12345" });
  });

  it("changer la cible d'une tâche existante demande le même accord ; pause, reprise et mise à jour sans cible n'en demandent pas", async () => {
    const core = await makeCore();
    const { asked, run } = harness(core);
    const session = fromTelegram(core, "chat-1");
    await run(BASE, session, false);
    const id = core.scheduler.list()[0]!.id;
    await expect(run({ action: "update", id, deliver: "email:x@y.z" }, session, false)).rejects.toThrow(/non confirmée/);
    expect(core.scheduler.get(id)!.deliver).toEqual({ gateway: "telegram", chatId: "chat-1" }); // inchangée
    expect(asked).toHaveLength(1);

    await run({ action: "update", id, name: "renommée" }, session, false);
    await run({ action: "pause", id }, session, false);
    await run({ action: "resume", id }, session, false);
    expect(asked).toHaveLength(1);
    expect(core.scheduler.get(id)).toMatchObject({ name: "renommée", deliver: { gateway: "telegram", chatId: "chat-1" } });

    await run({ action: "update", id, deliver: "email:x@y.z" }, session, true);
    expect(core.scheduler.get(id)!.deliver).toEqual({ gateway: "email", chatId: "x@y.z" });
    expect(asked).toHaveLength(2);
  });
});

describe("Q19-3 (b) — chaque envoi automatique d'une tâche laisse une ligne d'audit", () => {
  function reply(core: TestCore, text: string): void {
    const client: ProviderClient = {
      listModels: async () => ["m"],
      chat: async (_req, h) => {
        h.onText?.(text);
        return { text, thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1 } satisfies ChatResult;
      },
    };
    core.providers.client = () => client;
    core.settings.set("autoTitle", false);
  }

  it("envoi réussi : la CIBLE est journalisée (jamais le texte envoyé), décision « automatique », ok", async () => {
    const core = await makeCore();
    reply(core, "contenu-confidentiel-du-rapport");
    const sent: { chatId: string; text: string }[] = [];
    core.gateways.set("telegram", { send: async (chatId, text) => void sent.push({ chatId, text }), sendFile: async () => {} });
    const sch = core.scheduler.save({ name: "rapport", prompt: "go", spec: { kind: "interval", minutes: 60 }, deliver: { gateway: "telegram", chatId: "chat-9" } });
    await core.runSchedule(sch);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("contenu-confidentiel-du-rapport");
    const line = core.auditLog().find((a) => a.tool === "schedule/deliver")!;
    expect(line).toMatchObject({ decision: "automatique", ok: true });
    expect(JSON.parse(line.args)).toEqual({ schedule: sch.id, name: "rapport", gateway: "telegram", chatId: "chat-9" });
    expect(line.args).not.toContain("contenu-confidentiel");
  });

  it("envoi impossible (passerelle absente) : la ligne d'audit dit ok = false", async () => {
    const core = await makeCore();
    reply(core, "résultat");
    const sch = core.scheduler.save({ name: "rapport", prompt: "go", spec: { kind: "interval", minutes: 60 }, deliver: { gateway: "email", chatId: "a@b.c" } });
    const r = await core.runSchedule(sch);
    expect(r.ok).toBe(false);
    expect(core.auditLog().filter((a) => a.tool === "schedule/deliver")).toMatchObject([{ decision: "automatique", ok: false }]);
  });

  it("une tâche sans livraison n'écrit aucune ligne d'envoi", async () => {
    const core = await makeCore();
    reply(core, "résultat");
    const sch = core.scheduler.save({ name: "muette", prompt: "go", spec: { kind: "interval", minutes: 60 } });
    await core.runSchedule(sch);
    expect(core.auditLog().filter((a) => a.tool === "schedule/deliver")).toEqual([]);
  });
});
