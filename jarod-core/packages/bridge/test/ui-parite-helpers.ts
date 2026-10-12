/**
 * Aides des tests de SPECS-P5-UI-PARITE.md : un VRAI kernel (plugins publiés) derrière les VRAIS handlers, la fenêtre et les boîtes
 * natives simulées. Seul le fournisseur LLM est un stub OpenAI-compatible local (réponses scriptées par requête).
 */
import { createServer, type Server } from "node:http";
import { bootApp, discoverPlugins, tempDir } from "@jarod/kernel/testing";
import type { AgentRuntime } from "@jarod/plugin-agent";
import type { GatewayHub } from "@jarod/plugin-gateways";
import type { Scheduler } from "@jarod/plugin-scheduler";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { createHandlers, type DesktopKernel, type DesktopShell, type HandlerContext } from "../src/main/handlers/index.js";
import { dispatchOneaiCall } from "../src/main/ipc.js";


export type Chunk = Record<string, unknown>;

/** Stub SSE : la n-ième requête reçoit `script[n]`. */
export function scripted(script: Chunk[][]): Promise<{ port: number; close: () => void; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(JSON.parse(body || "{}"));
      const chunks = script[Math.min(bodies.length - 1, script.length - 1)]!;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      ok({ port: typeof a === "object" && a ? a.port : 0, close: () => server.close(), bodies });
    }),
  );
}
export const delta = (d: Chunk): Chunk => ({ choices: [{ delta: d }] });
export const stop = (usage: Chunk, reason = "stop"): Chunk => ({ choices: [{ delta: {}, finish_reason: reason }], usage });
/** Un tour du modèle qui demande l'outil `name` avec ces arguments. */
export const toolCall = (id: string, name: string, args: unknown): Chunk[] => [
  delta({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }),
  stop({ prompt_tokens: 10, completion_tokens: 3 }, "tool_calls"),
];
export const say = (text: string): Chunk[] => [delta({ content: text }), stop({ prompt_tokens: 10, completion_tokens: 3 })];

export async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function setupKernel(
  port?: number,
  confirmAnswers: boolean[] = [],
  extra: {
    terminals?: HandlerContext["terminals"];
    agentBrowser?: HandlerContext["agentBrowser"];
    pickFile?: () => Promise<string | null>;
    /** Hugging Face (chantier 5b) : câblage fourni par le CODE (base factice, réseau injectable, budgets de test). */
    huggingface?: HandlerContext["huggingface"];
    pickDestinationFolder?: DesktopShell["pickDestinationFolder"];
    /** Remplace la boîte de confirmation (réponse différée, par exemple). */
    confirm?: (message: string, detail: string, action?: string) => Promise<boolean>;
    /** Pas de boîte de confirmation native du tout. */
    noConfirm?: boolean;
    /** Entrée de démarrage de la session (SPECS-P5-TRAY.md § 2.4) : un DOUBLE, jamais le système. */
    loginItems?: { packaged: boolean; get(): boolean; set(on: boolean): void };
    dataRoot?: string;
  } = {},
) {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
  plugins.scheduler = { autoStart: false };
  plugins.gateways = { autoStart: false };
  plugins.mcp = { autoSync: false };
  plugins.agent = { runtimeLock: false, curatorTimer: false };
  plugins.updates = { appVersion: "0.1.0" };
  const app = (await bootApp(plugins)) as unknown as { agent: AgentRuntime; scheduler: Scheduler; gateways: GatewayHub; pluginHost?: DesktopKernel["pluginHost"]; rag?: { rag: NonNullable<DesktopKernel["rag"]> }; tools?: { sshHosts?: DesktopKernel["sshHosts"] }; llm?: { engine: NonNullable<DesktopKernel["localEngine"]>["engine"]; localModels?: NonNullable<DesktopKernel["localEngine"]>["models"]; detectHardware(): ReturnType<NonNullable<DesktopKernel["localEngine"]>["hardware"]> }; permissions?: NonNullable<DesktopKernel["permissions"]>; automation?: DesktopKernel["automation"] };
  // Comme `openDesktopKernel` : les règles de permissions de l'utilisateur viennent du storage et sont relues
  // à chaud. Sans ce branchement, les tests ne verraient jamais ce que la production voit (AV2-008).
  app.permissions?.initStorage(app.agent.settings);
  if (port) {
    app.agent.settings.patch({
      activeProvider: "custom",
      activeModel: "jarod-test-model",
      providerOverrides: { custom: { baseUrl: `http://127.0.0.1:${port}/v1`, models: ["jarod-test-model"] } },
      autoTitle: false,
    });
  }
  const kernel: DesktopKernel = { agent: app.agent, scheduler: app.scheduler, gateways: app.gateways, ...(app.pluginHost ? { pluginHost: app.pluginHost } : {}), ...(app.rag ? { rag: app.rag.rag } : {}), ...(app.tools?.sshHosts ? { sshHosts: app.tools.sshHosts } : {}), ...(app.permissions ? { permissions: app.permissions } : {}), ...(app.automation ? { automation: app.automation } : {}), ...(app.llm ? { localEngine: { engine: app.llm.engine, ...(app.llm.localModels ? { models: app.llm.localModels } : {}), hardware: () => app.llm!.detectHardware() } } : {}), profile: "default", dataRoot: extra.dataRoot ?? tempDir() };
  const sent: unknown[][] = [];
  const confirms: { message: string; detail: string; action?: string }[] = [];
  const shell = {
    appVersion: () => "0.1.0",
    quit: () => {},
    relaunch: () => {},
    writeClipboard: () => {},
    openExternal: async () => {},
    send: (channel: string, ...args: unknown[]) => void sent.push([channel, ...args]),
    tempDir: () => tempDir(),
    isInstalled: () => false,
    installSilently: () => {},
    openPath: async () => "",
    setThemeSource: () => {},
    spellChecker: () => ({ available: [], selected: [], preferredSystem: [] }),
    setSpellCheckerLanguages: () => {},
    logsDir: () => tempDir(),
    ...(extra.pickFile ? { pickFile: extra.pickFile } : {}),
    ...(extra.loginItems ? { loginItems: extra.loginItems } : {}),
    ...(extra.pickDestinationFolder ? { pickDestinationFolder: extra.pickDestinationFolder } : {}),
    ...(extra.noConfirm
      ? {}
      : {
          confirm: async (message: string, detail: string, action?: string) => {
            confirms.push({ message, detail, ...(action ? { action } : {}) });
            if (extra.confirm) return extra.confirm(message, detail, action);
            return confirmAnswers.shift() ?? false;
          },
        }),
  };
  const handlers = createHandlers({ kernel: () => kernel, shell, ...(extra.terminals ? { terminals: extra.terminals } : {}), ...(extra.agentBrowser ? { agentBrowser: extra.agentBrowser } : {}), ...(extra.huggingface ? { huggingface: extra.huggingface } : {}) });
  const call = (channel: string, ...args: unknown[]) => dispatchOneaiCall(handlers, channel, args, true) as Promise<unknown> | unknown;
  const on = (ch: string) => sent.filter(([c]) => c === ch).map(([, ...rest]) => rest);
  return { app, call, sent, on, confirms, kernel, handlers };
}

