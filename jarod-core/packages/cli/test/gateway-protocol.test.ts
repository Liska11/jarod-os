// Passerelle compatible Hermes (essai) : les parties pures — trames WebSocket et traduction des événements de l'agent.
import type { Message } from "@jarod/contracts";
import type { AgentEvent } from "@jarod/plugin-agent";
import { describe, expect, it } from "vitest";
import { approvalParams, chooseWorkspace, isApproved, promptText, sessionRow, toTranscript, TurnTranslator, type GatewayEventFrame } from "../src/gateway/protocol.js";
import { acceptKey, decodeFrame, encodeFrame, MAX_MESSAGE_BYTES } from "../src/gateway/ws.js";

const mask = (payload: Buffer, key = Buffer.from([1, 2, 3, 4])): Buffer => {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! ^ key[i % 4]!;
  return out;
};

/** Une trame de client : masquée, comme l'exige la RFC. */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const head = encodeFrame(opcode, payload).subarray(0, payload.length < 126 ? 2 : payload.length < 65_536 ? 4 : 10);
  const copy = Buffer.from(head);
  copy[0] = (fin ? 0x80 : 0) | opcode;
  copy[1] = copy[1]! | 0x80;
  return Buffer.concat([copy, Buffer.from([1, 2, 3, 4]), mask(payload)]);
}

describe("WebSocket (RFC 6455)", () => {
  it("calcule Sec-WebSocket-Accept comme l'exemple de la RFC (§1.3)", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it.each([0, 5, 125, 126, 1000, 65_535, 65_536, 70_000])("encode puis décode un message de %i octets", (size) => {
    const payload = Buffer.alloc(size, 0x61);
    const decoded = decodeFrame(clientFrame(0x1, payload));
    expect(decoded).not.toBeNull();
    expect(typeof decoded).toBe("object");
    if (decoded && typeof decoded === "object") {
      expect(decoded.frame.opcode).toBe(1);
      expect(decoded.frame.payload.equals(payload)).toBe(true);
    }
  });

  it("attend les octets manquants au lieu d'échouer", () => {
    const full = clientFrame(0x1, Buffer.from("bonjour"));
    for (let cut = 0; cut < full.length; cut++) expect(decodeFrame(full.subarray(0, cut))).toBeNull();
  });

  it("refuse une trame de client non masquée et un message trop gros", () => {
    expect(decodeFrame(encodeFrame(0x1, Buffer.from("x")))).toBe("unmasked");
    const huge = Buffer.alloc(10);
    huge[0] = 0x81;
    huge[1] = 0x80 | 127;
    huge.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES) + 1n, 2);
    expect(decodeFrame(huge)).toBe("too-big");
  });

  it("rend le nombre d'octets consommés : deux trames collées se lisent l'une après l'autre", () => {
    const a = clientFrame(0x1, Buffer.from("un"));
    const b = clientFrame(0x1, Buffer.from("deux"));
    const joined = Buffer.concat([a, b]);
    const first = decodeFrame(joined);
    expect(first && typeof first === "object" && first.used).toBe(a.length);
    const second = typeof first === "object" && first ? decodeFrame(joined.subarray(first.used)) : null;
    expect(second && typeof second === "object" && second.frame.payload.toString()).toBe("deux");
  });
});

const run = (events: AgentEvent[]) => {
  const frames: GatewayEventFrame[] = [];
  const t = new TurnTranslator("s1", (f) => frames.push(f));
  for (const e of events) t.handle(e);
  return { frames, types: frames.map((f) => f.params.type), t };
};
const msg = (m: Partial<Message> & Pick<Message, "role" | "content">): Message => ({ id: "m1", sessionId: "s1", createdAt: 1_700_000_000_000, ...m });

describe("TurnTranslator", () => {
  it("traduit un tour avec flux, outil, réponse et fin", () => {
    const { frames, types } = run([
      { type: "stream-start", sessionId: "s1", streamId: "a" },
      { type: "delta", sessionId: "s1", streamId: "a", thinking: "je réfléchis" },
      { type: "delta", sessionId: "s1", streamId: "a", text: "Bon" },
      { type: "delta", sessionId: "s1", streamId: "a", text: "jour" },
      { type: "tool-start", sessionId: "s1", call: { id: "c1", name: "read_file", args: { path: "a.txt" } } },
      { type: "message", sessionId: "s1", message: msg({ role: "tool", content: "contenu", toolCallId: "c1", toolName: "read_file" }) },
      { type: "message", sessionId: "s1", message: msg({ role: "assistant", content: "Bonjour" }) },
      { type: "done", sessionId: "s1" },
    ]);
    expect(types).toEqual(["message.start", "reasoning.delta", "message.delta", "message.delta", "tool.start", "tool.complete", "message.complete"]);
    expect(frames.every((f) => f.params.session_id === "s1" && f.method === "event" && f.jsonrpc === "2.0")).toBe(true);
    expect(frames[4]!.params.payload).toEqual({ tool_id: "c1", name: "read_file", args: { path: "a.txt" } });
    expect(frames[5]!.params.payload).toMatchObject({ tool_id: "c1", name: "read_file", result_text: "contenu" });
    expect(frames[6]!.params.payload).toEqual({ text: "Bonjour", status: "complete" });
  });

  it("donne au shell un texte en deltas quand le fournisseur ne fait pas de flux", () => {
    const { types, frames } = run([
      { type: "stream-start", sessionId: "s1", streamId: "a" },
      { type: "message", sessionId: "s1", message: msg({ role: "assistant", content: "d'un bloc" }) },
      { type: "done", sessionId: "s1" },
    ]);
    expect(types).toEqual(["message.start", "message.start", "message.delta", "message.complete"]);
    expect(frames[2]!.params.payload).toEqual({ text: "d'un bloc" });
  });

  it("signale l'erreur puis termine en statut error, ou interrupted si arrêté", () => {
    const failed = run([
      { type: "error", sessionId: "s1", error: "clé refusée" },
      { type: "done", sessionId: "s1" },
    ]);
    expect(failed.types).toEqual(["error", "message.complete"]);
    expect(failed.frames[0]!.params.payload).toEqual({ message: "clé refusée" });
    expect(failed.frames[1]!.params.payload).toMatchObject({ status: "error", error: "clé refusée" });

    const t = new TurnTranslator("s1", () => {});
    const out: GatewayEventFrame[] = [];
    const t2 = new TurnTranslator("s1", (f) => out.push(f));
    t2.markAborted();
    t2.handle({ type: "done", sessionId: "s1" });
    expect(out[0]!.params.payload).toMatchObject({ status: "interrupted" });
    expect(t.ignored.size).toBe(0);
  });

  it("compte ce qu'il ne sait pas traduire au lieu de le taire", () => {
    const { t, types } = run([
      { type: "stream-reset", sessionId: "s1", streamId: "a" },
      { type: "history", sessionId: "s1" },
      { type: "session-updated", sessionId: "s1" },
      { type: "session-updated", sessionId: "s1" },
    ]);
    expect(types).toEqual([]);
    expect(Object.fromEntries(t.ignored)).toEqual({ "stream-reset": 1, history: 1, "session-updated": 2 });
  });
});

describe("conversions", () => {
  it("lit un texte de prompt en chaîne ou en parties", () => {
    expect(promptText("salut")).toBe("salut");
    expect(promptText([{ type: "text", text: "a" }, { type: "image" }, "b"])).toBe("a\nb");
    expect(promptText(42)).toBe("");
    expect(promptText(undefined)).toBe("");
  });

  it("transcrit l'historique, sans les messages compactés", () => {
    const rows = toTranscript([
      msg({ role: "user", content: "q" }),
      msg({ role: "assistant", content: "r", thinking: "pensée" }),
      msg({ role: "assistant", content: "", toolCalls: [{ id: "c", name: "run_shell", args: { command: "dir" } }] }),
      msg({ role: "tool", content: "o", toolCallId: "c", toolName: "run_shell" }),
      msg({ role: "user", content: "vieux", compacted: true }),
    ]);
    expect(rows).toEqual([
      { role: "user", text: "q", timestamp: 1_700_000_000 },
      { role: "assistant", text: "r", timestamp: 1_700_000_000, reasoning: "pensée" },
      // Le message d'assistant qui ne porte que l'appel n'est pas une bulle vide ; l'appel est la ligne d'outil, avec ses arguments.
      { role: "tool", text: "o", tool_call_id: "c", name: "run_shell", timestamp: 1_700_000_000, args: { command: "dir" } },
    ]);
  });

  it("n'offre jamais « toujours » ni « cette session » dans la demande d'accord", () => {
    const p = approvalParams("s1", "r1", { name: "run_shell", args: { command: "dir" } }, "Exécute une commande");
    expect(p).toMatchObject({ session_id: "s1", request_id: "r1", tool_name: "run_shell", choices: ["once", "deny"], allow_permanent: false, allow_session: false });
    expect(String(p.command)).toContain("run_shell");
  });

  it("n'accorde que sur un choix positif lisible", () => {
    expect(isApproved({ choice: "once" })).toBe(true);
    expect(isApproved({ choice: "deny" })).toBe(false);
    expect(isApproved(null)).toBe(false);
    expect(isApproved("once")).toBe(false);
    expect(isApproved({})).toBe(false);
  });
});

describe("chooseWorkspace", () => {
  const base = String.raw`D:\JAROD-OS`;
  it("sans dossier de base, suit le dossier du shell (comportement de l'essai)", () => {
    expect(chooseWorkspace(String.raw`C:\Users\San`, undefined, true)).toBe(String.raw`C:\Users\San`);
    expect(chooseWorkspace("", undefined, true)).toBeUndefined();
  });
  it("avec une base : le dossier personnel, un autre lecteur, un parent et un chemin relatif retombent sur la base", () => {
    for (const asked of [String.raw`C:\Users\San`, "D:\\", String.raw`D:\JAROD-OS-autre`, String.raw`D:\JAROD-OS\..\store`, "projet", "", String.raw`E:\JAROD-OS`]) {
      expect(chooseWorkspace(asked, base, true)).toBe(base);
    }
  });
  it("avec une base : la base elle-même et un sous-dossier sont acceptés (casse ignorée sous Windows)", () => {
    expect(chooseWorkspace(String.raw`D:\JAROD-OS`, base, true)).toBe(String.raw`D:\JAROD-OS`);
    expect(chooseWorkspace(String.raw`d:\jarod-os\projets\a`, base, true)).toBe(String.raw`d:\jarod-os\projets\a`);
  });
  it("même règle sous POSIX, où la casse compte", () => {
    expect(chooseWorkspace("/work/sub", "/work", false)).toBe("/work/sub");
    expect(chooseWorkspace("/Work/sub", "/work", false)).toBe("/work");
    expect(chooseWorkspace("/home/me", "/work", false)).toBe("/work");
    expect(chooseWorkspace("/work2", "/work", false)).toBe("/work");
  });
});

describe("sessionRow", () => {
  it("la source est une de celles que le shell de Herald liste (LISTED_SESSION_SOURCES : sinon l'historique est vide), dates en secondes", () => {
    const row = sessionRow({ id: "s", title: "T", createdAt: 1_700_000_123_999, updatedAt: 0, pinned: false, messageCount: 4 });
    expect(["herald_os", "hermes_os", "desktop", "cli", "tui"]).toContain(row.source);
    expect(row).toMatchObject({ id: "s", title: "T", started_at: 1_700_000_123, message_count: 4 });
  });
});
