// Cockpit, lot 2 : les outils à effet disent leur CIBLE (pour les permissions par cible) et VÉRIFIENT l'effet obtenu. Fichiers : sur un vrai
// dossier temporaire. Applications : PowerShell simulé (rien n'est lancé ni fermé ici).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinTools } from "../src/builtin.js";
import type { ToolContext, ToolDef } from "../src/registry.js";
import { type Launcher, systemActTools } from "../src/system/act.js";
import type { PsRunner } from "../src/system/ps.js";
import * as S from "../src/system/scripts.js";
import { makeCore } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const workspace = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-proof-"));
  dirs.push(d);
  return d;
};
const tool = (tools: ToolDef[], name: string) => tools.find((t) => t.name === name)!;

describe("fichiers : cible et preuve", async () => {
  const tools = builtinTools((await makeCore()).memory);

  it("write_file : cible = le chemin ; preuve = le fichier relu a exactement le contenu écrit", async () => {
    const ws = workspace();
    const ctx = { sessionId: "s", workspace: ws } as ToolContext;
    const w = tool(tools, "write_file");
    expect(w.targetOf!({ path: "notes/a.md" })).toBe("notes/a.md");
    const args = { path: "notes/a.md", content: "bonjour" };
    const out = await w.run(args, ctx);
    expect(await w.verify!(args, out, ctx)).toMatchObject({ status: "verified", evidence: expect.stringMatching(/7 octets/) });
    // Le fichier a changé depuis : la preuve le voit.
    writeFileSync(join(ws, "notes/a.md"), "autre chose");
    expect((await w.verify!(args, out, ctx)).status).toBe("failed");
  });

  it("edit_file : preuve = le nouveau texte est présent et l'ancien a disparu", async () => {
    const ws = workspace();
    const ctx = { sessionId: "s", workspace: ws } as ToolContext;
    writeFileSync(join(ws, "a.txt"), "un deux trois");
    const e = tool(tools, "edit_file");
    const args = { path: "a.txt", old_text: "deux", new_text: "2" };
    const out = await e.run(args, ctx);
    expect((await e.verify!(args, out, ctx)).status).toBe("verified");
    writeFileSync(join(ws, "a.txt"), "un deux trois");
    expect((await e.verify!(args, out, ctx)).status).toBe("failed");
  });

  it("run_shell, web_fetch, read_file disent leur cible", () => {
    expect(tool(tools, "run_shell").targetOf!({ command: "git status" })).toBe("git status");
    expect(tool(tools, "web_fetch").targetOf!({ url: "https://exemple.fr/a" })).toBe("https://exemple.fr/a");
    expect(tool(tools, "read_file").targetOf!({ path: "a.txt" })).toBe("a.txt");
  });
});

/** PowerShell simulé : la liste des applications ouvertes change au fil des appels. */
function fakePs(runningSequence: unknown[][]) {
  let i = 0;
  const ps: PsRunner = {
    json: async (script) => {
      if (script === S.INSTALLED_APPS) return [{ name: "Paint", id: "Microsoft.Paint_8wekyb3d8bbwe!App" }];
      if (script === S.RUNNING_APPS) return runningSequence[Math.min(i++, runningSequence.length - 1)];
      return {};
    },
  };
  return ps;
}
const launch: Launcher = async () => {};
const ctx = { sessionId: "s", workspace: null } as ToolContext;
const PAINT = { pid: 100, process: "mspaint", description: "Paint", path: "C:\\Apps\\mspaint.exe" };

describe("applications : cible et preuve (PowerShell simulé)", () => {
  it("system_open app : cible = le nom ; preuve = l'application apparaît parmi les applications ouvertes", async () => {
    const open = tool(systemActTools({ platform: "win32", ps: fakePs([[], [PAINT]]), launch, verifyDelaysMs: [0, 0, 0] }), "system_open");
    expect(open.targetOf!({ target: "app", app: "Paint" })).toBe("Paint");
    expect(open.targetOf!({ target: "url", url: "https://x.fr" })).toBe("https://x.fr");
    const args = { target: "app", app: "paint" };
    const out = await open.run(args, ctx);
    expect(await open.verify!(args, out, ctx)).toMatchObject({ status: "verified", evidence: expect.stringMatching(/Paint.*pid 100/) });
  });

  it("system_open app qui n'apparaît jamais : échec constaté", async () => {
    const open = tool(systemActTools({ platform: "win32", ps: fakePs([[]]), launch, verifyDelaysMs: [0, 0] }), "system_open");
    const args = { target: "app", app: "paint" };
    expect((await open.verify!(args, await open.run(args, ctx), ctx)).status).toBe("failed");
  });

  it("system_open url ou fichier : rien d'observable de façon fiable, la preuve le dit", async () => {
    const open = tool(systemActTools({ platform: "win32", ps: fakePs([[]]), launch, verifyDelaysMs: [0] }), "system_open");
    const args = { target: "url", url: "https://exemple.fr" };
    expect((await open.verify!(args, await open.run(args, ctx), ctx)).status).toBe("unverifiable");
  });

  it("system_quit_app : preuve = le processus a disparu ; encore là après une fermeture polie = non constaté (l'application peut demander d'enregistrer)", async () => {
    const gone = tool(systemActTools({ platform: "win32", ps: fakePs([[PAINT], [PAINT], []]), verifyDelaysMs: [0, 0, 0] }), "system_quit_app");
    const args = { name: "Paint" };
    expect(gone.targetOf!(args)).toBe("Paint");
    const out = await gone.run(args, ctx);
    expect((await gone.verify!(args, out, ctx)).status).toBe("verified");
    const stays = tool(systemActTools({ platform: "win32", ps: fakePs([[PAINT]]), verifyDelaysMs: [0, 0] }), "system_quit_app");
    expect((await stays.verify!(args, await stays.run(args, ctx), ctx)).status).toBe("unverifiable");
    const forced = { name: "Paint", force: true };
    expect((await stays.verify!(forced, await stays.run(forced, ctx), ctx)).status).toBe("failed");
  });
});
