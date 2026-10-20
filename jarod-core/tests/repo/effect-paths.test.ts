/**
 * Q19 — couverture des chemins d'effet par le garde (BESOINS Q19, PHASE-4 « Q19 ») : une MESURE, pas une réécriture.
 * Un kernel réel (tous les plugins locaux, base temporaire) ; le garde (`gate.decide`) et l'exécution de chaque
 * outil (`tool.run`) sont OBSERVÉS, jamais modifiés dans leur logique. Aucun modèle réel : un fournisseur scripté.
 *
 *   1. recensement : chaque outil et chaque commande du kernel est classé dans `effect-paths.ts` (un ajout non classé échoue) ;
 *   2. uniformité : pour LES 65 outils, un garde qui refuse ou une approbation refusée empêche l'exécution ;
 *   3. points d'entrée : composer, tâche planifiée, message de passerelle → l'exécution est TOUJOURS précédée du garde ;
 *   4. les deux chemins qui n'y passaient pas sont corrigés et testés : sous-agents (Q19-1) et commandes `/` d'une passerelle (Q19-2) ;
 *   5. tripwires de source : les sites d'appel de `tool.run`, `executeGuardedTool`, `commands.execute`, `ipcMain.handle`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { bootApp, cleanup, discoverPlugins, tempDir } from "@jarod/kernel/testing";
import { executeGuardedTool } from "@jarod/plugin-agent";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { COMMANDS, TOOLS, WINDOWS_ONLY } from "./effect-paths.js";

const ROOT = resolve(import.meta.dirname, "../..");
afterEach(cleanup);

type Any = any; // le kernel est un objet cordis à services dynamiques : on n'en type que ce qu'on observe

async function boot() {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
  plugins.scheduler = { autoStart: false };
  plugins.gateways = { autoStart: false };
  const app: Any = await bootApp(plugins);
  const core: Any = app.agent;
  core.settings.set("autoTitle", false);
  return { app, core };
}

/** Les outils qui doivent RÉELLEMENT tourner pour que le chemin étudié existe (lancer un sous-agent). */
const PASS_THROUGH = new Set(["delegate_task", "spawn_subagent", "subagent_result", "subagent_list"]);

/** Observe le garde et l'exécution : `decide:<outil>` puis `run:<outil>` ; les autres outils ne font RIEN (espions). */
function observe(core: Any): string[] {
  const log: string[] = [];
  const inner = core.gate;
  Object.defineProperty(core, "gate", {
    configurable: true,
    value: {
      decide: (name: string) => {
        log.push(`decide:${name}`);
        return inner.decide(name);
      },
    },
  });
  for (const t of core.tools.all()) {
    const real = t.run.bind(t);
    t.run = async (args: Any, ctx: Any) => {
      log.push(`run:${t.name}`);
      return PASS_THROUGH.has(t.name) ? real(args, ctx) : "ok";
    };
  }
  return log;
}

/** Fournisseur scripté : le tour principal et le sous-agent appellent chacun UN outil, puis concluent. */
function script(core: Any, main: { name: string; args?: object }, sub?: { name: string; args?: object }): void {
  core.providers.client = () => ({
    chat: async (req: Any) => {
      const isSub = String(req.system ?? "").includes("## Sous-agent");
      const plan = isSub ? sub : main;
      const done = req.messages.some((m: Any) => m.role === "tool");
      if (!plan || done) return { text: isSub ? "compte rendu" : "fini", thinking: "", toolCalls: [], stopReason: "stop" };
      return { text: "", thinking: "", toolCalls: [{ id: "c1", name: plan.name, args: plan.args ?? {} }], stopReason: "tool_use" };
    },
    listModels: async () => [],
  });
}

const approveWith = (answer: boolean, asked: string[] = []) => ({
  emit: () => {},
  approve: async (_id: string, call: { name: string }) => {
    asked.push(call.name);
    return answer;
  },
});

const schedule = (prompt: string): Any => ({
  id: "sch-1",
  name: "test",
  prompt,
  spec: { kind: "interval", minutes: 60 },
  sessionId: null,
  enabled: true,
  lastRun: null,
  nextRun: null,
  lastStatus: null,
  createdAt: 0,
  deliver: null,
});

const waitFor = async (ok: () => boolean, ms = 5_000) => {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("Q19 — 1. recensement des outils et des commandes", () => {
  it("les 65 outils du registre (79 sous Windows, avec les 14 outils système) sont tous classés (et rien d'autre)", async () => {
    const { core } = await boot();
    const names = core.tools.all().map((t: Any) => t.name).sort();
    const expected = Object.keys(TOOLS).filter((n) => process.platform === "win32" || !WINDOWS_ONLY.has(n));
    expect(names).toEqual(expected.sort());
    expect(expected.length).toBe(process.platform === "win32" ? 79 : 65);
  });

  it("un outil qui a un effet exige l'accord de l'utilisateur, ou dit pourquoi non", async () => {
    const { core } = await boot();
    for (const t of core.tools.all()) {
      const c = TOOLS[t.name]!;
      expect(Boolean(t.dangerous), `${t.name} : approbation du registre`).toBe(c.approval);
      if (c.effect !== "lecture" && !c.approval) expect(c.why, `${t.name} : raison de l'absence d'accord`).toBeTruthy();
    }
  });

  it("les 31 commandes `/` sont toutes classées (et rien d'autre)", async () => {
    const { core } = await boot();
    const names = core.commands.list().map((c: Any) => c.name).sort();
    expect(names).toEqual(Object.keys(COMMANDS).sort());
  });
});

describe("Q19 — 2. uniformité du garde sur tout le registre", () => {
  it("garde qui refuse, ou accord refusé : AUCUN des outils ne s'exécute", async () => {
    const { core } = await boot();
    const log = observe(core);
    const s = core.sessions.create();
    const settings = core.settings.getAll();
    const signal = new AbortController().signal;
    const deny = { decide: () => "deny" as const };
    const ask = { decide: () => "ask" as const };
    for (const t of core.tools.all()) {
      const call = { id: "x", name: t.name, args: {} };
      const denied = await executeGuardedTool(core.tools, s.id, call, signal, approveWith(true), settings, { gate: deny });
      expect(denied.isError, `${t.name} sous deny`).toBe(true);
      const refused = await executeGuardedTool(core.tools, s.id, call, signal, approveWith(false), settings, { gate: ask });
      expect(refused.isError, `${t.name} sous ask, accord refusé`).toBe(true);
    }
    expect(log.filter((l) => l.startsWith("run:"))).toEqual([]);
  });

  it("un outil dangereux, accord refusé, ne s'exécute pas même sous `allow` ; le témoin non dangereux s'exécute", async () => {
    const { core } = await boot();
    const log = observe(core);
    const s = core.sessions.create();
    const settings = { ...core.settings.getAll(), autoApproveTools: false };
    const signal = new AbortController().signal;
    const allow = { decide: () => "allow" as const };
    const r = await executeGuardedTool(core.tools, s.id, { id: "a", name: "write_file", args: { path: "a", content: "b" } }, signal, approveWith(false), settings, { gate: allow });
    expect(r).toMatchObject({ isError: true, content: expect.stringMatching(/refusé/) });
    expect(log).toEqual([]);
    await executeGuardedTool(core.tools, s.id, { id: "b", name: "state_list", args: {} }, signal, approveWith(false), settings, { gate: allow });
    expect(log).toEqual(["run:state_list"]);
  });

  it("le garde du kernel est fail-closed : un outil inconnu est refusé, un outil déclaré passe", async () => {
    const { app } = await boot();
    const gate = app.permissions.gate((n: string) => n === "declare");
    expect(gate.decide("inconnu")).toBe("deny");
    expect(gate.decide("declare")).toBe("allow");
  });
});

describe("Q19 — 3. points d'entrée qui passent par le garde", () => {
  it("le réglage `autoApproveTools` est éteint par défaut", async () => {
    const { core } = await boot();
    expect(core.settings.get("autoApproveTools")).toBe(false);
  });

  it("composer (tour d'agent) : le garde précède l'exécution ; un outil dangereux sans accord ne s'exécute pas", async () => {
    const { core } = await boot();
    const log = observe(core);
    script(core, { name: "state_list" });
    const s = core.sessions.create();
    await core.runAndWait(s.id, "go", approveWith(true));
    expect(log).toEqual(["decide:state_list", "run:state_list"]);

    log.length = 0;
    script(core, { name: "write_file", args: { path: "a", content: "b" } });
    const asked: string[] = [];
    const s2 = core.sessions.create();
    await core.runAndWait(s2.id, "go", approveWith(false, asked));
    expect(log).toEqual(["decide:write_file"]);
    expect(asked).toEqual(["write_file"]);
  });

  it("tâche planifiée : garde d'abord ; les accords sont refusés d'office (`backgroundHooks`)", async () => {
    const { core } = await boot();
    const log = observe(core);
    script(core, { name: "state_list" });
    await core.runSchedule(schedule("go"));
    expect(log).toEqual(["decide:state_list", "run:state_list"]);

    log.length = 0;
    script(core, { name: "run_shell", args: { command: "echo x" } });
    await core.runSchedule(schedule("go"));
    expect(log).toEqual(["decide:run_shell"]);
  });

  it("message de passerelle : garde d'abord ; les accords sont refusés d'office", async () => {
    const { app, core } = await boot();
    const log = observe(core);
    script(core, { name: "state_list" });
    await app.gateways.handleGatewayMessage("telegram", "chat-1", "bonjour", "ana");
    expect(log).toEqual(["decide:state_list", "run:state_list"]);

    log.length = 0;
    script(core, { name: "write_file", args: { path: "a", content: "b" } });
    await app.gateways.handleGatewayMessage("telegram", "chat-2", "écris", "ana");
    expect(log).toEqual(["decide:write_file"]);
  });

  it("une règle `deny` de la configuration bloque l'outil sur les trois entrées", async () => {
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
    plugins.scheduler = { autoStart: false };
    plugins.gateways = { autoStart: false };
    plugins.permissions = { rules: [{ tool: "state_list", decision: "deny" }] };
    const app: Any = await bootApp(plugins);
    const core: Any = app.agent;
    core.settings.set("autoTitle", false);
    const log = observe(core);
    script(core, { name: "state_list" });
    await core.runAndWait(core.sessions.create().id, "go", approveWith(true));
    await core.runSchedule(schedule("go"));
    await app.gateways.handleGatewayMessage("telegram", "chat-3", "go", "ana");
    expect(log).toEqual(["decide:state_list", "decide:state_list", "decide:state_list"]);
  });
});

describe("Q19-1 (corrigé) — les sous-agents passent par le garde et l'audit", () => {
  it("un sous-agent (delegate_task) consulte le garde AVANT chaque outil", async () => {
    const { core } = await boot();
    const log = observe(core);
    script(core, { name: "delegate_task", args: { task: "explore" } }, { name: "state_get", args: { key: "k" } });
    await core.runAndWait(core.sessions.create().id, "go", approveWith(true));
    expect(log).toEqual(["decide:delegate_task", "run:delegate_task", "decide:state_get", "run:state_get"]);
  });

  it("même chose pour un sous-agent non bloquant (spawn_subagent)", async () => {
    const { core } = await boot();
    const log = observe(core);
    script(core, { name: "spawn_subagent", args: { task: "explore" } }, { name: "state_get", args: { key: "k" } });
    const s = core.sessions.create();
    await core.runAndWait(s.id, "go", approveWith(true));
    await waitFor(() => log.includes("run:state_get"));
    expect(log).toEqual(["decide:spawn_subagent", "run:spawn_subagent", "decide:state_get", "run:state_get"]);
  });

  it("une règle `deny` de l'utilisateur sur un outil de lecture EST appliquée à un sous-agent : l'outil ne s'exécute pas", async () => {
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
    plugins.scheduler = { autoStart: false };
    plugins.permissions = { rules: [{ tool: "state_get", decision: "deny" }] };
    const app: Any = await bootApp(plugins);
    const core: Any = app.agent;
    core.settings.set("autoTitle", false);
    const log = observe(core);
    script(core, { name: "state_get", args: { key: "k" } });
    await core.runAndWait(core.sessions.create().id, "go", approveWith(true));
    expect(log).toEqual(["decide:state_get"]); // le tour principal respecte la règle…
    log.length = 0;
    script(core, { name: "delegate_task", args: { task: "explore" } }, { name: "state_get", args: { key: "k" } });
    await core.runAndWait(core.sessions.create().id, "go", approveWith(true));
    expect(log).toContain("decide:state_get"); // …le sous-agent aussi.
    expect(log).not.toContain("run:state_get");
    expect(core.auditLog().map((e: Any) => [e.tool, e.decision]).filter(([t]: [string]) => t === "state_get")).toEqual([
      ["state_get", "refusé (règle)"],
      ["state_get", "refusé (règle)"],
    ]);
  });

  it("un `ask` de l'utilisateur sur un outil de lecture, sous un sous-agent en lecture seule : aucun accord possible → l'outil ne s'exécute pas", async () => {
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
    plugins.scheduler = { autoStart: false };
    plugins.permissions = { rules: [{ tool: "state_get", decision: "ask" }] };
    const app: Any = await bootApp(plugins);
    const core: Any = app.agent;
    core.settings.set("autoTitle", false);
    const log = observe(core);
    script(core, { name: "delegate_task", args: { task: "explore" } }, { name: "state_get", args: { key: "k" } });
    await core.runAndWait(core.sessions.create().id, "go", approveWith(true));
    expect(log).toContain("decide:state_get");
    expect(log).not.toContain("run:state_get");
  });

  it("variante « sous-agent qui écrit » (`opts.write`, aucun appelant de production) : garde, accord et audit comme le tour principal", async () => {
    const { core } = await boot();
    const log = observe(core);
    const s = core.sessions.create();
    const write = (approve: boolean, autoApproved: string[] = []) => ({
      write: { approve: async () => approve, autoApproved: new Set<string>(autoApproved) },
    });
    const audited = () => core.auditLog().map((e: Any) => [e.tool, e.decision]).reverse();
    script(core, { name: "state_list" }, { name: "write_file", args: { path: "a", content: "b" } });
    await core.agent.runSubAgent("écris", undefined, s.id, 3, write(true));
    expect(log).toEqual(["decide:write_file", "run:write_file"]);
    expect(audited()).toEqual([["write_file", "accordé"]]);
    log.length = 0;
    await core.agent.runSubAgent("écris", undefined, s.id, 3, write(false));
    expect(log).toEqual(["decide:write_file"]); // accord refusé → 0 exécution
    log.length = 0;
    await core.agent.runSubAgent("écris", undefined, s.id, 3, write(false, ["write_file"]));
    expect(log).toEqual(["decide:write_file", "run:write_file"]); // outil déjà autorisé par l'appelant
    expect(audited()).toEqual([
      ["write_file", "accordé"],
      ["write_file", "refusé"],
      ["write_file", "automatique"],
    ]);
  });

  it("en mode Plan, le sous-agent qui écrit est bloqué comme le tour principal", async () => {
    const { core } = await boot();
    const log = observe(core);
    core.settings.set("agentMode", "plan");
    const s = core.sessions.create();
    script(core, { name: "state_list" }, { name: "write_file", args: { path: "a", content: "b" } });
    await core.agent.runSubAgent("écris", undefined, s.id, 3, { write: { approve: async () => true, autoApproved: new Set<string>() } });
    expect(log).toEqual([]);
    expect(core.auditLog().map((e: Any) => e.decision)).toEqual(["bloqué (mode Plan)"]);
  });
});

describe("Q19-2 (corrigé) — les commandes `/` d'une passerelle passent par le garde et les accords", () => {
  const refuse = { emit: () => {}, approve: async () => false };

  it("`/build` reçu d'une passerelle ne lève PAS le mode Plan : accord requis, refusé d'office, audité", async () => {
    const { app, core } = await boot();
    core.settings.set("agentMode", "plan");
    const r = await app.gateways.handleGatewayMessage("telegram", "chat-9", "/build", "ana");
    expect(String(r)).toMatch(/demande un accord.*application/);
    expect(core.settings.get("agentMode")).toBe("plan");
    expect(core.auditLog().map((e: Any) => [e.tool, e.decision])).toEqual([["command/build", "refusé"]]);
    // Seuls `/new` et `/pair` sont toujours traités à part par la passerelle.
    expect(String(await app.gateways.handleGatewayMessage("telegram", "chat-9", "/pair approve 000000", "ana"))).toMatch(/uniquement dans l'application/);
  });

  it("une commande de lecture (`/status`, `/model` sans argument) s'exécute sans accord ; `/model x` change le modèle → refusé", async () => {
    const { app, core } = await boot();
    const before = core.settings.get("activeModel");
    expect(String(await app.gateways.handleGatewayMessage("telegram", "chat-9", "/status", "ana"))).not.toMatch(/accord/);
    expect(String(await app.gateways.handleGatewayMessage("telegram", "chat-9", "/model", "ana"))).toMatch(/Modèle actuel/);
    expect(String(await app.gateways.handleGatewayMessage("telegram", "chat-9", "/model autre-modele", "ana"))).toMatch(/accord/);
    expect(core.settings.get("activeModel")).toBe(before);
    expect(core.auditLog().map((e: Any) => [e.tool, e.decision])).toEqual([["command/model", "refusé"]]);
  });

  it("chaque commande classée à effet est refusée depuis une passerelle ; chaque commande de lecture/interface déclarée s'exécute", async () => {
    const { core } = await boot();
    const sid = core.sessions.create().id;
    const ran: string[] = [];
    for (const [name, cls] of Object.entries(COMMANDS)) {
      const def = core.commands.get(name);
      expect(def, name).toBeTruthy();
      def.run = async () => {
        ran.push(name);
        return { text: "ok" };
      };
      const readable = (cls.effect === "lecture" || cls.effect === "interface") && def.source === "builtin";
      const r = await core.executeRemoteCommand(readable ? `/${name}` : `/${name} x`, sid, refuse);
      expect(ran.includes(name), `${name} → ${JSON.stringify(r)}`).toBe(readable);
      ran.length = 0;
    }
  });

  it("une commande de plugin (sans déclaration `readOnly`) est traitée comme ayant un effet : refusée (fail-closed)", async () => {
    const { core } = await boot();
    expect(core.commands.get("roll")?.source).toBe("plugin");
    expect(String((await core.executeRemoteCommand("/roll 2d6", core.sessions.create().id, refuse))?.text)).toMatch(/accord/);
  });

  it("une règle `command` (ou `command/<nom>`) est appliquée : `deny` bloque même une lecture ; `ask` exige l'accord même pour une lecture", async () => {
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
    plugins.scheduler = { autoStart: false };
    plugins.gateways = { autoStart: false };
    plugins.permissions = {
      rules: [
        { tool: "command/version", decision: "deny" },
        { tool: "command/status", decision: "ask" },
      ],
    };
    const app: Any = await bootApp(plugins);
    const core: Any = app.agent;
    const sid = core.sessions.create().id;
    expect(String((await core.executeRemoteCommand("/version", sid, refuse))?.text)).toMatch(/Refusé par la politique/);
    expect(String((await core.executeRemoteCommand("/status", sid, refuse))?.text)).toMatch(/accord/);
    expect(String((await core.executeRemoteCommand("/status", sid, approveWith(true)))?.text)).not.toMatch(/accord/);
    expect(core.auditLog().map((e: Any) => [e.tool, e.decision]).reverse()).toEqual([
      ["command/version", "refusé (règle)"],
      ["command/status", "refusé"],
      ["command/status", "accordé"],
    ]);
  });

  it("si un accord est donné (canal interactif futur), la commande s'exécute et l'audit garde « accordé »", async () => {
    const { core } = await boot();
    core.settings.set("agentMode", "plan");
    const asked: string[] = [];
    await core.executeRemoteCommand("/build", core.sessions.create().id, approveWith(true, asked));
    expect(asked).toEqual(["command/build"]);
    expect(core.settings.get("agentMode")).toBe("build");
    expect(core.auditLog().some((e: Any) => e.tool === "command/build" && e.decision === "accordé")).toBe(true);
  });

  it("`autoApproveTools` ne lève pas l'accord d'une commande distante (il règle les outils, pas les commandes)", async () => {
    const { core } = await boot();
    core.settings.set("autoApproveTools", true);
    core.settings.set("agentMode", "plan");
    await core.executeRemoteCommand("/build", core.sessions.create().id, refuse);
    expect(core.settings.get("agentMode")).toBe("plan");
  });
});

describe("Q19 — 5. tripwires de source (sites d'appel)", () => {
  const SRC_SKIP = new Set(["node_modules", "dist", "out", "sank", "test", "coverage"]);
  function sources(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (SRC_SKIP.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) sources(p, out);
      else if (/\.(ts|tsx|cjs|mjs)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
    }
    return out;
  }
  const files = sources(join(ROOT, "packages")).filter((f) => f.includes(`${join("packages")}`) && /[\\/]src[\\/]/.test(f));
  const count = (re: RegExp) => {
    const hits: Record<string, number> = {};
    for (const f of files) {
      const n = (readFileSync(f, "utf8").match(re) ?? []).length;
      if (n) hits[relative(ROOT, f).replaceAll("\\", "/")] = n;
    }
    return hits;
  };

  it("`executeGuardedTool` : définie et appelée dans agent.ts seulement (un seul guichet)", () => {
    expect(existsSync(join(ROOT, "packages/plugins/agent/src/agent.ts"))).toBe(true);
    expect(count(/\bexecuteGuardedTool\(/g)).toEqual({ "packages/plugins/agent/src/agent.ts": 2 }); // définition + `executeTool`
    // `executeTool` sert le tour principal ET les sous-agents (Q19-1) : un nouvel appelant de `executeGuardedTool` ferait échouer ceci.
    expect(count(/\bthis\.executeTool\(/g)).toEqual({ "packages/plugins/agent/src/agent.ts": 2 });
  });

  it("appels directs `tool.run(` : le guichet seul et le processus isolé des plugins", () => {
    expect(count(/\b(?:tool|roll|t)\.run\(/g)).toEqual({
      "packages/plugins/agent/src/agent.ts": 1, // executeGuardedTool seul : le sous-agent y passe aussi (Q19-1 corrigé)
      "packages/plugins/workflows/src/runner.cjs": 1, // dans le processus du plugin, appelé par le registre (donc gardé en amont)
    });
  });

  it("`commands.execute(` : le composer seul ; la passerelle passe par `executeRemoteCommand` (Q19-2 corrigé)", () => {
    // 2026-10-11 : la passerelle Jarod-OS (`packages/cli/src/gateway/server.ts`, `slash.exec`) est le DEUXIÈME composer — l'interface de Herald, pilotée par l'utilisateur —
    // et appelle `commands.execute` pour les commandes courantes ; celles qui changent la posture de sécurité (`GUARDED_COMMANDS`) passent par `executeRemoteCommand`
    // (règle, accord dans la carte de Herald, audit). Voir DECISIONS.md, entrée du 2026-10-11 « slash.exec ».
    expect(count(/\.commands\.execute\(/g)).toEqual({ "packages/plugins/agent/src/runtime.ts": 1, "packages/cli/src/gateway/server.ts": 1 });
    expect(count(/\.executeRemoteCommand\(/g)).toEqual({ "packages/plugins/gateways/src/hub.ts": 1, "packages/cli/src/gateway/server.ts": 1 });
    // …et le garde des commandes est le seul autre appelant de `execute`.
    expect(count(/\bcommands\.execute\(/g)).toEqual({
      "packages/plugins/agent/src/command-guard.ts": 2,
      "packages/plugins/agent/src/runtime.ts": 1,
      "packages/cli/src/gateway/server.ts": 1,
    });
  });

  it("Q19-5 : `portability.apply(` n'a que les deux chemins d'import (ligne de commande, handler du shell), tous deux après confirmations ; le service n'écrit des réglages qu'à deux endroits (liste blanche, fusion MCP)", () => {
    // 2026-10-12 : la ligne de commande (`jarod portability apply`, `--approve-mcp` obligatoire, l.60-68) et le handler
    // d'import du shell (`backup.ts`) sont les deux seuls sites. Le second est encadré par la sélection de fichier native,
    // `gate.userChosen`, la vérification du `manifest.json` et DEUX confirmations natives (`ctx.shell.confirm`) ; l'appel
    // est construit à partir du plan inspecté, donc `approve` ne peut pas élargir ce que l'utilisateur a vu. Le script de
    // maintenance (`scripts/portability-apply.mjs`, `--approve-mcp` obligatoire lui aussi) vit hors de `packages/`, donc
    // hors de ce recensement.
    expect(count(/\bportability\.apply\(/g)).toEqual({
      "packages/bridge/src/main/handlers/backup.ts": 1,
      "packages/cli/src/portability.ts": 1,
    });
    expect(count(/\bthis\.d\.settings\.set\(/g)["packages/plugins/memory/src/portability.ts"]).toBe(2);
  });

  // Jarod-OS : le noyau n'a plus d'IPC Electron (le shell parle à la passerelle en JSON-RPC) ; aucun `ipcMain` ne doit réapparaître dans le noyau.
  it("aucun `ipcMain` dans le noyau", () => {
    // 2026-10-12 : le noyau ne dépend d'Electron nulle part, et c'est la garde qui compte : un `import { ipcMain } from "electron"`
    // ne compilerait même pas hors d'Electron.
    expect(count(/from\s+["']electron["']|require\(["']electron["']\)/g)).toEqual({});
    // Le seul `ipcMain` restant est le transport INJECTÉ de l'ancien guichet (`IpcMainLike`, un paramètre de
    // `registerOneaiHandlers`) : aucun fichier du noyau n'en fabrique. Le shell passe par `jarod.invoke` (JSON-RPC) ;
    // `dispatchOneaiCall` n'a que des appelants de test, `registerOneaiHandlers` aucun appelant de production.
    expect(count(/\bipcMain\.(?:handle|on|once)\(/g)).toEqual({ "packages/bridge/src/main/ipc.ts": 1 });
  });
});

describe("Q19-4 (corrigé) — l'accord d'un outil de plugin est fixé par l'utilisateur, jamais par le plugin", () => {
  const refuse = { emit: () => {}, approve: async () => false };
  const allow = { decide: () => "allow" as const };
  const run = (core: Any, hooks: Any, name = "des_roll_dice") =>
    executeGuardedTool(core.tools, core.sessions.create().id, { id: "c", name, args: { spec: "1d6" } }, new AbortController().signal, hooks, { ...core.settings.getAll(), autoApproveTools: false }, { gate: allow });

  it("l'outil d'exemple du plugin (qui se déclare non dangereux) exige l'accord : refusé, il ne tourne pas ; sans porte d'accord (passerelle, tâche) idem", async () => {
    const { core } = await boot();
    const tool = core.tools.get("des_roll_dice");
    expect(tool).toMatchObject({ source: "plugin", dangerous: true, declaredDangerous: false });
    expect(await run(core, refuse)).toMatchObject({ isError: true, content: expect.stringMatching(/refusé/) });
    expect(await run(core, core.backgroundHooks)).toMatchObject({ isError: true });
    expect(JSON.parse((await run(core, approveWith(true))).content).total).toBeGreaterThan(0);
  });

  it("`/plugin trust` au composer classe l'outil sans accord (lui seul, lié à l'empreinte) ; `/plugin list` le dit ; `distrust` rétablit", async () => {
    const { app, core } = await boot();
    const sid = core.sessions.create().id;
    const say = async (input: string) => String((await core.commands.execute(input, { sessionId: sid }))?.text);
    expect(await say("/plugin")).toMatch(/des_roll_dice[^\n]*accord à chaque appel/);
    expect(await say("/plugin trust des roll_dice")).toMatch(/SANS accord.*empreinte [0-9a-f]{12}/);
    expect(core.tools.get("des_roll_dice").dangerous).toBe(false);
    expect(core.settings.get("pluginTrust").des.tools).toEqual(["des_roll_dice"]);
    expect(await say("/plugin list")).toMatch(/des_roll_dice[^\n]*SANS accord \(classé par vous\)/);
    expect(JSON.parse((await run(core, refuse)).content).total).toBeGreaterThan(0); // sans demander, même sous un refus
    expect(app.pluginHost.list().find((p: Any) => p.id === "des").trusted).toEqual(["des_roll_dice"]);
    expect(await say("/plugin distrust des")).toMatch(/de nouveau demandé/);
    expect(core.tools.get("des_roll_dice").dangerous).toBe(true);
    expect(await say("/plugin trust des inexistant")).toMatch(/Outil inconnu/);
    expect(core.settings.get("pluginTrust")).toEqual({});
  });

  it("depuis une passerelle : `/plugin list` s'exécute, `/plugin trust` est REFUSÉ (accord, audité) et l'outil reste dangereux", async () => {
    const { app, core } = await boot();
    expect(String(await app.gateways.handleGatewayMessage("telegram", "chat-7", "/plugin", "ana"))).toMatch(/Plugins/);
    const r = await app.gateways.handleGatewayMessage("telegram", "chat-7", "/plugin trust des roll_dice", "ana");
    expect(String(r)).toMatch(/demande un accord.*application/);
    expect(core.tools.get("des_roll_dice").dangerous).toBe(true);
    expect(core.settings.get("pluginTrust")).toEqual({});
    expect(core.auditLog().map((e: Any) => [e.tool, e.decision])).toEqual([["command/plugin", "refusé"]]);
  });
});
