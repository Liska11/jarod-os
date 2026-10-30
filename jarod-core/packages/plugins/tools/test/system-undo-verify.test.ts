// Q5 et Q6 (analyse du 29/10) : la PREUVE des actions système qui n'en avaient pas (system_control, system_files, system_kill_process) et
// l'ANNULATION de la dernière action réversible (undo_last_action). PowerShell simulé ; les fichiers sont de vrais fichiers dans un dossier jetable.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolDef } from "../src/registry.js";
import { systemActTools } from "../src/system/act.js";
import { systemDestroyTools } from "../src/system/destroy.js";
import type { PsRunner } from "../src/system/ps.js";
import * as A from "../src/system/scripts-act.js";
import { UndoStack, undoTool } from "../src/system/undo.js";

const ctx = { sessionId: "s", workspace: null } as ToolContext;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-undo-"));
  dirs.push(d);
  return d;
};
const tool = (tools: ToolDef[], name: string) => tools.find((t) => t.name === name)!;

type Args = Record<string, unknown> | undefined;
function fakePs(replies: Partial<Record<string, unknown>>) {
  const calls: { script: string; args: Args }[] = [];
  const ps: PsRunner = {
    json: async (script, args) => {
      calls.push({ script, args });
      const r = replies[script];
      return typeof r === "function" ? (r as (a: Args) => unknown)(args) : (r ?? null);
    },
  };
  return { ps, calls };
}

/** Un mélangeur simulé : le volume et la sourdine changent vraiment quand on les écrit. */
function mixer(start: { volume: number; muted: boolean }) {
  const st = { ...start };
  return fakePs({
    [A.AUDIO]: (a: Args) => {
      if (a && typeof a.percent === "number") st.volume = a.percent;
      if (a && typeof a.muted === "boolean") st.muted = a.muted;
      return { output: `${st.volume}|${st.muted ? 1 : 0}`, input: "" };
    },
  });
}

/** Le décor de system_files : un « dossier personnel » jetable, sans emplacement protégé dedans. */
function home() {
  const h = temp();
  const env = { APPDATA: join(h, "AppData", "Roaming"), LOCALAPPDATA: join(h, "AppData", "Local"), SystemRoot: join(h, "Windows"), ProgramFiles: join(h, "PF"), PATH: "" };
  return { h, env };
}

describe("UndoStack et undo_last_action", () => {
  it("dernier entré, premier défait ; borné à 10 ; vide = refus sans rien demander", async () => {
    const stack = new UndoStack();
    const t = undoTool(stack);
    expect(t.dangerous).toBe(true);
    await expect(Promise.resolve().then(() => t.precheck!({}, ctx))).rejects.toThrow(/Rien à annuler/);
    const order: number[] = [];
    for (let i = 0; i < 12; i++) stack.push(`action ${i}`, async () => (order.push(i), "ok"));
    expect(stack.list()).toHaveLength(10);
    expect(await t.precheck!({}, ctx)).toBe("Annuler : action 11");
    expect(await t.run({}, ctx)).toBe("Annulé : action 11. ok");
    expect(order).toEqual([11]);
    expect(stack.peek()?.label).toBe("action 10");
  });

  it("une annulation qui échoue est retirée de la pile (la retenter rejouerait le même échec)", async () => {
    const stack = new UndoStack();
    stack.push("x", async () => {
      throw new Error("impossible");
    });
    await expect(stack.undoLast()).rejects.toThrow(/impossible/);
    expect(stack.peek()).toBeUndefined();
  });
});

describe("Q5/Q6 system_control (mélangeur simulé)", () => {
  it("set_volume : preuve relue ; annuler rétablit le volume d'avant", async () => {
    const { ps } = mixer({ volume: 40, muted: false });
    const undo = new UndoStack();
    const control = tool(systemActTools({ platform: "win32", ps, undo }), "system_control");
    const args = { action: "set_volume", percent: 70 };
    await control.precheck!(args, ctx);
    const out = await control.run(args, ctx);
    expect(await control.verify!(args, out, ctx)).toEqual({ status: "verified", evidence: "volume 70 %, son actif" });
    expect(undo.peek()?.label).toBe("régler le volume à 70 %");
    expect(await undo.undoLast()).toMatch(/Volume revenu à 40 %/);
  });

  it("set_volume : un volume relu différent de la demande est un ÉCHEC, pas « fait »", async () => {
    const { ps } = fakePs({ [A.AUDIO]: { output: "40|0", input: "" } }); // le réglage ne prend pas
    const control = tool(systemActTools({ platform: "win32", ps }), "system_control");
    const args = { action: "set_volume", percent: 70 };
    expect((await control.verify!(args, "{}", ctx)).status).toBe("failed");
  });

  it("notify : la preuve dit qu'elle ne peut rien constater", async () => {
    const control = tool(systemActTools({ platform: "win32", ps: fakePs({}).ps }), "system_control");
    expect((await control.verify!({ action: "notify", title: "t" }, "{}", ctx)).status).toBe("unverifiable");
  });

  it("set_dark_mode : rien à annuler quand l'état ne change pas", async () => {
    const { ps } = fakePs({ [A.APPEARANCE]: { apps_light: 0 }, [A.SET_DARK_MODE]: {} });
    const undo = new UndoStack();
    const control = tool(systemActTools({ platform: "win32", ps, undo }), "system_control");
    const args = { action: "set_dark_mode", enabled: true };
    await control.precheck!(args, ctx);
    await control.run(args, ctx);
    expect(undo.peek()).toBeUndefined();
  });
});

describe("Q5/Q6 system_files (vrai disque temporaire)", () => {
  it("move : preuve sur le disque ; annuler remet le fichier à sa place", async () => {
    const { h, env } = home();
    writeFileSync(join(h, "a.txt"), "x");
    mkdirSync(join(h, "rangement"));
    const undo = new UndoStack();
    const files = tool(systemDestroyTools({ platform: "win32", ps: fakePs({}).ps, home: h, env, undo }), "system_files");
    const args = { action: "move", path: join(h, "a.txt"), to: join(h, "rangement") };
    await files.precheck!(args, ctx);
    const out = await files.run(args, ctx);
    expect(existsSync(join(h, "rangement", "a.txt"))).toBe(true);
    expect((await files.verify!(args, out, ctx)).status).toBe("verified");
    await undo.undoLast();
    expect(existsSync(join(h, "a.txt"))).toBe(true);
    expect(existsSync(join(h, "rangement", "a.txt"))).toBe(false);
  });

  it("annuler un déplacement n'écrase jamais un fichier revenu entre-temps", async () => {
    const { h, env } = home();
    writeFileSync(join(h, "a.txt"), "x");
    const undo = new UndoStack();
    const files = tool(systemDestroyTools({ platform: "win32", ps: fakePs({}).ps, home: h, env, undo }), "system_files");
    const args = { action: "move", path: join(h, "a.txt"), to: join(h, "b.txt") };
    await files.precheck!(args, ctx);
    await files.run(args, ctx);
    writeFileSync(join(h, "a.txt"), "nouveau");
    await expect(undo.undoLast()).rejects.toThrow(/existe de nouveau/);
    expect(existsSync(join(h, "b.txt"))).toBe(true);
  });

  it("mkdir : annuler retire le dossier créé, mais pas un dossier qui existait déjà", async () => {
    const { h, env } = home();
    mkdirSync(join(h, "deja"));
    const undo = new UndoStack();
    const files = tool(systemDestroyTools({ platform: "win32", ps: fakePs({}).ps, home: h, env, undo }), "system_files");
    const args = { action: "mkdir", path: join(h, "neuf") };
    await files.precheck!(args, ctx);
    await files.run(args, ctx);
    const again = { action: "mkdir", path: join(h, "deja") };
    await Promise.resolve(files.precheck!(again, ctx)).catch(() => undefined);
    await files.run(again, ctx).catch(() => undefined);
    expect(undo.list()).toEqual([`créer le dossier ${join(h, "neuf")}`]);
    await undo.undoLast();
    expect(existsSync(join(h, "neuf"))).toBe(false);
    expect(existsSync(join(h, "deja"))).toBe(true);
  });

  it("trash : jamais annulable ici (la corbeille de Windows le rend)", async () => {
    const { h, env } = home();
    writeFileSync(join(h, "c.txt"), "x");
    const { ps } = fakePs({ [A.TRASH]: (a: Args) => ({ trashed: (a?.paths as string[]) ?? [], errors: [] }) });
    const undo = new UndoStack();
    const files = tool(systemDestroyTools({ platform: "win32", ps, home: h, env, undo }), "system_files");
    const args = { action: "trash", path: join(h, "c.txt") };
    await files.precheck!(args, ctx);
    await files.run(args, ctx);
    expect(undo.peek()).toBeUndefined();
  });
});

describe("Q5 system_kill_process", () => {
  it("un processus toujours là après les relectures : ÉCHEC avec la raison probable", async () => {
    const { ps } = fakePs({ [A.PROC_INFO]: { name: "notepad", path: "" } });
    const kill = tool(systemDestroyTools({ platform: "win32", ps, verifyDelaysMs: [0, 0] }), "system_kill_process");
    const proof = await kill.verify!({ pid: 600 }, JSON.stringify({ stopped: [{ pid: 600, name: "notepad" }], errors: [] }), ctx);
    expect(proof.status).toBe("failed");
    expect(proof.evidence).toMatch(/Enregistrer/);
  });

  it("un processus disparu (ou un pid repris par un autre programme) : constaté", async () => {
    const { ps } = fakePs({ [A.PROC_INFO]: { name: "autre", path: "" } });
    const kill = tool(systemDestroyTools({ platform: "win32", ps, verifyDelaysMs: [0] }), "system_kill_process");
    expect((await kill.verify!({ pid: 600 }, JSON.stringify({ stopped: [{ pid: 600, name: "notepad" }], errors: [] }), ctx)).status).toBe("verified");
  });
});
