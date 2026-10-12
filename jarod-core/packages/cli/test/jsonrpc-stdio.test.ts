// SPECS-P5-MCP.md §3/§5 : transport JSON-RPC 2.0 délimité par des retours à la ligne, PARTAGÉ par `jarod mcp` et `jarod acp`.
// Écrit à la main (aucun SDK) : ces tests fixent le cadrage, les codes d'erreur, les notifications et la fin d'entrée.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ERR, RpcError, serveJsonRpc } from "../src/jsonrpc-stdio.js";

function rig(handlers: Parameters<typeof serveJsonRpc>[0]["onRequest"], onNotification?: Parameters<typeof serveJsonRpc>[0]["onNotification"]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    buf += c;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  const server = serveJsonRpc({ input, output, onRequest: handlers, ...(onNotification ? { onNotification } : {}) });
  const send = (o: unknown) => input.write(`${typeof o === "string" ? o : JSON.stringify(o)}\n`);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  return { input, output, lines, server, send, settle, parsed: () => lines.map((l) => JSON.parse(l)) };
}

describe("jsonrpc-stdio : cadrage et réponses", () => {
  it("répond à une requête, une réponse = UNE ligne JSON valide terminée par \\n", async () => {
    const r = rig(async (method, params) => ({ method, echo: params }));
    r.send({ jsonrpc: "2.0", id: 1, method: "ping", params: { a: 1 } });
    await r.settle();
    expect(r.lines).toHaveLength(1);
    expect(r.parsed()[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { method: "ping", echo: { a: 1 } } });
  });

  it("recolle une ligne coupée en plusieurs morceaux et traite plusieurs lignes dans un seul morceau", async () => {
    const r = rig(async (m) => m);
    const one = JSON.stringify({ jsonrpc: "2.0", id: "a", method: "x" });
    r.input.write(one.slice(0, 7));
    r.input.write(`${one.slice(7)}\n${JSON.stringify({ jsonrpc: "2.0", id: "b", method: "y" })}\n`);
    await r.settle();
    expect(r.parsed().map((m) => m.result).sort()).toEqual(["x", "y"]);
  });

  it("accepte les fins de ligne \\r\\n et ignore les lignes vides", async () => {
    const r = rig(async () => "ok");
    r.input.write(`\r\n\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" })}\r\n`);
    await r.settle();
    expect(r.parsed()).toHaveLength(1);
  });

  it("JSON invalide → -32700 avec id null ; la suite reste servie", async () => {
    const r = rig(async () => "ok");
    r.send("{pas du json");
    r.send({ jsonrpc: "2.0", id: 2, method: "x" });
    await r.settle();
    const [bad, good] = r.parsed();
    expect(bad).toMatchObject({ id: null, error: { code: ERR.parse } });
    expect(good).toMatchObject({ id: 2, result: "ok" });
  });

  it("lot (tableau) refusé -32600 ; objet sans méthode ni résultat -32600 ; jsonrpc absent/faux -32600", async () => {
    const r = rig(async () => "ok");
    r.send([{ jsonrpc: "2.0", id: 1, method: "x" }]);
    r.send({ jsonrpc: "2.0", id: 2 });
    r.send({ id: 3, method: "x" });
    await r.settle();
    expect(r.parsed().map((m) => m.error?.code)).toEqual([ERR.invalidRequest, ERR.invalidRequest, ERR.invalidRequest]);
  });

  it("RpcError du gestionnaire → son code et son message ; autre exception → -32603 SANS divulguer le message interne", async () => {
    const r = rig(async (m) => {
      if (m === "inconnue") throw new RpcError(ERR.methodNotFound, "Méthode inconnue : inconnue");
      throw new Error("chemin secret C:\\Users\\x\\cle.txt");
    });
    r.send({ jsonrpc: "2.0", id: 1, method: "inconnue" });
    r.send({ jsonrpc: "2.0", id: 2, method: "autre" });
    await r.settle();
    const [a, b] = r.parsed();
    expect(a.error).toMatchObject({ code: ERR.methodNotFound, message: "Méthode inconnue : inconnue" });
    expect(b.error.code).toBe(ERR.internal);
    expect(JSON.stringify(b)).not.toContain("secret");
  });

  it("une notification (sans id) ne reçoit AUCUNE réponse, même en erreur ; elle est transmise à onNotification", async () => {
    const seen: string[] = [];
    const r = rig(
      async () => "ok",
      (m, p) => {
        seen.push(`${m}:${JSON.stringify(p)}`);
        throw new Error("boum");
      },
    );
    r.send({ jsonrpc: "2.0", method: "notifications/initialized", params: { z: 1 } });
    await r.settle();
    expect(r.lines).toEqual([]);
    expect(seen).toEqual(['notifications/initialized:{"z":1}']);
  });

  it("les requêtes sont traitées en PARALLÈLE : une requête lente n'empêche pas la suivante (annulation ACP)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig(async (m) => {
      if (m === "lente") await gate;
      return m;
    });
    r.send({ jsonrpc: "2.0", id: 1, method: "lente" });
    r.send({ jsonrpc: "2.0", id: 2, method: "rapide" });
    await r.settle();
    expect(r.parsed().map((m) => m.id)).toEqual([2]);
    release();
    await r.settle();
    expect(r.parsed().map((m) => m.id)).toEqual([2, 1]);
  });

  it("ligne démesurée (> limite) → -32600 et la suite reste servie, sans garder la ligne en mémoire", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const got: string[] = [];
    output.setEncoding("utf8");
    output.on("data", (c: string) => got.push(...c.split("\n").filter(Boolean)));
    serveJsonRpc({ input, output, onRequest: async () => "ok", maxLineBytes: 100 });
    input.write(`${"x".repeat(500)}\n${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "m" })}\n`);
    await new Promise((r) => setTimeout(r, 30));
    const msgs = got.map((l) => JSON.parse(l));
    expect(msgs[0]).toMatchObject({ id: null, error: { code: ERR.invalidRequest } });
    expect(msgs[1]).toMatchObject({ id: 9, result: "ok" });
  });
});

describe("jsonrpc-stdio : requêtes sortantes et fin d'entrée", () => {
  it("request() envoie une requête au client et résout avec sa réponse ; une erreur du client rejette", async () => {
    const r = rig(async () => "ok");
    const p = r.server.request("session/request_permission", { a: 1 });
    await r.settle();
    const sent = r.parsed()[0];
    expect(sent).toMatchObject({ jsonrpc: "2.0", method: "session/request_permission", params: { a: 1 } });
    r.send({ jsonrpc: "2.0", id: sent.id, result: { outcome: "selected" } });
    await expect(p).resolves.toEqual({ outcome: "selected" });
    const q = r.server.request("x", {});
    await r.settle();
    r.send({ jsonrpc: "2.0", id: r.parsed()[1].id, error: { code: -32000, message: "refusé" } });
    await expect(q).rejects.toThrow("refusé");
  });

  it("notify() écrit une notification (sans id)", async () => {
    const r = rig(async () => "ok");
    r.server.notify("session/update", { u: 1 });
    await r.settle();
    expect(r.parsed()[0]).toEqual({ jsonrpc: "2.0", method: "session/update", params: { u: 1 } });
  });

  it("EOF : attend les traitements en cours, rejette les requêtes sortantes en attente, puis `closed` se résout", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig(async () => {
      await gate;
      return "tard";
    });
    r.send({ jsonrpc: "2.0", id: 1, method: "lente" });
    const out = r.server.request("x", {});
    const rejected = expect(out).rejects.toThrow(/fermé/i);
    r.input.end();
    let closed = false;
    void r.server.closed.then(() => (closed = true));
    await r.settle();
    expect(closed).toBe(false); // le traitement en cours n'est pas fini
    release();
    await r.server.closed;
    await rejected;
    expect(r.parsed().some((m) => m.id === 1 && m.result === "tard")).toBe(true);
  });

  it("sortie cassée (EPIPE) : ne lève pas, `closed` se résout", async () => {
    const r = rig(async () => "ok");
    r.output.destroy(new Error("EPIPE"));
    r.send({ jsonrpc: "2.0", id: 1, method: "x" });
    await r.settle();
    r.input.end();
    await expect(r.server.closed).resolves.toBeUndefined();
  });
});
