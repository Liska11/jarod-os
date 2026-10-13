import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../src/registry.js";
import { askShell, type Packet, streamText, tail } from "../src/pinokio/client.js";
import { pinokioTools } from "../src/pinokio/tools.js";

const ENV = { JAROD_PINOKIO_URL: "http://127.0.0.1:42000" };
const ctx = { sessionId: "s", workspace: null };

type Route = (url: URL) => { status?: number; body: unknown };

function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const route = Object.entries(routes).find(([prefix]) => url.href.startsWith(prefix) || url.pathname.startsWith(prefix));
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const { status = 200, body } = route[1](url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

/** Un faux WebSocket de pinokiod : rend les paquets prévus pour chaque message. */
function fakeSocket(answer: (message: Record<string, unknown>) => Packet[]) {
  const sent: Record<string, unknown>[] = [];
  const socket = async (_url: string, message: unknown, onPacket: (p: Packet) => boolean) => {
    sent.push(message as Record<string, unknown>);
    for (const packet of answer(message as Record<string, unknown>)) if (onPacket(packet)) return "done" as const;
    return "closed" as const;
  };
  return { socket, sent };
}

const tool = (tools: ToolDef[], name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} manquant`);
  return found;
};

const version: Route = () => ({ body: { pinokiod: "8.2.2" } });

describe("pinokioTools", () => {
  it("are offered only when Jarod-OS ships the engine", () => {
    for (const t of pinokioTools({ env: {} })) expect(t.available?.()).toBe(false);
    for (const t of pinokioTools({ env: ENV })) expect(t.available?.()).toBe(true);
  });

  it("asks before installing, running and stopping; reads are audited", () => {
    const tools = pinokioTools({ env: ENV });
    expect(tools.filter((t) => t.dangerous).map((t) => t.name).sort()).toEqual(["pinokio_install", "pinokio_run", "pinokio_stop"]);
    expect(tool(tools, "pinokio_search").audited).toBe(true);
  });

  it("starts the engine through Jarod-OS when it does not answer yet", async () => {
    let up = false;
    const startEngine = vi.fn(async () => {
      up = true;
      return true;
    });
    const { impl } = fakeFetch({
      "/pinokio/version": () => (up ? version(new URL("http://x")) : { status: 503, body: "" }),
      "/apps/search": () => ({ body: { apps: [{ app_id: "comfy.git", ready: false }] } }),
    });
    const out = JSON.parse(await tool(pinokioTools({ env: ENV, fetch: impl, startEngine }), "pinokio_search").run({ query: "image generation" }, ctx));
    expect(startEngine).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ source: "installed", count: 1 });
  });

  it("searches installed apps, then broadly, and says to try the registry", async () => {
    const { impl, calls } = fakeFetch({ "/pinokio/version": version, "/apps/search": () => ({ body: { apps: [] } }) });
    const out = JSON.parse(await tool(pinokioTools({ env: ENV, fetch: impl }), "pinokio_search").run({ query: "tts speech synthesis" }, ctx));
    expect(calls.filter((c) => c.startsWith("/apps/search"))).toEqual(["/apps/search?q=tts+speech+synthesis&mode=balanced&min_match=2&limit=8", "/apps/search?q=tts+speech+synthesis&mode=broad&limit=8"]);
    expect(out.hint).toContain("scope=registry");
  });

  it("searches the public registry for this platform", async () => {
    const { impl, calls } = fakeFetch({ "https://api.pinokio.co/v1/search": () => ({ body: { items: [{ uri: "https://github.com/x/y" }] } }) });
    const out = JSON.parse(await tool(pinokioTools({ env: ENV, fetch: impl, platform: "win32" }), "pinokio_search").run({ query: "upscale", scope: "registry" }, ctx));
    expect(calls).toEqual(["/v1/search?q=upscale&platform=windows&limit=8"]);
    expect(out).toMatchObject({ source: "registry", items: [{ uri: "https://github.com/x/y" }] });
  });

  it("refuses app ids that would leave the apps folder, and non-https repositories, before any request", async () => {
    const tools = pinokioTools({ env: ENV, fetch: (async () => { throw new Error("no request expected"); }) as typeof fetch });
    await expect(tool(tools, "pinokio_status").run({ app_id: "../../Windows" }, ctx)).rejects.toThrow("app_id");
    await expect(Promise.resolve().then(() => tool(tools, "pinokio_install").precheck?.({ uri: "file:///C:/x" }, ctx))).rejects.toThrow("https");
    await expect(Promise.resolve().then(() => tool(tools, "pinokio_install").precheck?.({ uri: "https://user:pw@github.com/x/y" }, ctx))).rejects.toThrow("identifiants");
    expect(await tool(tools, "pinokio_run").precheck?.({ app_id: "comfy.git" }, ctx)).toContain("comfy.git");
  });

  it("downloads a launcher with app.download and reports the folder", async () => {
    const { impl } = fakeFetch({ "/pinokio/version": version });
    const { socket, sent } = fakeSocket(() => [
      { type: "stream", data: { raw: "\u001b[32mCloning into 'y'...\u001b[0m\r\n" } },
      { type: "result", data: { ok: true, path: "C:\\pinokio\\api\\y", name: "y" } },
    ]);
    const out = JSON.parse(await tool(pinokioTools({ env: ENV, fetch: impl, socket }), "pinokio_install").run({ uri: "https://github.com/x/y" }, ctx));
    expect(sent[0]).toEqual({ method: "app.download", params: { uri: "https://github.com/x/y" } });
    expect(out).toMatchObject({ ok: true, name: "y" });
    expect(out.log_tail).toContain("Cloning into 'y'...");
  });

  it("runs the menu's scripts in turn (install, then start) until the app offers its page", async () => {
    let started = false;
    const { impl } = fakeFetch({
      "/pinokio/version": version,
      "/apps/status/app.git": () => ({ body: { app_id: "app.git", path: "C:\\pinokio\\api\\app.git", ready: started, ready_url: started ? "http://127.0.0.1:7860" : null, state: started ? "online" : "offline", running_scripts: started ? ["start.js"] : [] } }),
    });
    const order = ["C:\\pinokio\\api\\app.git\\install.js", "C:\\pinokio\\api\\app.git\\start.js", "http://127.0.0.1:7860"];
    const { socket, sent } = fakeSocket((message) => {
      if (message.mode === "open") return [{ type: "default", data: { uri: order.shift() } }];
      if (message.method === "kernel.api.stop") return [{ type: "result" }];
      if (String(message.uri).endsWith("start.js")) started = true;
      return [{ type: "stream", data: { raw: `running ${String(message.uri)}\n` } }, { type: "result", data: {} }];
    });
    const out = JSON.parse(await tool(pinokioTools({ env: ENV, fetch: impl, socket }), "pinokio_run").run({ app_id: "app.git", wait_seconds: 10 }, ctx));
    const ran = sent.filter((m) => typeof m.uri === "string" && !m.mode).map((m) => m.uri);
    expect(ran).toEqual(["C:\\pinokio\\api\\app.git\\install.js", "C:\\pinokio\\api\\app.git\\start.js"]);
    expect(out).toMatchObject({ ready: true, ready_url: "http://127.0.0.1:7860", launch: { state: "done", url: "http://127.0.0.1:7860" } });
    expect(out.launch.log_tail).toContain("── start.js ──");
  });

  it("does not relaunch an app that is already ready", async () => {
    const { impl } = fakeFetch({ "/pinokio/version": version, "/apps/status/app.git": () => ({ body: { app_id: "app.git", path: "C:\\a", ready: true, ready_url: "http://127.0.0.1:7860" } }) });
    const { socket, sent } = fakeSocket(() => []);
    const out = JSON.parse(await tool(pinokioTools({ env: ENV, fetch: impl, socket }), "pinokio_run").run({ app_id: "app.git" }, ctx));
    expect(out).toMatchObject({ already: true, ready_url: "http://127.0.0.1:7860" });
    expect(sent).toEqual([]);
  });

  it("stops every running script of an app", async () => {
    const { impl } = fakeFetch({ "/pinokio/version": version, "/apps/status/app.git": () => ({ body: { app_id: "app.git", path: "C:\\pinokio\\api\\app.git", running_scripts: ["start.js"] } }) });
    const { socket, sent } = fakeSocket(() => [{ type: "result" }]);
    await tool(pinokioTools({ env: ENV, fetch: impl, socket, platform: "win32" }), "pinokio_stop").run({ app_id: "app.git" }, ctx);
    expect(sent).toEqual([{ method: "kernel.api.stop", params: { uri: expect.stringMatching(/app\.git[\\/]start\.js$/) } }]);
  });

  it("shows only pages on this computer", async () => {
    const show = vi.fn(async () => undefined);
    const open = tool(pinokioTools({ env: ENV, show }), "pinokio_open");
    await open.run({ url: "http://127.0.0.1:7860/" }, ctx);
    await expect(open.run({ url: "https://evil.example/" }, ctx)).rejects.toThrow("cet ordinateur");
    expect(show).toHaveBeenCalledWith("http://127.0.0.1:7860/");
  });
});

describe("client helpers", () => {
  it("strips terminal escapes from streamed output", () => {
    expect(streamText({ type: "stream", data: { raw: "\u001b[1;32mok\u001b[0m\rprogress\r\n\u001b]0;title\u0007done" } })).toBe("ok\nprogress\r\ndone");
  });

  it("keeps the end of a long log, cut at a line", () => {
    expect(tail("a\nbb\nccc", 5)).toBe("…ccc");
  });

  it("asks the shell over its control socket with the launch token", async () => {
    const seen: string[] = [];
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (line: string) => {
        seen.push(line);
        socket.write(`${JSON.stringify({ ok: true, summary: "Pinokio engine ready" })}\n`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const reply = await askShell("pinokio.start", { HERALD_OS_CONTROL_SOCKET: `tcp://127.0.0.1:${port}`, HERALD_OS_CONTROL_TOKEN: "tok" });
    server.close();
    expect(reply).toEqual({ ok: true, summary: "Pinokio engine ready" });
    expect(JSON.parse(seen[0] ?? "{}")).toEqual({ cmd: "ui", token: "tok", command: "pinokio.start", args: {}, source: "agent" });
    await expect(askShell("pinokio.start", {})).rejects.toThrow("socket de contrôle");
  });
});
