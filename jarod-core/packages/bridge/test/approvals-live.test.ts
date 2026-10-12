/**
 * SPECS-P5-UI-PARITE.md § 13.3 / § 13.4 (AR2, AR4) — le moment d'effet de l'accord, bout en bout dans le courtier : VRAI noyau, VRAIS handlers, fournisseur = stub scripté dont les
 * réponses sont INTERCALÉES (un crochet s'exécute entre deux réponses du modèle, donc entre deux appels d'outil d'un même tour). Le garde de l'agent est testé à part
 * (`plugins/agent/test/approval-failclosed.test.ts`).
 */
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel, until, type Chunk } from "./ui-parite-helpers.js";

afterEach(cleanup);

const delta = (d: Chunk): Chunk => ({ choices: [{ delta: d }] });
const stop = (reason: string): Chunk => ({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
const calls = (...c: { id: string; name: string; args: unknown }[]): Chunk[] => [
  delta({ tool_calls: c.map((x, index) => ({ index, id: x.id, type: "function", function: { name: x.name, arguments: JSON.stringify(x.args) } })) }),
  stop("tool_calls"),
];
const say = (t: string): Chunk[] => [delta({ content: t }), stop("stop")];

/** La n-ième requête reçoit `script[n]` ; `before(n)` s'exécute AVANT la réponse n (n ≥ 1 : entre deux réponses du modèle). */
function hooked(script: Chunk[][], before: (n: number) => Promise<void> | void = () => {}): Promise<{ port: number; close: () => void }> {
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const mine = n++;
        await before(mine);
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const c of script[Math.min(mine, script.length - 1)]!) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.end("data: [DONE]\n\n");
      })();
    });
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      ok({ port: typeof a === "object" && a ? a.port : 0, close: () => server.close() });
    }),
  );
}

type Req = { id: string; sessionId: string; tool: string; canAlways: boolean; canSession: boolean };

async function setup(script: Chunk[][], before?: (n: number, k: Awaited<ReturnType<typeof setupKernel>>) => Promise<void> | void, confirmAnswers: boolean[] = []) {
  const dir = realpathSync.native(tempDir());
  let kernel: Awaited<ReturnType<typeof setupKernel>> | undefined;
  const stub = await hooked(script, (n) => before?.(n, kernel!));
  const k = await setupKernel(stub.port, confirmAnswers);
  kernel = k;
  k.app.agent.settings.patch({ workspace: dir } as never);
  const send = (runId = "run-a", resume?: string) => k.call("send-message", "Écris", undefined, resume, [], [], undefined, runId) as Promise<{ response: string; sessionId: string }>;
  const requests = () => k.on("tool-approval-request").map(([r]) => r as Req);
  const respond = (id: string, allow: boolean, scope?: unknown) => Promise.resolve(k.call("tool-approval-respond", id, allow, ...(scope === undefined ? [] : [scope])));
  return { ...k, stub, dir, send, requests, respond, file: (n: string) => join(dir, n) };
}
const write = (id: string, path: string) => ({ id, name: "write_file", args: { path, content: path } });

describe("moment d'effet de l'accord, bout en bout", () => {
  it("AR2 : « Toujours » répondu au 1ᵉʳ appel d'un tour de DEUX appels : le 2ᵉ passe sans demande, dans le MÊME tour", async () => {
    const w = await setup([calls(write("c1", "a.txt"), write("c2", "b.txt")), say("Terminé.")], undefined, [true]);
    try {
      const turn = w.send();
      await until(() => w.requests().length === 1, "1re demande");
      expect(w.requests()[0]).toMatchObject({ canAlways: true, canSession: true });
      expect(await w.respond(w.requests()[0]!.id, true, true)).toBe(true);
      await turn;
      expect(w.requests(), "pas de seconde demande dans le même tour").toHaveLength(1);
      expect(existsSync(w.file("a.txt"))).toBe(true);
      expect(existsSync(w.file("b.txt"))).toBe(true);
      expect(w.app.agent.settings.get("alwaysAllowTools")).toEqual(["write_file"]);
    } finally {
      w.stub.close();
    }
  });

  it("AR4 : « Remove all » des accords de conversation ENTRE deux appels (deux réponses du modèle) : le 2ᵉ appel redemande", async () => {
    const w = await setup(
      [calls(write("c1", "a.txt")), calls(write("c2", "b.txt")), say("Terminé.")],
      async (n, k) => {
        if (n === 1) await k.call("tool-approval-grants-clear"); // entre la 1ʳᵉ et la 2ᵉ réponse du modèle
      },
    );
    try {
      const turn = w.send();
      await until(() => w.requests().length === 1, "1re demande");
      expect(await w.respond(w.requests()[0]!.id, true, "session")).toBe(true);
      await until(() => w.requests().length === 2, "2e demande après le retrait");
      expect(existsSync(w.file("a.txt"))).toBe(true);
      expect(await w.respond(w.requests()[1]!.id, false)).toBe(true);
      await turn;
      expect(existsSync(w.file("b.txt")), "refusé : rien d'écrit").toBe(false);
    } finally {
      w.stub.close();
    }
  });

  it("témoin : sans retrait, le 2ᵉ appel de la conversation passe sans demande", async () => {
    const w = await setup([calls(write("c1", "a.txt")), calls(write("c2", "b.txt")), say("Terminé.")]);
    try {
      const turn = w.send();
      await until(() => w.requests().length === 1, "1re demande");
      await w.respond(w.requests()[0]!.id, true, "session");
      await turn;
      expect(w.requests()).toHaveLength(1);
      expect(existsSync(w.file("b.txt"))).toBe(true);
    } finally {
      w.stub.close();
    }
  });
});
