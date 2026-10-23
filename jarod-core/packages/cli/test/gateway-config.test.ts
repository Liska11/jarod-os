// Passerelle compatible Hermes (essai) : la section « Hermes & agents » des Réglages de Herald (modèle, autonomie, groupes d'outils, terrain d'exécution)
// et les commandes `/`. Logique pure avec des faux, puis le VRAI noyau par WebSocket et HTTP.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText } from "@jarod/kernel/redact";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyConfigPatch, checkTerminalBackend, commandCatalog, ConfigError, configGet, configRaw, configSet, modelOptions, normalizeModelCommand, parseModelChoice, type ProviderLike, setApprovalMode, setToolsetEnabled,
  slashResult, terminalBackends, toolsets,
} from "../src/gateway/config.js";
import { openCore } from "../src/context.js";
import { createGateway } from "../src/gateway/server.js";

const providers: ProviderLike[] = [
  { id: "anthropic", name: "Anthropic", models: ["claude-a", "claude-b"], baseUrl: "https://api.anthropic.com", configured: true },
  { id: "openai", name: "OpenAI", models: ["gpt-x"], baseUrl: "https://api.openai.com/v1", configured: false },
  { id: "ollama", name: "Ollama", models: [], baseUrl: "http://127.0.0.1:11434", local: true, configured: true },
];

function fakeSettings(initial: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = { activeProvider: "anthropic", activeModel: "claude-a", autoApproveTools: false, disabledTools: [], ...initial };
  return { state, get: (k: string) => state[k], patch: (p: Record<string, unknown>) => void Object.assign(state, p) };
}

describe("modèle", () => {
  it("model.options : fournisseurs configurés seulement, ou tous ; le courant est marqué ; un serveur local n'a pas de clé", () => {
    const s = fakeSettings();
    const only = modelOptions(providers, s, false);
    expect(only.providers.map((p) => p.slug)).toEqual(["anthropic", "ollama"]);
    expect(only).toMatchObject({ provider: "anthropic", model: "claude-a" });
    expect(only.providers[0]).toMatchObject({ is_current: true, authenticated: true, auth_type: "api_key", total_models: 2, models: ["claude-a", "claude-b"] });
    expect(only.providers[1]).toMatchObject({ is_current: false, auth_type: "none", models: [] });
    expect(modelOptions(providers, s, true).providers.map((p) => p.slug)).toEqual(["anthropic", "openai", "ollama"]);
  });

  it("model.options d'un profil qui n'a rien choisi : pas de modèle courant, les serveurs locaux d'abord, `needs_choice` ; un profil qui a choisi ne change pas", () => {
    const written = new Set<string>();
    const s = { ...fakeSettings(), isSet: (k: string) => written.has(k) };
    const blank = modelOptions(providers, s, false);
    expect(blank).toMatchObject({ provider: "", model: "", needs_choice: true });
    expect(blank.providers.map((p) => p.slug)).toEqual(["ollama", "anthropic"]); // le serveur local avant le service payant, malgré l'ordre d'origine
    expect(blank.providers.some((p) => p.is_current)).toBe(false);
    written.add("activeProvider"); // à moitié écrit n'est pas choisi
    expect(modelOptions(providers, s, false)).toMatchObject({ provider: "", needs_choice: true });
    written.add("activeModel");
    const chosen = modelOptions(providers, s, false);
    expect(chosen).toMatchObject({ provider: "anthropic", model: "claude-a" });
    expect(chosen).not.toHaveProperty("needs_choice");
    expect(chosen.providers.map((p) => p.slug)).toEqual(["anthropic", "ollama"]);
    expect(modelOptions(providers, fakeSettings(), false)).toMatchObject({ provider: "anthropic" }); // un faux noyau sans isSet : le choix est supposé fait
  });

  it("parseModelChoice : fournisseur:modèle, fournisseur/modèle, modèle seul (fournisseur courant) ; vide refusé", () => {
    expect(parseModelChoice("openai:gpt-x", providers, "anthropic")).toEqual({ activeProvider: "openai", activeModel: "gpt-x" });
    expect(parseModelChoice("openai/gpt-x", providers, "anthropic")).toEqual({ activeProvider: "openai", activeModel: "gpt-x" });
    expect(parseModelChoice("claude-b", providers, "anthropic")).toEqual({ activeProvider: "anthropic", activeModel: "claude-b" });
    // Un nom de modèle qui contient « / » sans être un fournisseur reste un modèle.
    expect(parseModelChoice("meta/llama-3", providers, "ollama")).toEqual({ activeProvider: "ollama", activeModel: "meta/llama-3" });
    expect(() => parseModelChoice("  ", providers, "anthropic")).toThrow(ConfigError);
  });
});

// Herald lit ce YAML pour trouver le fournisseur actif (apps/desktop/src/lib/hermes-auth.ts `parseActiveProvider`) : même expression ici.
const jarodActiveProvider = (yaml: string): string | null => {
  const block = /^model:\s*\n((?:[ \t]+.*\n?)*)/m.exec(yaml);
  const match = block ? /^[ \t]+provider:\s*['"]?([\w.-]+)['"]?/m.exec(block[1]!) : null;
  return match?.[1] ?? null;
};
const SECRET_SHAPE = ["sk", "CANARI-RAW-0123456789abcdef0123"].join("-");

describe("config/raw : une vue en lecture seule du modèle actif", () => {
  it("ne contient que model.provider et model.default, et Herald y retrouve le fournisseur actif", () => {
    const s = fakeSettings({ activeProvider: "lmstudio", activeModel: "qwen3-8b", providerOverrides: { lmstudio: { baseUrl: "http://u:p@127.0.0.1:1234/v1" } }, apiKey: "x" });
    const { yaml } = configRaw(s);
    expect(yaml).toBe('model:\n  provider: "lmstudio"\n  default: "qwen3-8b"\n');
    expect(jarodActiveProvider(yaml)).toBe("lmstudio");
    expect(yaml).not.toMatch(/baseUrl|127\.0\.0\.1|providerOverrides|apiKey/);
    expect(configRaw(fakeSettings({ activeProvider: "", activeModel: "" })).yaml).toBe("model:\n");
  });

  it("une valeur qui ressemble à une clé n'apparaît jamais (réglage collé par erreur dans le nom du modèle)", () => {
    const { yaml } = configRaw(fakeSettings({ activeProvider: "custom", activeModel: SECRET_SHAPE }));
    expect(yaml).not.toContain(SECRET_SHAPE);
    expect(yaml).not.toMatch(/CANARI/);
    expect(redactText(yaml)).toBe(yaml); // plus rien que le masqueur de Jarod reconnaîtrait comme un secret
    expect(jarodActiveProvider(yaml)).toBe("custom");
  });

  it("les guillemets et retours à la ligne d'un nom de modèle ne cassent pas le YAML", () => {
    const { yaml } = configRaw(fakeSettings({ activeProvider: "custom", activeModel: 'a"b\nprovider: pirate' }));
    expect(jarodActiveProvider(yaml)).toBe("custom");
    expect(yaml.split("\n").filter((l) => l.startsWith("  provider:"))).toHaveLength(1);
  });
});

describe("/model envoyé par le sélecteur de Herald (fournisseur:modèle)", () => {
  const list: ProviderLike[] = [...providers, { id: "openrouter", name: "OpenRouter", models: [], baseUrl: "https://openrouter.ai/api/v1", configured: true }];
  it("réécrit « fournisseur:modèle » en « fournisseur/modèle » (la forme que la commande de Jarod lit) quand le premier segment est un fournisseur connu", () => {
    expect(normalizeModelCommand("/model ollama:qwen3.5:0.8b", list)).toBe("/model ollama/qwen3.5:0.8b");
    expect(normalizeModelCommand("/model openrouter:anthropic/claude-x", list)).toBe("/model openrouter/anthropic/claude-x");
    expect(normalizeModelCommand("/MODEL  anthropic:claude-b ", list)).toBe("/model anthropic/claude-b");
  });
  it("laisse intact tout le reste : nom de modèle contenant « : », forme avec « / », sans argument, vide après les deux-points, autre commande", () => {
    for (const same of ["/model llama3:8b", "/model qwen3.5:0.8b", "/model ollama/qwen3:8b", "/model", "/model ollama:", "/model :x", "/models ollama:x", "/help ollama:x", "/model ollama:x y"]) {
      expect(normalizeModelCommand(same, list), same).toBe(same);
    }
  });
});

describe("autonomie", () => {
  it("lue : « manual » tant que l'approbation automatique est coupée, « off » si elle est allumée", () => {
    expect(configGet("approvals.mode", fakeSettings(), providers)).toEqual({ value: "manual" });
    expect(configGet("approvals.mode", fakeSettings({ autoApproveTools: true }), providers)).toEqual({ value: "off" });
  });

  it("écrite : seul « manual » passe (et éteint l'approbation automatique) ; « off » et « smart » sont refusés SANS rien changer", () => {
    const s = fakeSettings({ autoApproveTools: true });
    expect(setApprovalMode("manual", s)).toBe("manual");
    expect(s.state.autoApproveTools).toBe(false);
    for (const mode of ["off", "smart", "OFF"]) {
      const t = fakeSettings();
      expect(() => setApprovalMode(mode, t), mode).toThrow(/propre écran de réglages/);
      expect(t.state.autoApproveTools).toBe(false);
    }
    expect(() => setApprovalMode("yolo", s)).toThrow(/Mode inconnu/);
    expect(() => setApprovalMode(undefined, s)).toThrow(/Mode inconnu/);
  });
});

describe("config.get / config.set / PUT /api/config", () => {
  it("clés portées : approvals.mode, model, provider, full ; les autres sont une erreur nette", () => {
    const s = fakeSettings();
    expect(configGet("model", s, providers)).toMatchObject({ value: "claude-a", provider: "anthropic" });
    expect(configGet("provider", s, providers)).toMatchObject({ model: "claude-a", provider: "anthropic", providers: [{ id: "anthropic", label: "Anthropic", authenticated: true }, { id: "openai", authenticated: false }, { id: "ollama" }] });
    expect(configGet("full", s, providers)).toMatchObject({ config: { model: { provider: "anthropic", default: "claude-a" }, delegation: { max_concurrent_children: 3 }, approvals: { mode: "manual" } } });
    expect(() => configGet("details_mode.tools", s, providers)).toThrow(/non portée/);
    expect(configSet("model", "openai:gpt-x", s, providers)).toEqual({ key: "model", value: "openai:gpt-x", enabled: true });
    expect(s.state).toMatchObject({ activeProvider: "openai", activeModel: "gpt-x" });
    expect(() => configSet("yolo", true, s, providers)).toThrow(/non portée/);
  });

  it("PUT /api/config : model seulement, tout ou rien", () => {
    const s = fakeSettings();
    applyConfigPatch({ model: { provider: "ollama", default: "llama" } }, s, providers);
    expect(s.state).toMatchObject({ activeProvider: "ollama", activeModel: "llama" });
    const before = { ...s.state };
    for (const bad of [{ model: { provider: "inconnu", default: "x" } }, { model: { provider: "ollama", default: "y" }, stt: { provider: "local" } }, { delegation: { max_concurrent_children: 9 } }, { model: {} }, [], null, { model: "x" }]) {
      expect(() => applyConfigPatch(bad, s, providers), JSON.stringify(bad)).toThrow(ConfigError);
    }
    expect(s.state).toEqual(before); // rien n'a été appliqué, même la partie valide d'un lot refusé
  });
});

describe("groupes d'outils", () => {
  const tools = ["memory_save", "memory_search", "user_profile", "system_info", "system_files", "read_file", "write_file", "run_shell", "web_fetch", "delegate_task", "cronjob", "load_skill", "code_navigate", "bidule"].map((name) => ({ name }));

  it("regroupés par famille, dans l'ordre, un groupe vide n'apparaît pas ; le reste va dans « other »", () => {
    const rows = toolsets(tools, []);
    expect(rows.map((r) => r.name)).toEqual(["memory", "system", "files", "terminal", "web", "agents", "automation", "skills", "code", "other"]);
    expect(rows.find((r) => r.name === "memory")).toMatchObject({ tools: ["memory_save", "memory_search", "user_profile"], enabled: true, configured: true, platform: "jarod" });
    expect(rows.find((r) => r.name === "other")!.tools).toEqual(["bidule"]);
    expect(toolsets([{ name: "read_file" }], []).map((r) => r.name)).toEqual(["files"]);
  });

  it("un groupe est coupé dès qu'un de ses outils l'est", () => {
    const rows = toolsets(tools, ["system_files"]);
    expect(rows.find((r) => r.name === "system")!.enabled).toBe(false);
    expect(rows.find((r) => r.name === "memory")!.enabled).toBe(true);
  });

  it("couper puis rétablir un groupe ne touche pas aux autres entrées de disabledTools", () => {
    const off = setToolsetEnabled("system", false, tools, ["outil_mcp_inconnu", "write_file"]);
    expect(off).toEqual(["outil_mcp_inconnu", "write_file", "system_files", "system_info"]);
    expect(setToolsetEnabled("system", true, tools, off)).toEqual(["outil_mcp_inconnu", "write_file"]);
    expect(setToolsetEnabled("system", false, tools, off)).toEqual(off); // idempotent
    expect(() => setToolsetEnabled("inconnu", false, tools, [])).toThrow(/inconnu/);
  });
});

describe("terrain d'exécution et commandes", () => {
  it("seul « local » existe", () => {
    expect(terminalBackends()).toMatchObject({ active: "local", backends: [{ name: "local", status: "ready" }] });
    expect(() => checkTerminalBackend({ backend: "local" })).not.toThrow();
    for (const bad of [{ backend: "docker" }, {}, null]) expect(() => checkTerminalBackend(bad)).toThrow(/Seul « local »/);
  });

  it("slashResult : le texte, un envoi au modèle, un texte remis dans la saisie ; une commande inconnue le dit", () => {
    expect(slashResult({ text: "ok" }, "/x")).toEqual({ output: "ok" });
    expect(slashResult({ text: "", action: "send", payload: "dis bonjour" }, "/x")).toEqual({ output: "", type: "send", message: "dis bonjour" });
    expect(slashResult({ action: "undo", payload: "texte annulé" }, "/undo")).toEqual({ output: "", type: "prefill", message: "texte annulé" });
    expect(slashResult({ text: "x", action: "refresh" }, "/model")).toEqual({ output: "x" });
    expect(slashResult(null, "/zzz")).toEqual({ output: "Commande inconnue : /zzz" });
  });

  it("commandCatalog : une paire (/nom, description) par commande", () => {
    const cat = commandCatalog({ list: () => [{ name: "model", description: "Change de modèle", usage: "/model x" }, { name: "help", description: "Aide" }], execute: async () => null });
    expect(cat.pairs).toEqual([["/model", "Change de modèle"], ["/help", "Aide"]]);
    expect(cat.commands).toEqual({ model: { argument_mode: "text" }, help: { argument_mode: null } });
  });
});

const KEY = ["sk", "CANARI-CONFIG-0123456789abcdef01"].join("-");
const dirs: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig(answer: (call: { tool: string }) => "once" | "deny" = () => "deny", opts: { blank?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jarod-gw-cfg-"));
  dirs.push(root);
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core } = await openCore({ env: { JAROD_HOME: root, JAROD_CUSTOM_API_KEY: KEY } });
  // `blank` : un profil qui n'a encore rien choisi (ni fournisseur ni modèle écrits), avec seulement le fournisseur « custom » configuré.
  core.settings.patch({ ...(opts.blank ? {} : { activeProvider: "custom", activeModel: "modele-test" }), providerOverrides: { custom: { baseUrl: "http://127.0.0.1:9/v1", models: ["modele-test", "autre"] } }, autoTitle: false });
  const gw = createGateway({ core, version: "test" });
  const port = await gw.listen(0);
  closers.push(async () => {
    await gw.close();
    await core.dispose();
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${gw.token}`);
  closers.push(() => ws.close());
  const waiting = new Map<number, (f: any) => void>();
  const requests: { method: string; params: any }[] = [];
  let id = 0;
  ws.addEventListener("message", (m) => {
    const f = JSON.parse(String(m.data));
    if (f.id !== undefined && typeof f.method !== "string") waiting.get(f.id)?.(f);
    // Une demande d'accord du serveur (carte de Herald) : on répond comme le ferait l'utilisateur.
    else if (f.id !== undefined && f.method === "approval") {
      requests.push({ method: f.method, params: f.params });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: f.id, result: { choice: answer({ tool: f.params.tool_name }) } }));
    }
  });
  await new Promise<void>((ok, bad) => {
    ws.addEventListener("open", () => ok());
    ws.addEventListener("error", () => bad(new Error("connexion refusée")));
  });
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: any; error?: any }>((ok) => {
      const n = ++id;
      waiting.set(n, ok);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    });
  const http = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "x-hermes-session-token": gw.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { core, gw, rpc, http, requests };
}

describe("devant le vrai noyau", { timeout: 60_000 }, () => {
  it("model.options montre le fournisseur configuré (clé de l'environnement), ses modèles et le modèle actif", async () => {
    const { rpc } = await rig();
    const r = (await rpc("model.options", { include_unconfigured: false })).result;
    expect(r).toMatchObject({ provider: "custom", model: "modele-test" });
    const custom = r.providers.find((p: any) => p.slug === "custom");
    expect(custom).toMatchObject({ is_current: true, authenticated: true, models: ["modele-test", "autre"] });
    expect(r.providers.every((p: any) => p.authenticated)).toBe(true);
    expect((await rpc("model.options", { include_unconfigured: true })).result.providers.length).toBeGreaterThan(r.providers.length);
  });

  it("profil vierge : aucun modèle annoncé, le premier message est refusé avec le chemin à suivre, un choix par config.set le débloque", async () => {
    const { core, rpc } = await rig(undefined, { blank: true });
    expect(core.settings.isSet("activeProvider")).toBe(false);
    const created = (await rpc("session.create", {})).result;
    expect(created.info.model ?? "").toBe("");
    expect(created.info.provider ?? "").toBe("");
    expect((await rpc("model.options", {})).result).toMatchObject({ provider: "", model: "", needs_choice: true });
    const refused = await rpc("prompt.submit", { session_id: created.session_id, text: "bonjour" });
    expect(refused.error).toMatchObject({ code: -32000, message: expect.stringContaining("No model chosen yet") });
    expect(refused.error.message).toContain("Preferred model");
    // une commande `/` passe : c'est ainsi qu'on choisit
    expect((await rpc("slash.exec", { session_id: created.session_id, command: "/model custom:autre" })).error).toBeUndefined();
    expect(core.settings.isSet("activeProvider")).toBe(true);
    expect((await rpc("model.options", {})).result).toMatchObject({ provider: "custom", model: "autre" });
    expect((await rpc("model.options", {})).result).not.toHaveProperty("needs_choice");
  });

  it("/model fournisseur:modèle (la forme que Herald envoie) change AUSSI le fournisseur : le choix de Herald est utilisable, pas un nom de modèle collé sur l'ancien fournisseur", async () => {
    const { core, rpc } = await rig();
    const sid = (await rpc("session.create", {})).result.session_id as string;
    expect((await rpc("slash.exec", { session_id: sid, command: "/model ollama:qwen3.5:0.8b" })).result.output).toMatch(/ollama \/ qwen3\.5:0\.8b/);
    expect([core.settings.get("activeProvider"), core.settings.get("activeModel")]).toEqual(["ollama", "qwen3.5:0.8b"]);
    expect(core.sessions.get(sid)?.context).toMatchObject({ provider: "ollama", model: "qwen3.5:0.8b" });
    await rpc("slash.exec", { session_id: sid, command: "/model custom:autre" });
    expect([core.settings.get("activeProvider"), core.settings.get("activeModel")]).toEqual(["custom", "autre"]);
    expect((await rpc("model.options", {})).result).toMatchObject({ provider: "custom", model: "autre" });
    await rpc("slash.exec", { session_id: sid, command: "/model llama3:8b" }); // « llama3 » n'est pas un fournisseur : c'est un nom de modèle, sur le fournisseur courant
    expect([core.settings.get("activeProvider"), core.settings.get("activeModel")]).toEqual(["custom", "llama3:8b"]);
  });

  it("/model par slash.exec change le modèle du profil ET de la conversation ; un texte inconnu ou une session inconnue sont refusés", async () => {
    const { core, rpc } = await rig();
    const sid = (await rpc("session.create", {})).result.session_id as string;
    const done = await rpc("slash.exec", { session_id: sid, command: "/model custom/autre" });
    expect(done.result.output).toMatch(/custom \/ autre/);
    expect(core.settings.get("activeModel")).toBe("autre");
    expect(core.sessions.get(sid)?.context).toMatchObject({ model: "autre" });
    expect((await rpc("model.options", {})).result).toMatchObject({ model: "autre" });
    expect((await rpc("slash.exec", { session_id: sid, command: "model x" })).error.code).toBe(-32602);
    expect((await rpc("slash.exec", { session_id: "inconnue", command: "/help" })).error.message).toMatch(/unknown session/);
    expect((await rpc("slash.exec", { session_id: sid, command: "/zzzz" })).result.output).toMatch(/(inconnue|Commande)/i);
  });

  it("slash.exec : une commande courante ne demande rien ; une commande qui change la posture de sécurité passe par l'accord de Herald (refusée : rien ne change)", async () => {
    const { core, rpc, requests } = await rig(() => "deny");
    const sid = (await rpc("session.create", {})).result.session_id as string;
    await rpc("slash.exec", { session_id: sid, command: "/model custom/autre" });
    await rpc("slash.exec", { session_id: sid, command: "/help" });
    expect(requests).toEqual([]);

    const before = core.settings.get("workspace");
    const denied = await rpc("slash.exec", { session_id: sid, command: `/workspace ${tmpdir()}` });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.params).toMatchObject({ tool_name: "command/workspace", choices: ["once", "deny"], allow_permanent: false });
    expect(denied.result.output).toMatch(/demande un accord|impossible/i);
    expect(core.settings.get("workspace")).toBe(before);
    expect(core.auditLog()).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "command/workspace", decision: "refusé" })]));
  });

  it("slash.exec : accordée dans la carte, la commande gardée s'exécute et est auditée comme accordée", async () => {
    const { core, rpc, requests } = await rig(() => "once");
    const sid = (await rpc("session.create", {})).result.session_id as string;
    const dir = mkdtempSync(join(tmpdir(), "jarod-gw-ws2-"));
    dirs.push(dir);
    const r = await rpc("slash.exec", { session_id: sid, command: `/workspace ${dir}` });
    expect(requests.map((q) => q.params.tool_name)).toEqual(["command/workspace"]);
    expect(r.error).toBeUndefined();
    expect(core.auditLog()).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "command/workspace", decision: "accordé", ok: true })]));
  });

  it("commands.catalog liste les vraies commandes de Jarod", async () => {
    const { rpc } = await rig();
    const cat = (await rpc("commands.catalog", {})).result;
    const names = cat.pairs.map((p: string[]) => p[0]);
    expect(names).toEqual(expect.arrayContaining(["/model", "/help", "/plan", "/workspace"]));
  });

  it("config.get / config.set : l'autonomie ne peut pas être levée d'ici, le modèle oui", async () => {
    const { core, rpc } = await rig();
    expect((await rpc("config.get", { key: "approvals.mode" })).result).toEqual({ value: "manual" });
    const refused = await rpc("config.set", { key: "approvals.mode", value: "off" });
    expect(refused.error).toMatchObject({ code: -32602, message: expect.stringMatching(/propre écran de réglages/) });
    expect(core.settings.get("autoApproveTools")).toBe(false);
    expect((await rpc("config.set", { key: "model", value: "custom:autre" })).result).toMatchObject({ key: "model", value: "custom:autre" });
    expect(core.settings.get("activeModel")).toBe("autre");
    expect((await rpc("config.get", { key: "mystere" })).error.code).toBe(-32602);
  });

  it("groupes d'outils : couper « memory » retire ses outils de l'offre au modèle, le rétablir les rend ; les autres réglages restent", async () => {
    const { core, http } = await rig();
    core.settings.patch({ disabledTools: ["un_autre_outil"] });
    const list = (await http("GET", "/api/tools/toolsets")).body as any[];
    const memory = list.find((t) => t.name === "memory");
    expect(memory).toMatchObject({ enabled: true, configured: true });
    expect(memory.tools).toEqual(expect.arrayContaining(["memory_save", "memory_search"]));
    expect(core.tools.specs(core.settings.get("disabledTools")).map((t: any) => t.name)).toContain("memory_save");

    expect((await http("PUT", "/api/tools/toolsets/memory", { enabled: false })).status).toBe(200);
    expect(core.settings.get("disabledTools")).toEqual(expect.arrayContaining(["un_autre_outil", "memory_save", "memory_search"]));
    expect(core.tools.specs(core.settings.get("disabledTools")).map((t: any) => t.name)).not.toContain("memory_save");
    expect(((await http("GET", "/api/tools/toolsets")).body as any[]).find((t) => t.name === "memory").enabled).toBe(false);

    expect((await http("PUT", "/api/tools/toolsets/memory", { enabled: true })).status).toBe(200);
    expect(core.settings.get("disabledTools")).toEqual(["un_autre_outil"]);
    expect((await http("PUT", "/api/tools/toolsets/memory", { enabled: "oui" })).status).toBe(400);
    expect((await http("PUT", "/api/tools/toolsets/inconnu", { enabled: false })).status).toBe(400);
  });

  it.runIf(process.platform === "win32")("le groupe « system » regroupe les outils système et peut être coupé d'un coup", async () => {
    const { core, http } = await rig();
    const system = ((await http("GET", "/api/tools/toolsets")).body as any[]).find((t) => t.name === "system");
    // 14 outils système + `system_diagnostics` (osquery, vague G lot B) : coupé avec le groupe, comme les autres.
    expect(system.tools.length).toBe(15);
    await http("PUT", "/api/tools/toolsets/system", { enabled: false });
    const offered = core.tools.specs(core.settings.get("disabledTools")).map((t: any) => t.name);
    expect(offered.some((n: string) => n.startsWith("system_"))).toBe(false);
    expect(offered).toContain("read_file");
  });

  it("GET /api/providers/oauth : aucun fournisseur OAuth (les fournisseurs de Jarod sont à clé d'API ou locaux)", async () => {
    const { http } = await rig();
    expect((await http("GET", "/api/providers/oauth")).body).toEqual({ providers: [] });
  });

  it("GET et PUT /api/config, terrain d'exécution", async () => {
    const { core, http } = await rig();
    expect((await http("GET", "/api/config")).body).toMatchObject({ model: { provider: "custom", default: "modele-test" }, delegation: { max_concurrent_children: 3 }, approvals: { mode: "manual" } });
    expect((await http("PUT", "/api/config", { config: { model: { provider: "custom", default: "autre" } } })).body.model.default).toBe("autre");
    const refused = await http("PUT", "/api/config", { config: { model: { provider: "custom", default: "x" }, stt: { provider: "local" } } });
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toMatch(/stt/);
    expect(core.settings.get("activeModel")).toBe("autre"); // rien d'appliqué par le lot refusé
    expect((await http("GET", "/api/tools/terminal/backends")).body).toMatchObject({ active: "local" });
    expect((await http("PUT", "/api/tools/terminal/backend", { backend: "local" })).status).toBe(200);
    expect((await http("PUT", "/api/tools/terminal/backend", { backend: "docker" })).status).toBe(400);
  });

  it("GET /api/config/raw : aucun secret dans la réponse (clé du coffre, adresse, réglages), suit le choix du modèle ; l'écriture est refusée par son nom", async () => {
    const { core, http } = await rig();
    const first = await http("GET", "/api/config/raw");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ yaml: 'model:\n  provider: "custom"\n  default: "modele-test"\n' });
    core.settings.patch({ activeModel: SECRET_SHAPE });
    const text = JSON.stringify((await http("GET", "/api/config/raw")).body);
    for (const leak of [KEY, SECRET_SHAPE, "CANARI", "127.0.0.1:9", "providerOverrides", "baseUrl"]) expect(text).not.toContain(leak);
    expect(redactText(text)).toBe(text);
    await http("PUT", "/api/config", { config: { model: { provider: "custom", default: "autre" } } });
    expect((await http("GET", "/api/config/raw")).body.yaml).toContain('default: "autre"');
    const put = await http("PUT", "/api/config/raw", { yaml_text: "model:\n  provider: pirate\n" });
    expect(put.status).toBe(405);
    expect(put.body.detail).toMatch(/config\.yaml/);
    expect(core.settings.get("activeProvider")).toBe("custom");
  });
});
