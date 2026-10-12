// SPECS-P5-ACP.md §3 : correspondance PURE événements de l'agent → mises à jour ACP, et prompt de l'éditeur → texte.
// Les formes sont vérifiées au COMPILE contre les types du SDK ACP 1.5.0 (dépendance de test) : une dérive de schéma casse `tsc`.
import type { RequestPermissionRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import type { Message, ToolCall } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import {
  type AcpUpdate,
  MAX_TOOL_OUTPUT_CHARS,
  mapAgentEvent,
  promptToText,
  redactArgs,
  toolCallStart,
  toolKindOf,
  toolTitle,
  UnsupportedPromptError,
} from "../src/acp-events.js";

// Assemblé à l'exécution : le garde du dépôt refuse la FORME d'une clé dans un fichier suivi.
const KEY = ["sk", "CANARI-ACP-0123456789abcdef0123"].join("-");
const S = "s1";
const toolMsg = (over: Partial<Message> = {}): Message => ({ id: "m", sessionId: S, role: "tool", content: "ok", toolCallId: "c1", toolName: "read_file", createdAt: 1, ...over }) as Message;
const call = (over: Partial<ToolCall> = {}): ToolCall => ({ id: "c1", name: "read_file", args: { path: "src/a.ts" }, ...over });

describe("mapAgentEvent : texte et réflexion", () => {
  it("delta.text → agent_message_chunk ; delta.thinking → agent_thought_chunk ; les deux dans un même delta → deux mises à jour, réflexion d'abord", () => {
    expect(mapAgentEvent({ type: "delta", sessionId: S, streamId: "x", text: "Bonjour" })).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Bonjour" } },
    ]);
    expect(mapAgentEvent({ type: "delta", sessionId: S, streamId: "x", thinking: "je réfléchis" })).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "je réfléchis" } },
    ]);
    expect(mapAgentEvent({ type: "delta", sessionId: S, streamId: "x", thinking: "a", text: "b" }).map((u) => u.sessionUpdate)).toEqual([
      "agent_thought_chunk",
      "agent_message_chunk",
    ]);
  });

  it("un delta vide ne produit rien ; le texte est expurgé", () => {
    expect(mapAgentEvent({ type: "delta", sessionId: S, streamId: "x" })).toEqual([]);
    expect(mapAgentEvent({ type: "delta", sessionId: S, streamId: "x", text: "" })).toEqual([]);
    const [u] = mapAgentEvent({ type: "delta", sessionId: S, streamId: "x", text: `voici ${KEY}` });
    expect(JSON.stringify(u)).not.toContain("CANARI-ACP");
  });
});

describe("mapAgentEvent : appels d'outils", () => {
  it("tool-start → tool_call « pending » avec genre, titre lisible et arguments expurgés", () => {
    const [u] = mapAgentEvent({ type: "tool-start", sessionId: S, call: call({ args: { path: "src/a.ts", note: KEY } }) });
    expect(u).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "c1", kind: "read", status: "pending", title: "read_file : src/a.ts" });
    expect(JSON.stringify(u)).not.toContain("CANARI-ACP");
  });

  it("message d'outil → tool_call_update completed ; isError → failed ; le contenu est tronqué à la borne", () => {
    const [ok] = mapAgentEvent({ type: "message", sessionId: S, message: toolMsg({ content: "résultat" }) });
    expect(ok).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "résultat" } }] });
    const [bad] = mapAgentEvent({ type: "message", sessionId: S, message: toolMsg({ isError: true, content: "boum" }) });
    expect(bad).toMatchObject({ status: "failed" });
    const [big] = mapAgentEvent({ type: "message", sessionId: S, message: toolMsg({ content: "é".repeat(50_000) }) }) as Extract<AcpUpdate, { sessionUpdate: "tool_call_update" }>[];
    const t = big!.content[0]!.content.text;
    expect(t.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS + 20);
    expect(t).toMatch(/tronqué/);
  });

  it("la sortie d'un outil est expurgée", () => {
    const [u] = mapAgentEvent({ type: "message", sessionId: S, message: toolMsg({ content: `fichier .env : ${KEY}` }) });
    expect(JSON.stringify(u)).not.toContain("CANARI-ACP");
  });

  it("les messages user/assistant sont ignorés (leur texte est déjà parti en morceaux) ; un message d'outil sans toolCallId aussi", () => {
    expect(mapAgentEvent({ type: "message", sessionId: S, message: { ...toolMsg(), role: "assistant" } as Message })).toEqual([]);
    expect(mapAgentEvent({ type: "message", sessionId: S, message: { ...toolMsg(), role: "user" } as Message })).toEqual([]);
    expect(mapAgentEvent({ type: "message", sessionId: S, message: toolMsg({ toolCallId: undefined }) })).toEqual([]);
  });

  it("error → un morceau de message « Erreur : … » expurgé ; status, done, history, stream-* → rien", () => {
    const [e] = mapAgentEvent({ type: "error", sessionId: S, error: `quota dépassé pour ${KEY}` });
    expect(e).toMatchObject({ sessionUpdate: "agent_message_chunk" });
    expect(JSON.stringify(e)).toMatch(/Erreur : quota/);
    expect(JSON.stringify(e)).not.toContain("CANARI-ACP");
    for (const ev of [
      { type: "status", sessionId: S, status: "Compaction…" },
      { type: "done", sessionId: S },
      { type: "history", sessionId: S },
      { type: "stream-start", sessionId: S, streamId: "x" },
      { type: "stream-reset", sessionId: S, streamId: "x" },
      { type: "session-updated", sessionId: S },
    ] as const)
      expect(mapAgentEvent(ev), ev.type).toEqual([]);
  });
});

describe("genre d'outil, titre, arguments", () => {
  it("les outils connus ont un genre ; un outil inconnu (dont MCP externe) = other", () => {
    expect(toolKindOf("read_file")).toBe("read");
    expect(toolKindOf("write_file")).toBe("edit");
    expect(toolKindOf("edit_file")).toBe("edit");
    expect(toolKindOf("run_shell")).toBe("execute");
    expect(toolKindOf("search_files")).toBe("search");
    expect(toolKindOf("web_fetch")).toBe("fetch");
    expect(toolKindOf("state_delete")).toBe("delete");
    expect(toolKindOf("mcp_linear_create_issue")).toBe("other");
    expect(toolKindOf("")).toBe("other");
  });

  it("titre : nom + premier argument texte court ; borné ; expurgé ; sans argument texte = le nom seul", () => {
    expect(toolTitle({ name: "run_shell", args: { command: "ls   -la" } })).toBe("run_shell : ls -la");
    expect(toolTitle({ name: "x", args: { n: 3 } })).toBe("x");
    expect(toolTitle({ name: "x", args: { c: "a".repeat(500) } }).length).toBeLessThanOrEqual(175);
    expect(toolTitle({ name: "x", args: { c: KEY } })).not.toContain("CANARI-ACP");
  });

  it("redactArgs : récursif, bornes (chaînes, tableaux), expurgation à toute profondeur, sans modifier l'original", () => {
    const original = { a: { b: [KEY, "ok"] }, long: "z".repeat(5_000), many: Array.from({ length: 200 }, (_, i) => i) };
    const copy = redactArgs(original) as typeof original;
    expect(JSON.stringify(copy)).not.toContain("CANARI-ACP");
    expect(copy.long.length).toBeLessThan(1_100);
    expect(copy.many).toHaveLength(50);
    expect(original.a.b[0]).toBe(KEY);
  });
});

describe("conformité de forme avec le schéma du SDK ACP (vérifiée au compile)", () => {
  it("les mises à jour produites sont des SessionUpdate valides ; la demande d'autorisation est une RequestPermissionRequest valide", () => {
    const updates = [
      ...mapAgentEvent({ type: "delta", sessionId: S, streamId: "x", text: "a", thinking: "b" }),
      ...mapAgentEvent({ type: "tool-start", sessionId: S, call: call() }),
      ...mapAgentEvent({ type: "message", sessionId: S, message: toolMsg() }),
      ...mapAgentEvent({ type: "error", sessionId: S, error: "e" }),
    ];
    const asSdk: SessionUpdate[] = updates; // erreur de compilation si une forme diverge
    expect(asSdk.length).toBe(5);
    const req = {
      sessionId: S,
      toolCall: { toolCallId: "c1", title: "t", kind: "read", status: "pending", rawInput: {} },
      options: [{ optionId: "allow_once", name: "Oui", kind: "allow_once" }],
    } satisfies RequestPermissionRequest;
    expect(req.options).toHaveLength(1);
    expect(toolCallStart(call()).toolCallId).toBe("c1");
  });
});

describe("promptToText : prompt de l'éditeur → texte", () => {
  it("texte, lien de ressource et ressource texte intégrée sont pris en charge, dans l'ordre", () => {
    const t = promptToText([
      { type: "text", text: "Corrige ce fichier" },
      { type: "resource_link", uri: "file:///p/a.ts", name: "a.ts" },
      { type: "resource", resource: { uri: "file:///p/b.ts", text: "const b = 1;" } },
    ]);
    expect(t).toBe("Corrige ce fichier\n\n[Fichier référencé : a.ts — file:///p/a.ts]\n\n[Contenu de file:///p/b.ts]\nconst b = 1;\n[Fin de file:///p/b.ts]");
  });

  it("image, audio, ressource binaire, bloc inconnu, prompt vide : refusés avec un message clair (jamais ignorés en silence)", () => {
    for (const bad of [
      [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
      [{ type: "resource", resource: { uri: "file:///x.bin", blob: "AAAA" } }],
      [{ type: "inconnu" }],
      [{ type: "text", text: "ok" }, { type: "image", data: "A", mimeType: "image/png" }],
      [],
    ] as const)
      expect(() => promptToText(bad as never)).toThrow(UnsupportedPromptError);
    expect(() => promptToText([{ type: "image", data: "A", mimeType: "image/png" }] as never)).toThrow(/image/);
  });

  it("une ressource intégrée énorme est coupée (marquée), pas transmise en entier", () => {
    const t = promptToText([{ type: "resource", resource: { uri: "file:///gros.txt", text: "x".repeat(300_000) } }]);
    expect(t.length).toBeLessThan(101_000);
    expect(t).toContain("[tronqué]");
  });
});
