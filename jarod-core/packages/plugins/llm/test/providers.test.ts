// Portage de packages/core/test/providers.test.ts (rév. 2e180305).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { toAnthropicMessages } from "../src/anthropic.js";
import { describeStreamError, OpenAICompatibleClient, toOpenAIMessages } from "../src/openai.js";
import { SseParser } from "@jarod/kernel/util";

describe("SseParser", () => {
  it("handles split chunks, CRLF, comments and multi-line data", () => {
    const events: [string, string][] = [];
    const p = new SseParser((e, d) => events.push([e, d]));
    p.push(": keepalive\r\nevent: a\r\ndata: 1\r\n");
    p.push('data: 2\r\n\r\ndata: {"x"');
    p.push(":1}\n\n");
    p.flush();
    expect(events).toEqual([
      ["a", "1\n2"],
      ["message", '{"x":1}'],
    ]);
  });
});

let server: Server | null = null;
let lastBody = "";
afterEach(() => server?.close());

function serve(chunks: string[]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastBody = body;
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const c of chunks) res.write(c);
        res.end();
      });
    }).listen(0, () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`));
  });
}

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

describe("OpenAICompatibleClient", () => {
  it("streams text + reasoning and assembles fragmented tool calls", async () => {
    const url = await serve([
      sse({ choices: [{ delta: { reasoning_content: "hmm" } }] }),
      sse({ choices: [{ delta: { content: "Bon" } }] }),
      sse({ choices: [{ delta: { content: "jour" } }] }),
      sse({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_", arguments: '{"pa' } }] } },
        ],
      }),
      sse({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: 'th":"a.txt"}' } }] } }],
      }),
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
      "data: [DONE]\n\n",
    ]);
    const client = new OpenAICompatibleClient(url, "key");
    const deltas: string[] = [];
    const r = await client.chat(
      {
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read_file", description: "d", parameters: { type: "object" } }],
      },
      { onText: (d) => deltas.push(d) },
    );
    expect(deltas.join("")).toBe("Bonjour");
    expect(r.thinking).toBe("hmm");
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "read_file", args: { path: "a.txt" } }]);
    expect([r.inputTokens, r.outputTokens]).toEqual([12, 7]);
    const sent = JSON.parse(lastBody);
    expect(sent.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(sent.tools[0].function.name).toBe("read_file");
  });

  it("says in words why a server cut the stream, with the request size when it looks like context", async () => {
    const url = await serve([sse({ error: { message: "terminated" } })]);
    const err = await new OpenAICompatibleClient(url, undefined)
      .chat(
        {
          model: "m",
          system: "x".repeat(7000),
          messages: [],
          tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
        },
        {},
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(
      /^Le serveur a interrompu la génération : terminated\nLa requête faisait environ 2\d00 tokens \(1 outils\)/,
    );
    expect(describeStreamError({ message: "model crashed" }, 100, 0)).toBe(
      "Le serveur a interrompu la génération : model crashed",
    );
    expect(describeStreamError("boom", 100, 0)).toBe("Le serveur a interrompu la génération : boom");
  });

  it("refuses to return tool calls from a length-truncated response", async () => {
    const url = await serve([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "x", arguments: '{"a' } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "length" }] }),
    ]);
    await expect(
      new OpenAICompatibleClient(url, undefined).chat({ model: "m", system: "", messages: [], tools: [] }, {}),
    ).rejects.toThrow(/tronquée/);
  });
});

describe("message conversion", () => {
  const turns = [
    { role: "user" as const, content: "q" },
    {
      role: "assistant" as const,
      content: "je regarde",
      toolCalls: [
        { id: "a", name: "t1", args: {} },
        { id: "b", name: "t2", args: { x: 1 } },
      ],
    },
    { role: "tool" as const, content: "r1", toolCallId: "a", toolName: "t1" },
    { role: "tool" as const, content: "", toolCallId: "b", toolName: "t2", isError: true },
    { role: "assistant" as const, content: "fini" },
  ];

  it("OpenAI: tool calls and tool messages", () => {
    const out = toOpenAIMessages("", turns);
    expect(out[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] });
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "a", content: "r1" });
  });

  it("Anthropic: groups parallel tool results into one user message", () => {
    const out = toAnthropicMessages(turns, "claude-opus-5");
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const results = out[2]!.content as { type: string; tool_use_id: string; is_error?: boolean; content: string }[];
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
    expect(results[1]).toMatchObject({ is_error: true, content: "(aucune sortie)" });
  });

  it("Anthropic: replays raw blocks only for the same model", () => {
    const raw = [
      { type: "thinking", thinking: "t", signature: "sig" },
      { type: "text", text: "x" },
    ];
    const t = [
      { role: "user" as const, content: "q" },
      { role: "assistant" as const, content: "x", provider: "anthropic", model: "claude-opus-5", raw },
    ];
    expect(toAnthropicMessages(t, "claude-opus-5")[1]!.content).toEqual(raw);
    expect(toAnthropicMessages(t, "claude-sonnet-5")[1]!.content).toEqual([{ type: "text", text: "x" }]);
  });
});
