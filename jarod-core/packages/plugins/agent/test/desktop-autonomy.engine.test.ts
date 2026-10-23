// D1 raccordé (2026-10-21) — boucle réelle, moteur FlaUI réel, fenêtre FABRIQUÉE seulement : la fenêtre est la cible de la règle, l'action son
// opération ; clavier brut et souris réservés (refusés sans règle, sans même demander) ; une règle autonome « keyboard.* » sur cette fenêtre fait
// taper sans accord, mais n'ouvre ni la souris ni une autre fenêtre ; un seul contrôleur : une autre conversation est refusée tant que le bail court.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatRequest, PermissionRule } from "@jarod/contracts";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { planGrant } from "@jarod/plugin-permissions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { tempDir, testKeys } from "./helpers.js";

const ROOT = resolve(__dirname, "../../../../..");
const EXE = join(ROOT, "engines", "flaui", "uia-flaui-worker.exe");
const FIXTURE = join(ROOT, "jarod-core", "packages", "plugins", "integrations", "test", "engines", "uia_target.ps1");
const TITLE = "JarodUiaTarget-boucle";
const has = process.platform === "win32" && existsSync(EXE);
if (!has) console.warn(`[moteurs] ${EXE} absent : le pilote de fenêtres dans la boucle réelle est ignoré`);

describe.skipIf(!has)("D1 — desktop_control dans la boucle réelle (FlaUI réel, fenêtre fabriquée)", () => {
  let target: ChildProcess;
  let core: Awaited<ReturnType<typeof bootApp>>["agent"];
  let next: { name: string; args: Record<string, unknown> } | null = null;
  let asked = 0;

  const call = async (name: string, args: Record<string, unknown>, session?: string) => {
    next = { name, args };
    const s = session ?? core.sessions.create().id;
    const before = asked;
    await core.runAndWait(s, "fais-le", {
      emit: () => {},
      approve: async () => {
        asked++;
        return false;
      },
    });
    const tool = core.messages.list(s).filter((m) => m.role === "tool").at(-1);
    return { content: String(tool?.content ?? ""), isError: tool?.isError === true, asked: asked - before, session: s };
  };
  const rules = () => [...core.settings.get("permissionsRules")] as PermissionRule[];

  beforeAll(async () => {
    process.env.JAROD_FLAUI_WORKER = EXE;
    target = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", FIXTURE, "-Title", TITLE], { stdio: "ignore" });
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir: tempDir(), keyStores: [testKeys] };
    plugins.scheduler = { autoStart: false };
    core = (await bootApp(plugins)).agent;
    core.settings.set("autoTitle", false);
    core.providers.client = () =>
      ({
        chat: async (req: ChatRequest) =>
          req.messages.at(-1)?.role === "tool" || !next
            ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
            : { text: "", thinking: "", toolCalls: [{ id: `t${Date.now()}`, ...next }], stopReason: "tool_use" },
        listModels: async () => [],
      }) as never;
  }, 60_000);

  afterAll(() => {
    target?.kill();
    delete process.env.JAROD_FLAUI_WORKER;
  });

  it("fenêtre = cible, action = opération ; clavier et souris réservés ; autonomie bornée ; un seul contrôleur", async () => {
    let win: { id: string; target: string } | undefined;
    for (let i = 0; i < 40 && !win; i++) {
      const r = await call("desktop_windows", {});
      expect(r.asked).toBe(0); // lecture auditée, sans accord
      win = (JSON.parse(r.content) as { id: string; title: string; target: string }[]).find((w) => w.target.endsWith(`:${TITLE}`));
      if (!win) await new Promise((r) => setTimeout(r, 500));
    }
    expect(win?.target).toBe(`powershell.exe:${TITLE}`);
    const w = win!.id;

    // Sans règle : une action sur un élément demande l'accord ; la souris et le clavier brut sont refusés sans rien demander.
    expect((await call("desktop_control", { action: "focus_window", window: w })).asked).toBe(1);
    const mouse = await call("desktop_control", { action: "mouse_click", window: w, x: 30, y: 30 });
    expect(mouse).toMatchObject({ asked: 0, isError: true });
    expect(mouse.content).toMatch(/Je sais faire « desktop_control » avec l'opération « mouse\.click », mais elle est réservée/);

    // L'utilisateur accorde le clavier SANS accord, sur cette fenêtre seulement, 15 minutes.
    core.settings.set("permissionsRules", planGrant(rules(), { tool: "desktop_control", decision: "allow", autonomous: true, target: win!.target, operation: "keyboard.*", durationMs: 900_000 }, Date.now()).rules);
    const main = core.sessions.create().id;
    const typed = await call("desktop_control", { action: "type_keys", window: w, text: "par la boucle" }, main);
    expect(typed).toMatchObject({ asked: 0, isError: false, content: "Texte tapé." });
    expect(core.auditLog(30).find((a) => a.tool === "desktop_control" && a.decision === "autorisé (règle)")).toMatchObject({ ok: true });
    // La règle n'ouvre pas la souris (autre opération) et ne dispense pas une action sur élément (ui.*).
    expect((await call("desktop_control", { action: "mouse_click", window: w, x: 30, y: 30 }, main)).content).toMatch(/réservée/);
    expect((await call("desktop_control", { action: "focus_window", window: w }, main)).asked).toBe(1);

    // Un seul contrôleur : tant que le bail de `main` court, une autre conversation est refusée — même sous la règle autonome.
    const other = await call("desktop_control", { action: "type_keys", window: w, text: "intrus" });
    expect(other).toMatchObject({ asked: 0, isError: true });
    expect(other.content).toMatch(/un autre contrôleur pilote déjà ce bureau.*conversation/s);
  }, 120_000);
});
