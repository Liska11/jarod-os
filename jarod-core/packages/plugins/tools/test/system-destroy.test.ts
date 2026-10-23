// Outils système, phase 3 (modification et destruction) : planification, `system_files`, `system_kill_process`. PowerShell simulé pour la logique,
// puis, sous Windows, de VRAIS essais sur des fichiers et des processus créés par le test lui-même (jamais autre chose). Barres : jarod-herald-reuse.md § 6.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolDef } from "../src/registry.js";
import { systemDestroyTools } from "../src/system/destroy.js";
import { forbiddenReason, isInside, planFiles, requestedOperations } from "../src/system/files.js";
import { protectedReason, stopErrorMessage } from "../src/system/proc.js";
import type { PsRunner } from "../src/system/ps.js";
import * as A from "../src/system/scripts-act.js";
import * as S from "../src/system/scripts.js";

const win = process.platform === "win32";
const ctx = { sessionId: "s", workspace: null } as ToolContext;
const dirs: string[] = [];
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) {
    try {
      k.kill();
    } catch {
      // Déjà arrêté.
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-dst-"));
  dirs.push(d);
  return d;
};
const tool = (tools: ToolDef[], name: string) => tools.find((t) => t.name === name)!;
const write = (p: string, content = "x") => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};

type Args = Record<string, unknown> | undefined;
function fakePs(replies: Partial<Record<string, unknown>> = {}) {
  const calls: { script: string; args: Record<string, unknown> | undefined }[] = [];
  const ps: PsRunner = {
    json: async (script, args) => {
      calls.push({ script, args });
      const r = replies[script];
      return typeof r === "function" ? (r as (a: Record<string, unknown> | undefined) => unknown)(args) : (r ?? null);
    },
  };
  return { ps, calls };
}

/** Le décor : un « dossier personnel » jetable avec un .ssh, et des variables d'environnement qui pointent dedans. */
function home() {
  const h = temp();
  mkdirSync(join(h, ".ssh"));
  write(join(h, ".ssh", "id_rsa"), "secret");
  const env = { APPDATA: join(h, "AppData", "Roaming"), LOCALAPPDATA: join(h, "AppData", "Local"), SystemRoot: join(h, "Windows"), ProgramFiles: join(h, "PF"), PATH: "" };
  return { h, env, roots: [join(h, ".ssh"), join(h, "Windows"), join(h, "PF")] };
}

describe("arguments et chemins", () => {
  // Chemins « C:\… », casse ignorée, racines de disque : règles de Windows, seule plateforme de la famille system_* (tools.ts).
  it.runIf(win)("opérations mal formées : messages nets, rien de silencieux", () => {
    const h = "C:\\Users\\moi";
    expect(() => requestedOperations({ action: "mkdir" }, h)).toThrow(/path est requis/);
    expect(() => requestedOperations({ action: "mkdir", path: "relatif" }, h)).toThrow(/non absolu/);
    expect(() => requestedOperations({ action: "move", path: "C:\\a" }, h)).toThrow(/to \(pour move\)/);
    expect(() => requestedOperations({ action: "trash" }, h)).toThrow(/paths/);
    expect(() => requestedOperations({ action: "batch", operations: [] }, h)).toThrow(/non vide/);
    expect(() => requestedOperations({ action: "batch", operations: [{ op: "delete", path: "C:\\a" }] }, h)).toThrow(/inconnue/);
    expect(() => requestedOperations({ action: "batch", operations: ["x"] }, h)).toThrow(/invalide/);
    expect(() => requestedOperations({ action: "batch", operations: Array.from({ length: 201 }, () => ({ op: "mkdir", path: "C:\\a" })) }, h)).toThrow(/Trop/);
    expect(() => requestedOperations({ action: "format" }, h)).toThrow(/action doit être/);
    expect(requestedOperations({ action: "trash", paths: ["~/a", "C:\\b"] }, h).map((o) => o.path)).toEqual(["C:\\Users\\moi\\a", "C:\\b"]);
  });

  it.runIf(win)("isInside : le préfixe ne suffit pas, la casse est ignorée sous Windows", () => {
    expect(isInside("C:\\a\\b", "C:\\a\\b\\c", true)).toBe(true);
    expect(isInside("C:\\a\\b", "c:\\A\\B", true)).toBe(true);
    expect(isInside("C:\\a\\b", "C:\\a\\bc", true)).toBe(false);
    expect(isInside("C:\\a\\b", "C:\\a", true)).toBe(false);
    expect(isInside("C:\\a", "D:\\a", true)).toBe(false);
  });

  it.runIf(win)("forbiddenReason : protégé, enfant d'un protégé, CONTENANT un protégé, racine de disque ; un nom voisin passe", async () => {
    const { h, roots } = home();
    expect(await forbiddenReason(join(h, ".ssh"), roots)).toMatch(/emplacement protégé/);
    expect(await forbiddenReason(join(h, ".SSH", "nouveau", "x"), roots)).toMatch(/emplacement protégé/);
    expect(await forbiddenReason(h, roots)).toMatch(/contient l'emplacement protégé/);
    expect(await forbiddenReason(join(h, "Windows"), roots)).toMatch(/emplacement protégé/);
    expect(await forbiddenReason("C:\\", roots)).toMatch(/racine d'un disque/);
    expect(await forbiddenReason(join(h, ".sshfoo"), roots)).toBeNull();
    expect(await forbiddenReason(join(h, "documents", "a.txt"), roots)).toBeNull();
  });
});

describe("planFiles (disque réel, rien n'est modifié)", () => {
  it("simule le lot : un dossier créé par la première opération reçoit la deuxième sous le nom de sa source", async () => {
    const { h, roots } = home();
    write(join(h, "docs", "a.txt"));
    const plan = await planFiles({ action: "batch", operations: [{ op: "mkdir", path: join(h, "archive") }, { op: "move", path: join(h, "docs", "a.txt"), to: join(h, "archive") }, { op: "copy", path: join(h, "archive", "a.txt"), to: join(h, "copie.txt") }] }, roots, h, true);
    expect(plan.problems).toEqual([]);
    expect(plan.ops.map((o) => o.to)).toEqual([undefined, join(h, "archive", "a.txt"), join(h, "copie.txt")]);
    expect(plan.tier).toBe("mutate");
    expect(existsSync(join(h, "archive"))).toBe(false); // le disque n'a pas bougé
    expect(existsSync(join(h, "docs", "a.txt"))).toBe(true);
  });

  it("problèmes : source absente, destination existante (aucun écrasement), dossier dans lui-même, protégé, conteneur d'un protégé", async () => {
    const { h, roots } = home();
    write(join(h, "a.txt"));
    write(join(h, "b.txt"));
    mkdirSync(join(h, "d"));
    const p = (args: Record<string, unknown>) => planFiles(args, roots, h, true).then((x) => x.problems);
    expect(await p({ action: "move", path: join(h, "absent.txt"), to: join(h, "x.txt") })).toEqual([`${join(h, "absent.txt")} n'existe pas`]);
    expect((await p({ action: "copy", path: join(h, "a.txt"), to: join(h, "b.txt") }))[0]).toMatch(/existe déjà : rien n'est écrasé/);
    expect((await p({ action: "move", path: join(h, "d"), to: join(h, "d", "sous") }))[0]).toMatch(/dans lui-même/);
    expect((await p({ action: "copy", path: join(h, ".ssh", "id_rsa"), to: join(h, "vol.txt") }))[0]).toMatch(/emplacement protégé/);
    expect((await p({ action: "move", path: join(h, "a.txt"), to: join(h, ".ssh") }))[0]).toMatch(/emplacement protégé/);
    expect((await p({ action: "trash", path: h }))[0]).toMatch(/contient l'emplacement protégé/);
    expect((await p({ action: "mkdir", path: join(h, "a.txt") }))[0]).toMatch(/n'est pas un dossier/);
    expect((await planFiles({ action: "trash", paths: [join(h, "a.txt")] }, roots, h, true)).tier).toBe("destructive");
  });
});

describe("system_files (PowerShell simulé, vrai disque temporaire)", () => {
  const rig = () => {
    const d = home();
    const { ps, calls } = fakePs({ [A.TRASH]: (a: Args) => ({ trashed: (a?.paths as string[]) ?? [], errors: [] }) });
    const tools = systemDestroyTools({ platform: "win32", ps, home: d.h, env: d.env });
    return { ...d, ps, calls, plan: tool(tools, "system_files_plan"), files: tool(tools, "system_files") };
  };

  it("flags : le plan est une lecture auditée ; system_files demande un accord à chaque appel", () => {
    const { plan, files } = rig();
    expect([plan.dangerous, plan.audited, files.dangerous, files.audited]).toEqual([undefined, true, true, true]);
    expect(systemDestroyTools({ platform: "linux" })).toEqual([]);
  });

  it("l'essai à blanc produit EXACTEMENT le plan appliqué (mkdir, déplacement dans le dossier créé, copie)", async () => {
    const { h, plan, files } = rig();
    write(join(h, "docs", "a.txt"), "contenu");
    const args = { action: "batch", operations: [{ op: "mkdir", path: join(h, "archive") }, { op: "move", path: join(h, "docs", "a.txt"), to: join(h, "archive") }, { op: "copy", path: join(h, "archive", "a.txt"), to: join(h, "copie.txt") }] };
    const dry = JSON.parse(await plan.run(args, ctx));
    expect(dry).toMatchObject({ tier: "mutate", problems: [] });
    expect(existsSync(join(h, "archive"))).toBe(false);
    const applied = JSON.parse(await files.run(args, ctx));
    expect(applied.applied).toEqual(dry.plan);
    expect(readFileSync(join(h, "archive", "a.txt"), "utf8")).toBe("contenu");
    expect(readFileSync(join(h, "copie.txt"), "utf8")).toBe("contenu");
    expect(existsSync(join(h, "docs", "a.txt"))).toBe(false);
  });

  it("n'écrase jamais : le contenu de la destination est intact, rien n'est fait", async () => {
    const { h, files } = rig();
    write(join(h, "a.txt"), "source");
    write(join(h, "b.txt"), "destination");
    await expect(files.run({ action: "move", path: join(h, "a.txt"), to: join(h, "b.txt") }, ctx)).rejects.toThrow(/existe déjà/);
    await expect(files.run({ action: "copy", path: join(h, "a.txt"), to: join(h, "b.txt") }, ctx)).rejects.toThrow(/existe déjà/);
    expect(readFileSync(join(h, "b.txt"), "utf8")).toBe("destination");
    expect(readFileSync(join(h, "a.txt"), "utf8")).toBe("source");
  });

  it("un dossier se déplace et se copie avec son contenu ; un renommage garde le contenu", async () => {
    const { h, files } = rig();
    write(join(h, "src", "un.txt"), "1");
    write(join(h, "src", "sous", "deux.txt"), "2");
    await files.run({ action: "copy", path: join(h, "src"), to: join(h, "copie") }, ctx);
    expect(readFileSync(join(h, "copie", "sous", "deux.txt"), "utf8")).toBe("2");
    await files.run({ action: "move", path: join(h, "src"), to: join(h, "renomme") }, ctx);
    expect(existsSync(join(h, "src"))).toBe(false);
    expect(readFileSync(join(h, "renomme", "un.txt"), "utf8")).toBe("1");
  });

  it("précheck : un chemin protégé est refusé AVANT toute demande, et la demande décrit le plan", async () => {
    const { h, files } = rig();
    write(join(h, "a.txt"));
    await expect(files.precheck!({ action: "trash", path: join(h, ".ssh", "id_rsa") }, ctx)).rejects.toThrow(/emplacement protégé/);
    await expect(files.precheck!({ action: "move", path: join(h, "a.txt"), to: join(h, ".ssh") }, ctx)).rejects.toThrow(/emplacement protégé/);
    await expect(files.precheck!({ action: "trash", path: h }, ctx)).rejects.toThrow(/contient l'emplacement protégé/);
    await expect(files.precheck!({ action: "trash", path: join(h, "absent.txt") }, ctx)).rejects.toThrow(/n'existe pas/);
    const summary = await files.precheck!({ action: "batch", operations: Array.from({ length: 7 }, (_, i) => ({ op: "mkdir", path: join(h, `d${i}`) })) }, ctx);
    expect(summary).toMatch(/^Fichiers : 7 opérations — créer le dossier .*d0.*… \(\+2\)$/);
    expect(existsSync(join(h, "d0"))).toBe(false); // le précheck ne modifie rien
  });

  it("trash : un seul appel PowerShell pour des éléments consécutifs, avec les chemins en JSON ; une erreur de la corbeille remonte et dit ce qui est fait", async () => {
    const { h, files, calls } = rig();
    write(join(h, "a.txt"));
    write(join(h, "b.txt"));
    const out = JSON.parse(await files.run({ action: "trash", paths: [join(h, "a.txt"), join(h, "b.txt")] }, ctx));
    expect(out.applied).toHaveLength(2);
    expect(calls.filter((c) => c.script === A.TRASH)).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ paths: [join(h, "a.txt"), join(h, "b.txt")] });

    const bad = fakePs({ [A.TRASH]: (a: Args) => ({ trashed: [], errors: [`${(a?.paths as string[])[0]}: not on a fixed drive, it would be deleted for good`] }) });
    const d = home();
    write(join(d.h, "z.txt"));
    const t = tool(systemDestroyTools({ platform: "win32", ps: bad.ps, home: d.h, env: d.env }), "system_files");
    await expect(t.run({ action: "batch", operations: [{ op: "mkdir", path: join(d.h, "m") }, { op: "trash", path: join(d.h, "z.txt") }] }, ctx)).rejects.toThrow(/Corbeille : .*deleted for good.*Déjà fait : créer le dossier/);
    expect(existsSync(join(d.h, "z.txt"))).toBe(true); // jamais supprimé
  });

  it("le plan qui change entre l'accord et l'exécution n'est pas appliqué", async () => {
    const { h, files } = rig();
    write(join(h, "a.txt"));
    const args = { action: "move", path: join(h, "a.txt"), to: join(h, "archive") };
    await files.precheck!(args, ctx); // « accordé » sur ce plan : la destination n'existe pas, donc renommage en « archive »
    mkdirSync(join(h, "archive")); // puis la destination devient un dossier : le résultat serait archive\a.txt, pas le plan accordé
    await expect(files.run(args, ctx)).rejects.toThrow(/a changé depuis la demande d'accord/);
    expect(existsSync(join(h, "a.txt"))).toBe(true);
  });
});

describe("system_kill_process (PowerShell simulé)", () => {
  const procs = [
    { pid: 500, name: "chrome", path: "C:\\Chrome\\chrome.exe", rss: 1, cpu: 0 },
    { pid: 501, name: "chrome", path: "C:\\Chrome\\chrome.exe", rss: 1, cpu: 0 },
    { pid: 600, name: "monserveur", path: "C:\\x\\monserveur.exe", rss: 1, cpu: 0 },
  ];
  const rig = (stopBehaviour: (script: string, pid: unknown) => unknown = () => ({})) => {
    const { ps, calls } = fakePs({
      [S.PROCESSES]: (a: Args) => ({ total_memory: 1, rows: procs.filter((p) => p.name.includes(String(a?.name ?? ""))) }),
      [S.LISTENERS]: (a: Args) => (a?.port === 3000 ? [{ pid: 600, protocol: "tcp", name: "monserveur", user: "u" }] : a?.port === 80 ? [{ pid: 4, protocol: "tcp", name: "System", user: "" }] : []),
      [A.PROC_INFO]: (a: Args) => (a?.pid === 600 ? { pid: 600, name: "monserveur", path: "C:\\x\\monserveur.exe" } : a?.pid === 1234 ? { pid: 1234, name: "explorer", path: "C:\\Windows\\explorer.exe" } : null),
      [A.CLOSE_WINDOW]: (a: Args) => stopBehaviour(A.CLOSE_WINDOW, a?.pid),
      [A.FORCE_KILL]: (a: Args) => stopBehaviour(A.FORCE_KILL, a?.pid),
    });
    return { kill: tool(systemDestroyTools({ platform: "win32", ps, protectedPids: [777] }), "system_kill_process"), calls };
  };

  it("par pid : l'identité est relue, la demande dit quel processus, l'arrêt vérifie le nom (pid réattribué)", async () => {
    const { kill, calls } = rig();
    expect(await kill.precheck!({ pid: 600 }, ctx)).toBe("Demander la fermeture de monserveur (pid 600)");
    expect(await kill.precheck!({ pid: 600, force: true }, ctx)).toMatch(/^Arrêter net \(travail non enregistré perdu\) monserveur \(pid 600\)$/);
    const out = JSON.parse(await kill.run({ pid: 600, force: true }, ctx));
    expect(out).toEqual({ mode: "force", stopped: [{ pid: 600, name: "monserveur" }], errors: [] });
    expect(calls.filter((c) => c.script === A.FORCE_KILL).map((c) => c.args)).toEqual([{ pid: 600, name: "monserveur" }]);
    expect(calls.some((c) => c.script === A.CLOSE_WINDOW)).toBe(false);
  });

  it("par port, et par nom : un seul processus doit correspondre sauf all=true, avec la liste des candidats", async () => {
    const { kill } = rig();
    expect(JSON.parse(await kill.run({ port: 3000 }, ctx)).stopped).toEqual([{ pid: 600, name: "monserveur" }]);
    await expect(kill.run({ port: 3001 }, ctx)).rejects.toThrow(/Rien n'écoute/);
    await expect(kill.run({ name: "chrome" }, ctx)).rejects.toThrow(/correspond à 2 processus.*pid 500.*pid 501.*all=true/);
    expect(JSON.parse(await kill.run({ name: "chrome", all: true }, ctx)).stopped).toHaveLength(2);
    expect(JSON.parse(await kill.run({ name: "monserveur" }, ctx)).stopped).toEqual([{ pid: 600, name: "monserveur" }]);
    await expect(kill.run({ name: "introuvable" }, ctx)).rejects.toThrow(/Aucun processus ne correspond/);
  });

  it("refuse AVANT de demander : pid 0 et 4, Jarod et son parent, le pid protégé, l'Explorateur, ce qui écoute sur le port 80 (System)", async () => {
    const { kill, calls } = rig();
    for (const pid of [0, 4, process.pid, process.ppid, 777]) await expect(kill.precheck!({ pid }, ctx), `pid ${pid}`).rejects.toThrow(/cet outil ne l'arrête pas/);
    await expect(kill.precheck!({ pid: 1234 }, ctx)).rejects.toThrow(/système ou l'Explorateur/);
    await expect(kill.precheck!({ port: 80 }, ctx)).rejects.toThrow(/cet outil ne l'arrête pas/);
    // pid 0, 4 et les nôtres : refus sans même interroger le système.
    expect(calls.filter((c) => c.script === A.PROC_INFO).map((c) => c.args!.pid)).toEqual([1234]);
    expect(calls.some((c) => c.script === A.FORCE_KILL || c.script === A.CLOSE_WINDOW)).toBe(false);
  });

  it("critères : exactement un, entiers et booléens contrôlés", async () => {
    const { kill } = rig();
    await expect(kill.run({}, ctx)).rejects.toThrow(/exactement un critère/);
    await expect(kill.run({ pid: 600, port: 3000 }, ctx)).rejects.toThrow(/exactement un critère/);
    await expect(kill.run({ pid: 1.5 }, ctx)).rejects.toThrow(/pid doit être un entier/);
    await expect(kill.run({ pid: 600, force: "oui" }, ctx)).rejects.toThrow(/force doit être/);
    await expect(kill.run({ port: 70000 }, ctx)).rejects.toThrow(/entre 1 et 65535/);
    await expect(kill.run({ pid: 424242 }, ctx)).rejects.toThrow(/Aucun processus avec le pid/);
  });

  it("erreurs d'arrêt : pas de fenêtre, pid réattribué, accès refusé sont des erreurs par processus ; autre chose remonte", async () => {
    const polite = rig((script) => {
      if (script === A.CLOSE_WINDOW) throw new Error("NOWINDOW");
      return {};
    });
    expect(JSON.parse(await polite.kill.run({ pid: 600 }, ctx))).toMatchObject({ stopped: [], errors: [{ pid: 600, error: expect.stringMatching(/pas de fenêtre à fermer poliment.*force=true/) }] });
    const changed = rig(() => {
      throw new Error("CHANGED");
    });
    expect(JSON.parse(await changed.kill.run({ pid: 600, force: true }, ctx)).errors[0].error).toMatch(/réattribué.*rien n'a été fermé/);
    const boom = rig(() => {
      throw new Error("PowerShell a dépassé 20 s");
    });
    await expect(boom.kill.run({ pid: 600 }, ctx)).rejects.toThrow(/dépassé/);
    expect(stopErrorMessage("DENIED")).toMatch(/accès refusé/);
  });

  it("protectedReason : noms du système sans casse ni .exe, et chemin", () => {
    expect(protectedReason({ pid: 9, name: "LSASS.EXE" }, [])).toMatch(/système/);
    expect(protectedReason({ pid: 9, name: "x", path: "C:\\Windows\\Explorer.EXE" }, [])).toMatch(/Explorateur/);
    expect(protectedReason({ pid: 9, name: "chrome" }, [9])).toMatch(/Jarod/);
    expect(protectedReason({ pid: 9, name: "chrome" }, [])).toBeNull();
  });
});

describe.runIf(win)("sur cette machine (vrai PowerShell) : uniquement des fichiers et des processus créés par le test", () => {
  const tools = systemDestroyTools();
  const kill = tool(tools, "system_kill_process");
  const spawnIdle = (): ChildProcess => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    kids.push(child);
    return child;
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (cond: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return cond();
  };

  it("kill par pid : sans force un processus sans fenêtre répond « pas de fenêtre » et survit ; avec force il meurt", async () => {
    const child = spawnIdle();
    await until(() => child.pid !== undefined);
    const pid = child.pid!;
    const polite = JSON.parse(await kill.run({ pid }, ctx));
    expect(polite.stopped).toEqual([]);
    expect(polite.errors[0].error).toMatch(/pas de fenêtre à fermer poliment/);
    expect(alive(pid)).toBe(true);
    const forced = JSON.parse(await kill.run({ pid, force: true }, ctx));
    expect(forced.stopped).toEqual([{ pid, name: "node" }]);
    expect(await until(() => !alive(pid))).toBe(true);
    await expect(kill.run({ pid }, ctx)).rejects.toThrow(/Aucun processus avec le pid/);
  }, 60_000);

  it("kill par port : arrête ce qui écoute, et seulement cela", async () => {
    const free = await new Promise<number>((ok) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => ok(p));
      });
    });
    const child = spawn(process.execPath, ["-e", `require('net').createServer().listen(${free}, '127.0.0.1'); setInterval(() => {}, 1000)`], { stdio: "ignore", windowsHide: true });
    kids.push(child);
    const pid = child.pid!;
    expect(await until(() => execFileSync("netstat", ["-ano"], { encoding: "utf8" }).includes(`127.0.0.1:${free}`), 10_000)).toBe(true);
    const out = JSON.parse(await kill.run({ port: free, force: true }, ctx));
    expect(out.stopped).toEqual([{ pid, name: "node" }]);
    expect(await until(() => !alive(pid))).toBe(true);
    expect(alive(process.pid)).toBe(true);
  }, 60_000);

  it("refuse nos propres processus et les processus critiques réels", async () => {
    await expect(kill.run({ pid: process.pid, force: true }, ctx)).rejects.toThrow(/Jarod lui-même/);
    await expect(kill.run({ pid: 4, force: true }, ctx)).rejects.toThrow(/système/);
    const explorer = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-Process explorer | Select-Object -First 1).Id | ConvertTo-Json"], { encoding: "utf8" }));
    await expect(kill.run({ pid: explorer, force: true }, ctx)).rejects.toThrow(/Explorateur/);
    expect(alive(explorer)).toBe(true);
  }, 60_000);

  /** Cherche un élément dans la vraie corbeille par son nom d'origine, le restaure, et rend le chemin d'origine trouvé. */
  const restoreFromBin = (stem: string): string[] => {
    const script = `$sh = New-Object -ComObject Shell.Application; $bin = $sh.NameSpace(10); $found = @($bin.Items() | Where-Object { $_.Name -like '${stem}*' }); ($found | ForEach-Object { $bin.GetDetailsOf($_, 1) + '|' + $_.Name }) -join ';'; foreach ($i in $found) { $i.InvokeVerb('undelete') }`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
    return out ? out.split(";") : [];
  };

  it("trash réel : un fichier et un dossier vont dans la VRAIE corbeille (retrouvés puis restaurés), jamais supprimés pour de bon", async () => {
    const files = tool(tools, "system_files");
    const id = `jarod-corbeille-${Date.now().toString(36)}`;
    const dir = join(tmpdir(), id);
    mkdirSync(join(dir, "sous"), { recursive: true });
    dirs.push(dir);
    const f = join(dir, `${id}-fichier.txt`);
    write(f, "vivant");
    write(join(dir, "sous", "x.txt"), "dedans");
    const sub = join(dir, "sous");
    const out = JSON.parse(await files.run({ action: "trash", paths: [f, sub] }, ctx));
    expect(out.applied).toHaveLength(2);
    expect(existsSync(f)).toBe(false);
    expect(existsSync(sub)).toBe(false);
    const inBin = restoreFromBin(`${id}-fichier`);
    expect(inBin.length).toBe(1);
    expect(inBin[0]).toMatch(/jarod-dst|jarod-corbeille|Temp/i); // l'emplacement d'origine est conservé
    const bin2 = restoreFromBin("sous");
    expect(bin2.some((x) => x.includes(id))).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(readFileSync(f, "utf8")).toBe("vivant");
    expect(readFileSync(join(sub, "x.txt"), "utf8")).toBe("dedans");
  }, 120_000);

  it("trash réel par un nom court (8.3) : l'élément mis à la corbeille est bien compté comme fait", async (t) => {
    const files = tool(tools, "system_files");
    const id = `jarod-corbeille-court-${Date.now().toString(36)}`;
    const dir = join(tmpdir(), id);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const f = join(dir, `${id}-fichier-au-nom-long.txt`);
    write(f, "vivant");
    // Le nom court que Windows donne au fichier, quand le volume en fabrique (le runner de la CI, pas toutes les machines).
    const short = execFileSync("cmd.exe", ["/d", "/c", `for %I in ("${f}") do @echo %~sI`], { encoding: "utf8" })
      .replace(/"/g, "")
      .trim();
    // Le NOM DU FICHIER doit être raccourci et désigner ce fichier : sans nom court, cmd peut rendre un chemin incohérent (« D:\C:\… »)
    // dont le seul « ~ » vient d'un dossier parent (RUNNER~1 sur la CI).
    if (!short || short.toLowerCase() === f.toLowerCase() || !basename(short).includes("~") || !existsSync(short)) t.skip();
    const out = JSON.parse(await files.run({ action: "trash", paths: [short] }, ctx));
    expect(out.applied).toHaveLength(1);
    expect(existsSync(f)).toBe(false);
    expect(restoreFromBin(`${id}-fichier`).length).toBe(1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(readFileSync(f, "utf8")).toBe("vivant");
  }, 120_000);

  it("trash réel : un élément absent est une erreur, et rien d'autre n'est touché", async () => {
    const files = tool(tools, "system_files");
    const d = temp();
    write(join(d, "reste.txt"));
    await expect(files.run({ action: "trash", path: join(d, "absent.txt") }, ctx)).rejects.toThrow(/n'existe pas/);
    expect(readdirSync(d)).toEqual(["reste.txt"]);
  }, 60_000);

  it("mkdir, move, copy réels dans un dossier jetable", async () => {
    const files = tool(tools, "system_files");
    const d = temp();
    write(join(d, "a.txt"), "A");
    await files.run({ action: "batch", operations: [{ op: "mkdir", path: join(d, "x", "y") }, { op: "copy", path: join(d, "a.txt"), to: join(d, "x", "y") }, { op: "move", path: join(d, "a.txt"), to: join(d, "b.txt") }] }, ctx);
    expect(readFileSync(join(d, "x", "y", "a.txt"), "utf8")).toBe("A");
    expect(readFileSync(join(d, "b.txt"), "utf8")).toBe("A");
    expect(existsSync(join(d, "a.txt"))).toBe(false);
  }, 60_000);
});
