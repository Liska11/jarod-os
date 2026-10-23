// Outils système, phase 2 (actions réversibles) : analyseurs et listes pures, outils avec PowerShell et lanceur simulés (rien n'est ouvert,
// rien n'est changé), puis, sous Windows, des aller-retours RÉELS qui rétablissent l'état initial. Barres : jarod-herald-reuse.md § 6, phase 2.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolDef } from "../src/registry.js";
import { checkUrl, INTERPRETERS, isExecutablePath, type Launcher, parseAppearance, parseAudio, programStem, resolvePane, systemActTools } from "../src/system/act.js";
import type { PsRunner } from "../src/system/ps.js";
import * as A from "../src/system/scripts-act.js";
import * as S from "../src/system/scripts.js";

const win = process.platform === "win32";
const ctx = { sessionId: "s", workspace: null } as ToolContext;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-act-"));
  dirs.push(d);
  return d;
};

describe("fonctions pures", () => {
  it("volets des Paramètres : nom exact, partiel, avec « & » ; inconnu = erreur qui liste les noms", () => {
    expect(resolvePane("sound")).toBe("sound");
    expect(resolvePane("Privacy & Security")).toBe("privacy");
    expect(resolvePane("wi-fi")).toBe("network-wifi");
    expect(resolvePane("default")).toBe("defaultapps");
    expect(() => resolvePane("???")).toThrow(/Volet inconnu/);
    expect(() => resolvePane("zzz")).toThrow(/wifi/);
  });

  it("un programme ou un script n'est jamais « ouvert » ; le nom de programme se réduit à sa racine", () => {
    for (const f of ["a.exe", "B.BAT", "c.ps1", "d.lnk", "e.MSI", "f.hta", "g.reg", "h.js", "i.cmd"]) expect(isExecutablePath(f), f).toBe(true);
    for (const f of ["a.pdf", "b.txt", "c.png", "dossier", "d.docx", "e.exe.txt"]) expect(isExecutablePath(f), f).toBe(false);
    expect(programStem("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE")).toBe("powershell");
    expect(programStem("C:\\x\\cmd.exe")).toBe("cmd");
    for (const p of ["cmd", "powershell", "pwsh", "wscript", "mshta", "rundll32", "wt", "python", "node", "wsl", "bash"]) expect(INTERPRETERS.has(p), p).toBe(true);
  });

  it("adresses : seuls http, https, mailto, sans espace ni guillemet", () => {
    expect(checkUrl(" https://exemple.fr/a?b=1&c=2 ")).toBe("https://exemple.fr/a?b=1&c=2");
    expect(checkUrl("mailto:moi@exemple.fr")).toBe("mailto:moi@exemple.fr");
    for (const bad of ["", "file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-settings:sound", "shell:AppsFolder\\x", "http://a b", 'https://a"b', "ftp://x", "pasuneadresse", "\\\\serveur\\partage\\x.exe"]) {
      expect(() => checkUrl(bad), bad).toThrow();
    }
  });

  it("audio : « niveau|coupé » pour la lecture et la capture ; apparence : mode sombre = apps_light à 0", () => {
    expect(parseAudio({ output: "40|0", input: "58|1" })).toEqual({ output_volume: 40, input_volume: 58, muted: false });
    expect(parseAudio({ output: "0|1", input: "" })).toEqual({ output_volume: 0, input_volume: null, muted: true });
    expect(parseAudio({ output: "", input: "" })).toEqual({ output_volume: null, input_volume: null, muted: null });
    expect(parseAppearance({ apps_light: 0, screens: { name: "\\\\.\\DISPLAY1", width: 3840, height: 2160, primary: true } })).toEqual({ dark_mode: true, displays: [{ name: "\\\\.\\DISPLAY1", resolution: "3840x2160", main: true }] });
    expect(parseAppearance({ apps_light: 1, screens: [] }).dark_mode).toBe(false);
    expect(parseAppearance({}).dark_mode).toBe(false);
  });
});

/** PowerShell simulé : réponses par script, appels enregistrés. */
function fakePs(replies: Partial<Record<string, unknown | ((args: Record<string, unknown> | undefined) => unknown)>>) {
  const calls: { script: string; args: Record<string, unknown> | undefined }[] = [];
  const ps: PsRunner = {
    json: async (script, args) => {
      calls.push({ script, args });
      const r = replies[script];
      if (typeof r === "function") return (r as (a: Record<string, unknown> | undefined) => unknown)(args);
      return r ?? null;
    },
  };
  return { ps, calls };
}
function recorder() {
  const launched: { file: string; args: readonly string[]; verbatim: boolean }[] = [];
  const launch: Launcher = async (file, args, opts) => void launched.push({ file, args, verbatim: opts?.verbatim === true });
  return { launched, launch };
}
const tool = (tools: ToolDef[], name: string) => tools.find((t) => t.name === name)!;
const APPS = [
  { name: "Paint", id: "Microsoft.Paint_8wekyb3d8bbwe!App" },
  { name: "Visual Studio Code", id: "Microsoft.VisualStudioCode" },
  { name: "Notepad++", id: "{6D80}\\Notepad++\\notepad++.exe" },
];

describe("politique", () => {
  it("hors Windows rien n'existe ; sous Windows : une lecture auditée, trois actions qui demandent un accord à chaque appel", () => {
    expect(systemActTools({ platform: "linux" })).toEqual([]);
    const tools = systemActTools({ platform: "win32", ps: fakePs({}).ps });
    expect(tools.map((t) => [t.name, Boolean(t.dangerous), Boolean(t.audited)])).toEqual([
      ["system_state", false, true],
      ["system_control", true, true],
      ["system_open", true, true],
      ["system_quit_app", true, true],
    ]);
  });

  it("lock_screen n'est pas exposé à l'agent", () => {
    const control = tool(systemActTools({ platform: "win32", ps: fakePs({}).ps }), "system_control");
    expect(JSON.stringify(control.parameters)).not.toMatch(/lock/i);
    expect(control.description).toMatch(/verrouillage.*pas disponible/i);
  });
});

describe("system_state et system_control (PowerShell simulé)", () => {
  it("system_state lit le volume et l'apparence sans rien écrire", async () => {
    const { ps, calls } = fakePs({ [A.AUDIO]: { output: "40|0", input: "58|0" }, [A.APPEARANCE]: { apps_light: 0, screens: [] } });
    const out = JSON.parse(await tool(systemActTools({ platform: "win32", ps }), "system_state").run({}, ctx));
    expect(out).toEqual({ audio: { output_volume: 40, input_volume: 58, muted: false }, appearance: { dark_mode: true, displays: [] } });
    expect(calls.map((c) => c.args)).toEqual([undefined, undefined]); // aucun argument d'écriture
  });

  it("set_volume : borné à 0-100, percent et/ou muted, l'état relu est rendu ; rien à régler = erreur", async () => {
    const { ps, calls } = fakePs({ [A.AUDIO]: { output: "100|0", input: "" } });
    const t = tool(systemActTools({ platform: "win32", ps }), "system_control");
    expect(JSON.parse(await t.run({ action: "set_volume", percent: 250 }, ctx))).toEqual({ audio: { output_volume: 100, input_volume: null, muted: false } });
    expect(calls.at(-1)!.args).toEqual({ percent: 100 });
    await t.run({ action: "set_volume", percent: -5, muted: true }, ctx);
    expect(calls.at(-1)!.args).toEqual({ percent: 0, muted: true });
    await t.run({ action: "set_volume", muted: false }, ctx);
    expect(calls.at(-1)!.args).toEqual({ muted: false });
    await expect(t.run({ action: "set_volume" }, ctx)).rejects.toThrow(/percent et\/ou muted/);
    await expect(t.run({ action: "set_volume", percent: "fort" }, ctx)).rejects.toThrow(/percent doit être un nombre/);
    await expect(t.run({ action: "set_volume", muted: "oui" }, ctx)).rejects.toThrow(/muted doit être vrai ou faux/);
    expect(calls.filter((c) => c.script === A.AUDIO)).toHaveLength(3);
  });

  it("set_dark_mode : exige un booléen, écrit puis relit l'apparence", async () => {
    const { ps, calls } = fakePs({ [A.APPEARANCE]: { apps_light: 0, screens: [] } });
    const t = tool(systemActTools({ platform: "win32", ps }), "system_control");
    expect(JSON.parse(await t.run({ action: "set_dark_mode", enabled: true }, ctx))).toMatchObject({ appearance: { dark_mode: true } });
    expect(calls.map((c) => c.script)).toEqual([A.SET_DARK_MODE, A.APPEARANCE]);
    expect(calls[0]!.args).toEqual({ enabled: true });
    await expect(t.run({ action: "set_dark_mode" }, ctx)).rejects.toThrow(/enabled/);
    await expect(t.run({ action: "set_dark_mode", enabled: "true" }, ctx)).rejects.toThrow(/enabled/);
  });

  it("notify : le texte voyage en JSON, jamais dans le script, même avec guillemets, $() et XML ; longueurs plafonnées", async () => {
    const { ps, calls } = fakePs({});
    const t = tool(systemActTools({ platform: "win32", ps }), "system_control");
    const title = `Titre ' " $(calc) ; </text><text>x ${"é".repeat(300)}`;
    await t.run({ action: "notify", title, body: "b".repeat(1000) }, ctx);
    expect(calls[0]!.script).toBe(A.TOAST);
    expect(calls[0]!.script).not.toContain("calc");
    expect((calls[0]!.args!.title as string).length).toBe(120);
    expect((calls[0]!.args!.body as string).length).toBe(400);
    expect(A.TOAST).toContain("SecurityElement]::Escape"); // l'échappement XML est dans le script
    await expect(t.run({ action: "notify" }, ctx)).rejects.toThrow(/title est requis/);
    await expect(t.run({ action: "lock_screen" }, ctx)).rejects.toThrow(/action doit être l'un de/);
  });

  it("sleep_display lance le script d'extinction et rien d'autre", async () => {
    const { ps, calls } = fakePs({});
    await tool(systemActTools({ platform: "win32", ps }), "system_control").run({ action: "sleep_display" }, ctx);
    expect(calls.map((c) => c.script)).toEqual([A.SLEEP_DISPLAY]);
  });
});

describe("system_open (PowerShell et lanceur simulés)", () => {
  const rig = (extra: { env?: NodeJS.ProcessEnv; home?: string; appPath?: string } = {}) => {
    const { ps, calls } = fakePs({ [S.INSTALLED_APPS]: APPS, [A.APP_PATH]: { path: extra.appPath ?? "" } });
    const r = recorder();
    const tools = systemActTools({ platform: "win32", ps, launch: r.launch, ...(extra.env ? { env: extra.env } : {}), ...(extra.home ? { home: extra.home } : {}) });
    return { open: tool(tools, "system_open"), calls, ...r };
  };

  it("app : une application du menu Démarrer part par l'Explorateur ; un nom nu par PATH ; inconnu = erreur", async () => {
    const bin = temp();
    writeFileSync(join(bin, "monoutil.exe"), "");
    const { open, launched } = rig({ env: { PATH: bin, SystemRoot: "Z:\\x" } });
    expect(JSON.parse(await open.run({ target: "app", app: "paint" }, ctx))).toEqual({ opened: "Paint" });
    expect(launched[0]).toEqual({ file: "explorer.exe", args: ["shell:AppsFolder\\Microsoft.Paint_8wekyb3d8bbwe!App"], verbatim: false });
    await open.run({ target: "app", app: "monoutil" }, ctx);
    expect(launched[1]).toEqual({ file: join(bin, "monoutil.exe"), args: [], verbatim: false });
    await expect(open.run({ target: "app", app: "n-existe-pas" }, ctx)).rejects.toThrow(/introuvable/);
    await expect(open.run({ target: "app" }, ctx)).rejects.toThrow(/app est requis/);
    expect(launched).toHaveLength(2);
  });

  it("app : un chemin ou un type de script n'est pas un nom d'application", async () => {
    const { open, launched } = rig();
    for (const app of ["C:\\Windows\\System32\\cmd.exe", "..\\x", "a/b", 'x"y', "a|b"]) await expect(open.run({ target: "app", app }, ctx), app).rejects.toThrow(/introuvable/);
    expect(launched).toEqual([]);
  });

  it("url : explorer pour le navigateur par défaut, l'application donnée sinon ; jamais file:, jamais un interpréteur", async () => {
    const bin = temp();
    writeFileSync(join(bin, "powershell.exe"), "");
    writeFileSync(join(bin, "navigateur.exe"), "");
    const { open, launched } = rig({ env: { PATH: bin, SystemRoot: "Z:\\x" } });
    await open.run({ target: "url", url: "https://exemple.fr/?a=1&b=2" }, ctx);
    expect(launched[0]).toEqual({ file: "explorer.exe", args: ["https://exemple.fr/?a=1&b=2"], verbatim: false });
    await open.run({ target: "url", url: "https://exemple.fr", app: "navigateur" }, ctx);
    expect(launched[1]).toEqual({ file: join(bin, "navigateur.exe"), args: ["https://exemple.fr"], verbatim: false });
    await expect(open.run({ target: "url", url: "file:///C:/x.exe" }, ctx)).rejects.toThrow(/http/);
    await expect(open.run({ target: "url", url: "https://exemple.fr", app: "powershell" }, ctx)).rejects.toThrow(/interpréteur/);
    expect(launched).toHaveLength(2);
  });

  // Casse ignorée (« .SSH ») et chemins « C:\… » : règles de Windows, seule plateforme de la famille system_* (tools.ts).
  it.runIf(win)("path : explorer pour l'application par défaut ; un programme ou un script, un chemin relatif, inexistant ou protégé sont refusés AVANT de lancer", async () => {
    const home = temp();
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id"), "x");
    writeFileSync(join(home, "notes.txt"), "x");
    writeFileSync(join(home, "outil.exe"), "x");
    writeFileSync(join(home, "script.ps1"), "x");
    const { open, launched } = rig({ home, env: { SystemRoot: join(home, "Windows"), PATH: "" } });
    await open.run({ target: "path", path: join(home, "notes.txt") }, ctx);
    expect(launched[0]).toEqual({ file: "explorer.exe", args: [join(home, "notes.txt")], verbatim: false });
    await open.run({ target: "path", path: "~/notes.txt" }, ctx);
    expect(launched[1]!.args).toEqual([join(home, "notes.txt")]);
    await expect(open.run({ target: "path", path: join(home, "outil.exe") }, ctx)).rejects.toThrow(/l'ouvrir l'exécuterait/);
    await expect(open.run({ target: "path", path: join(home, "script.ps1") }, ctx)).rejects.toThrow(/exécuterait/);
    await expect(open.run({ target: "path", path: "notes.txt" }, ctx)).rejects.toThrow(/non absolu/);
    await expect(open.run({ target: "path", path: join(home, "absent.txt") }, ctx)).rejects.toThrow(/n'existe pas/);
    await expect(open.run({ target: "path", path: join(home, ".ssh", "id") }, ctx)).rejects.toThrow(/emplacement protégé/);
    await expect(open.run({ target: "reveal", path: join(home, ".SSH") }, ctx)).rejects.toThrow(/emplacement protégé/);
    await expect(open.run({ target: "path" }, ctx)).rejects.toThrow(/path est requis/);
    expect(launched).toHaveLength(2);
  });

  it("reveal : une seule ligne de commande verbatim pour l'Explorateur", async () => {
    const home = temp();
    writeFileSync(join(home, "mon fichier.txt"), "x");
    const { open, launched } = rig({ home });
    await open.run({ target: "reveal", path: join(home, "mon fichier.txt") }, ctx);
    expect(launched[0]).toEqual({ file: "explorer.exe", args: [`/select,"${join(home, "mon fichier.txt")}"`], verbatim: true });
  });

  it("editor : auto prend le premier installé (VS Code), le programme vient de « App Paths » ; un éditeur absent est une erreur claire", async () => {
    const home = temp();
    const code = join(home, "Code.exe");
    writeFileSync(code, "");
    const dossier = join(home, "projet");
    mkdirSync(dossier);
    const { open, launched } = rig({ home, env: { PATH: "", SystemRoot: "Z:\\x" }, appPath: code });
    expect(JSON.parse(await open.run({ target: "editor", path: dossier }, ctx))).toEqual({ opened: dossier, app: "Visual Studio Code" });
    expect(launched[0]).toEqual({ file: code, args: [dossier], verbatim: false });
    await open.run({ target: "editor", path: dossier, editor: "vscode" }, ctx);
    expect(launched[1]!.file).toBe(code);
    const none = rig({ home, env: { PATH: "", SystemRoot: "Z:\\x" } });
    await expect(none.open.run({ target: "editor", path: dossier, editor: "cursor" }, ctx)).rejects.toThrow(/Impossible d'ouvrir/);
    expect(none.launched).toEqual([]);
  });

  it("settings : ms-settings par l'Explorateur, volet inconnu refusé", async () => {
    const { open, launched } = rig();
    expect(JSON.parse(await open.run({ target: "settings", pane: "sound" }, ctx))).toEqual({ pane: "sound", opened: "ms-settings:sound" });
    expect(launched[0]).toEqual({ file: "explorer.exe", args: ["ms-settings:sound"], verbatim: false });
    await open.run({ target: "settings" }, ctx);
    expect(launched[1]!.args).toEqual(["ms-settings:about"]);
    await expect(open.run({ target: "settings", pane: "zzz" }, ctx)).rejects.toThrow(/Volet inconnu/);
    await expect(open.run({ target: "format" }, ctx)).rejects.toThrow(/target doit être l'un de/);
  });
});

describe("system_quit_app (fermeture polie)", () => {
  const running = [
    { pid: 100, process: "paint", description: "Paint", path: "C:\\Apps\\mspaint.exe" },
    { pid: 101, process: "explorer", description: "Explorateur Windows", path: "C:\\Windows\\Explorer.EXE" },
    { pid: 102, process: "node", description: "Jarod", path: "C:\\Jarod\\jarod.exe" },
    { pid: 103, process: "vide", description: "Sans fenêtre", path: "C:\\Apps\\vide.exe" },
  ];
  const rig = (closeBehaviour: (pid: unknown) => unknown = () => ({})) => {
    const { ps, calls } = fakePs({
      [S.INSTALLED_APPS]: APPS,
      [S.RUNNING_APPS]: running,
      [A.CLOSE_WINDOW]: (a: Record<string, unknown> | undefined) => closeBehaviour(a?.pid),
    });
    return { quit: tool(systemActTools({ platform: "win32", ps, protectedPids: [102] }), "system_quit_app"), calls };
  };

  it("ferme poliment : CloseMainWindow du bon processus, jamais de kill", async () => {
    const { quit, calls } = rig();
    expect(JSON.parse(await quit.run({ name: "Paint" }, ctx))).toMatchObject({ app: "Paint", mode: "polite", requested: 1 });
    expect(calls.filter((c) => c.script === A.CLOSE_WINDOW).map((c) => c.args)).toEqual([{ pid: 100, name: "mspaint" }]);
    expect(calls.some((c) => c.script === A.FORCE_KILL)).toBe(false);
    expect(A.CLOSE_WINDOW).not.toMatch(/Kill|Stop-Process/);
  });

  it("refuse l'Explorateur, un processus système et Jarod lui-même, sans rien fermer", async () => {
    const { quit, calls } = rig();
    await expect(quit.run({ name: "Explorateur Windows" }, ctx)).rejects.toThrow(/ne le ferme pas/);
    await expect(quit.run({ name: "explorer" }, ctx)).rejects.toThrow(/ne le ferme pas/);
    await expect(quit.run({ name: "Jarod" }, ctx)).rejects.toThrow(/ne le ferme pas/);
    expect(calls.filter((c) => c.script === A.CLOSE_WINDOW)).toEqual([]);
  });

  it("une application absente ou sans fenêtre à fermer donne une erreur claire", async () => {
    const { quit } = rig((pid) => {
      if (pid === 103) throw new Error("NOWINDOW");
      return {};
    });
    await expect(quit.run({ name: "inconnue" }, ctx)).rejects.toThrow(/n'est pas ouverte/);
    await expect(quit.run({ name: "vide" }, ctx)).rejects.toThrow(/pas de fenêtre à fermer poliment/);
    await expect(quit.run({}, ctx)).rejects.toThrow(/name est requis/);
  });

  it("une erreur autre que « pas de fenêtre » remonte", async () => {
    const { quit } = rig(() => {
      throw new Error("Access is denied");
    });
    await expect(quit.run({ name: "Paint" }, ctx)).rejects.toThrow("Access is denied");
  });
});

describe.runIf(win)("sur cette machine (vrai PowerShell) : lectures et aller-retours qui rétablissent l'état", () => {
  const tools = systemActTools();
  const run = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(await tool(tools, name).run(args, ctx));

  it("system_state rend un volume, un mode sombre et au moins un écran", async () => {
    const s = await run("system_state");
    expect(s.audio.output_volume === null || (s.audio.output_volume >= 0 && s.audio.output_volume <= 100)).toBe(true);
    expect(typeof s.appearance.dark_mode).toBe("boolean");
    expect(s.appearance.displays.length).toBeGreaterThan(0);
  }, 60_000);

  it("volume : lire, écrire la MÊME valeur, relire — identique ; la coupure aussi", async () => {
    const before = (await run("system_state")).audio;
    if (before.output_volume === null) return; // aucun périphérique audio : rien à vérifier
    const after = (await run("system_control", { action: "set_volume", percent: before.output_volume, muted: before.muted })).audio;
    expect(after.output_volume).toBe(before.output_volume);
    expect(after.muted).toBe(before.muted);
    expect((await run("system_state")).audio).toEqual(before);
  }, 60_000);

  it("mode sombre : écrire l'état actuel puis relire — identique", async () => {
    const before = (await run("system_state")).appearance.dark_mode;
    const after = (await run("system_control", { action: "set_dark_mode", enabled: before })).appearance.dark_mode;
    expect(after).toBe(before);
    expect((await run("system_state")).appearance.dark_mode).toBe(before);
  }, 60_000);

  it("le vrai lanceur démarre un programme détaché, et rejette un programme absent", async () => {
    const { realLauncher } = await import("../src/system/act.js");
    await expect(realLauncher(process.execPath, ["-e", "0"])).resolves.toBeUndefined();
    await expect(realLauncher(join(tmpdir(), "n-existe-pas.exe"), [])).rejects.toThrow();
  });
});
