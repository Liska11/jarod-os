import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolDef } from "../src/registry.js";
import { checkScope, defaultRoots, findFiles, matchesName, matchesTime, parseDate, resolveWhen, searchExtensions, type Search } from "../src/system/find.js";
import { systemReadTools } from "../src/system/tools.js";

const ctx = { sessionId: "s", workspace: null } as ToolContext;
const base: Search = { kind: "any", since: null, until: null, extensions: [], limit: 50 };
const s = (o: Partial<Search>): Search => ({ ...base, ...o });

describe("prédicats purs", () => {
  it("nom : fragment sans casse, text = nom aussi, les deux se cumulent", () => {
    expect(matchesName("Facture-Octobre.PDF", false, s({ name: "octobre" }))).toBe(true);
    expect(matchesName("Facture-Octobre.PDF", false, s({ name: "septembre" }))).toBe(false);
    expect(matchesName("Facture-Octobre.PDF", false, s({ text: "FACTURE" }))).toBe(true);
    expect(matchesName("Facture-Octobre.PDF", false, s({ name: "facture", text: "mars" }))).toBe(false);
  });

  it("type : par extensions, dossiers à part, capture d'écran = nom + image", () => {
    expect(matchesName("a.PNG", false, s({ kind: "image" }))).toBe(true);
    expect(matchesName("a.pdf", false, s({ kind: "image" }))).toBe(false);
    expect(matchesName("images", true, s({ kind: "image" }))).toBe(false); // un dossier n'est pas une image
    expect(matchesName("images", true, s({ kind: "folder" }))).toBe(true);
    expect(matchesName("a.png", false, s({ kind: "folder" }))).toBe(false);
    expect(matchesName("Capture d'écran 2026.png", false, s({ kind: "screenshot" }))).toBe(true);
    expect(matchesName("Capture d’écran 2026.png", false, s({ kind: "screenshot" }))).toBe(true);
    expect(matchesName("photo.png", false, s({ kind: "screenshot" }))).toBe(false);
    expect(matchesName("Screenshot 1.pdf", false, s({ kind: "screenshot" }))).toBe(false);
    expect(matchesName("sans-extension", false, s({ kind: "image" }))).toBe(false);
    expect(matchesName(".png", false, s({ kind: "image" }))).toBe(false); // un fichier caché sans nom n'a pas d'extension
  });

  it("extensions : avec ou sans point, sans casse ; avec un type, l'intersection — vide donne RIEN, pas tout", () => {
    expect(matchesName("a.JPG", false, s({ extensions: [".jpg"] }))).toBe(true);
    expect(matchesName("a.png", false, s({ extensions: ["jpg"] }))).toBe(false);
    expect([...searchExtensions(s({ kind: "image", extensions: ["png", "pdf"] }))]).toEqual(["png"]);
    expect(matchesName("a.pdf", false, s({ kind: "image", extensions: ["pdf"] }))).toBe(false);
    expect(matchesName("a.png", false, s({ kind: "pdf", extensions: ["png"] }))).toBe(false);
    expect(matchesName("a.png", false, s({ extensions: ["", "."] }))).toBe(true); // extensions vides = pas de contrainte
  });

  it("dates : jour local, fin de journée exclusive, ISO, et les jours impossibles sont refusés", () => {
    const start = parseDate("2026-10-11", false);
    expect(start).toBe(new Date(2026, 9, 11).getTime());
    expect(parseDate("2026-10-11", true)).toBe(new Date(2026, 9, 12).getTime());
    expect(parseDate("2026-10-11T10:00:00Z", false)).toBe(Date.UTC(2026, 9, 11, 10));
    for (const bad of ["2026-02-31", "hier", "11/10/2026", "2026-13-01", "2026-10-11x", "", "2026-10"]) expect(() => parseDate(bad, false), bad).toThrow(/date invalide/);
    expect(matchesTime(5, { since: 5, until: 6 })).toBe(true);
    expect(matchesTime(6, { since: 5, until: 6 })).toBe(false); // `until` exclusif
    expect(matchesTime(4, { since: 5, until: null })).toBe(false);
    expect(matchesTime(4, { since: null, until: null })).toBe(true);
  });

  it("fenêtres relatives : mardi 2026-10-13 (la semaine commence le lundi), passage de mois et d'année", () => {
    const tue = new Date(2026, 9, 13);
    expect(resolveWhen("today", tue)).toEqual({ since: "2026-10-13", until: "2026-10-13" });
    expect(resolveWhen("yesterday", tue)).toEqual({ since: "2026-10-12", until: "2026-10-12" });
    expect(resolveWhen("this_week", tue)).toEqual({ since: "2026-10-12", until: "2026-10-13" });
    expect(resolveWhen("this_week", new Date(2026, 9, 11))).toEqual({ since: "2026-10-05", until: "2026-10-11" }); // dimanche : la semaine du lundi 5
    expect(resolveWhen("last_7_days", tue)).toEqual({ since: "2026-10-06", until: "2026-10-13" });
    expect(resolveWhen("this_month", tue)).toEqual({ since: "2026-10-01", until: "2026-10-13" });
    expect(resolveWhen("yesterday", new Date(2027, 0, 1))).toEqual({ since: "2026-12-31", until: "2026-12-31" });
  });

  // Dossiers Windows (OneDrive, AppData) et casse ignorée : règles de Windows, seule plateforme de la famille system_* (tools.ts).
  it.runIf(process.platform === "win32")("dossiers par défaut : ceux de la personne qui existent (OneDrive en plus, sans doublon), sinon le dossier personnel", () => {
    const exists = new Set(["C:\\u\\Documents", "C:\\u\\Downloads", "D:\\od\\Documents"]);
    const got = defaultRoots({ OneDrive: "D:\\od" }, "C:\\u", (p) => exists.has(p));
    expect(got).toEqual({ roots: ["C:\\u\\Documents", "C:\\u\\Downloads", "D:\\od\\Documents"], skipAppData: true });
    expect(defaultRoots({ OneDrive: "C:\\U" }, "C:\\u", (p) => exists.has(p)).roots).toEqual(["C:\\u\\Documents", "C:\\u\\Downloads"]);
    expect(defaultRoots({}, "C:\\u", () => false)).toEqual({ roots: ["C:\\u"], skipAppData: true });
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-find-"));
  dirs.push(d);
  return d;
};
const put = (path: string, mtime?: Date) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  if (mtime) utimesSync(path, mtime, mtime);
};
const names = (r: { files: { path: string }[] }, root: string) => r.files.map((f) => f.path.slice(root.length + 1).replaceAll("\\", "/")).sort();
const env = (home: string): NodeJS.ProcessEnv => ({ SystemRoot: join(home, "Windows"), windir: join(home, "Windows"), ProgramFiles: join(home, "Program Files"), APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") });

describe("findFiles (vrai disque)", () => {
  it("trouve par nom, type, extension et dossier ; ne lit pas le contenu ; les plus récents d'abord", async () => {
    const home = temp();
    put(join(home, "Documents", "rapport.pdf"), new Date(2026, 0, 1));
    put(join(home, "Documents", "sous", "rapport-final.pdf"), new Date(2026, 5, 1));
    put(join(home, "Documents", "photo.png"));
    mkdirSync(join(home, "Documents", "rapports"));
    writeFileSync(join(home, "Documents", "notes.txt"), "le mot rapport est dans le contenu seulement");
    const e = env(home);
    const all = await findFiles(s({ name: "rapport" }), { home, env: e, scope: home });
    expect(names(all, home)).toEqual(["Documents/rapport.pdf", "Documents/rapports", "Documents/sous/rapport-final.pdf"]); // pas notes.txt
    const pdfs = (await findFiles(s({ kind: "pdf" }), { home, env: e, scope: home })).files.map((f) => f.path);
    expect(pdfs.map((p) => p.slice(home.length + 1))).toEqual([join("Documents", "sous", "rapport-final.pdf"), join("Documents", "rapport.pdf")]); // modifié le plus récemment d'abord (juin avant janvier)
    expect(all.files.find((f) => f.path.endsWith("rapports"))!.kind).toBe("folder");
    expect(all.files.find((f) => f.path.endsWith("rapports"))!.size).toBeNull();
    expect(all.partial).toBe(false);
    expect(names(await findFiles(s({ kind: "pdf" }), { home, env: e, scope: home }), home)).toEqual(["Documents/rapport.pdf", "Documents/sous/rapport-final.pdf"]);
    expect(names(await findFiles(s({ kind: "folder" }), { home, env: e, scope: home }), home)).toEqual(["Documents", "Documents/rapports", "Documents/sous"]);
    expect(names(await findFiles(s({ extensions: ["png"] }), { home, env: e, scope: join(home, "Documents") }), home)).toEqual(["Documents/photo.png"]);
    expect((await findFiles(s({ name: "rapport", limit: 1 }), { home, env: e, scope: home })).files).toHaveLength(1);
  });

  it("date de création : les fichiers de maintenant passent `since` d'hier et pas `since` de demain", async () => {
    const home = temp();
    put(join(home, "a.txt"));
    const e = env(home);
    const yesterday = parseDate(resolveWhen("yesterday").since, false);
    const tomorrow = parseDate(resolveWhen("today").until, true);
    expect((await findFiles(s({ since: yesterday }), { home, env: e, scope: home })).files).toHaveLength(1);
    expect((await findFiles(s({ since: tomorrow }), { home, env: e, scope: home })).files).toHaveLength(0);
    expect((await findFiles(s({ until: yesterday }), { home, env: e, scope: home })).files).toHaveLength(0);
  });

  it.runIf(process.platform === "win32")("emplacements protégés : ni parcourus ni cités, et un scope protégé est refusé AVANT toute lecture", async () => {
    const home = temp();
    put(join(home, ".ssh", "id_secret.txt"));
    put(join(home, "AppData", "Roaming", "Microsoft", "Credentials", "id_cred.txt"));
    put(join(home, "Windows", "id_win.txt"));
    put(join(home, "Documents", "id_ok.txt"));
    const e = env(home);
    expect(names(await findFiles(s({ name: "id_" }), { home, env: e, scope: home }), home)).toEqual(["Documents/id_ok.txt"]);
    expect(names(await findFiles(s({ kind: "folder" }), { home, env: e, scope: home }), home)).toEqual(["AppData", "AppData/Roaming", "AppData/Roaming/Microsoft", "Documents"]);
    for (const p of [join(home, ".ssh"), join(home, ".SSH", "x"), join(home, "Windows")]) expect(() => checkScope(p, e, home), p).toThrow(/protégé/);
    await expect(findFiles(s({ name: "id_" }), { home, env: e, scope: join(home, ".ssh") })).rejects.toThrow(/protégé/);
    expect(() => checkScope("Documents", e, home)).toThrow(/non absolu/);
    expect(checkScope("~", e, home)).toBe(home);
  });

  it("bruit et liens : node_modules et .git ignorés, une jonction n'est ni suivie ni citée, AppData sauté sans scope", async () => {
    const home = temp();
    put(join(home, "Documents", "node_modules", "pkg", "cible.txt"));
    put(join(home, "Documents", ".git", "cible.txt"));
    put(join(home, "Documents", "reel", "cible.txt"));
    const outside = temp();
    put(join(outside, "cible.txt"));
    symlinkSync(outside, join(home, "Documents", "lien"), "junction");
    const e = env(home);
    expect(names(await findFiles(s({ name: "cible" }), { home, env: e, scope: join(home, "Documents") }), home)).toEqual(["Documents/reel/cible.txt"]);
    expect((await findFiles(s({ name: "lien" }), { home, env: e, scope: join(home, "Documents") })).files).toEqual([]); // le lien lui-même n'est pas cité
    put(join(home, "AppData", "Local", "cible.txt"));
    // sans scope : les dossiers par défaut (ici aucun n'existe sauf Documents) ; le dossier personnel n'est jamais parcouru en entier
    const noScope = await findFiles(s({ name: "cible" }), { home, env: e });
    expect(noScope.roots).toEqual([join(home, "Documents")]);
    expect(names(noScope, home)).toEqual(["Documents/reel/cible.txt"]);
  });

  it("le délai et le plafond d'entrées arrêtent le parcours et le disent ; l'interruption lève", async () => {
    const home = temp();
    for (let i = 0; i < 30; i++) put(join(home, `f${i}.txt`));
    const e = env(home);
    const capped = await findFiles(s({ name: "f" }), { home, env: e, scope: home, maxEntries: 5 });
    expect(capped.partial).toBe(true);
    expect(capped.scanned).toBeLessThanOrEqual(5);
    expect((await findFiles(s({ name: "f" }), { home, env: e, scope: home, deadlineMs: -1 })).partial).toBe(true);
    const ac = new AbortController();
    ac.abort();
    await expect(findFiles(s({ name: "f" }), { home, env: e, scope: home, signal: ac.signal })).rejects.toThrow("Interrompu");
  });
});

const tool = (tools: ToolDef[]) => tools.find((t) => t.name === "system_find_files")!;

describe("outil system_find_files", () => {
  const make = (home: string) => tool(systemReadTools({ platform: "win32", home, env: env(home) }));
  const call = async (t: ToolDef, args: Record<string, unknown>) => JSON.parse(String(await t.run(args, ctx))) as Record<string, any>;

  it("exige un critère, valide les entrées et rend le JSON documenté", async () => {
    const home = temp();
    put(join(home, "Documents", "Capture d'écran 1.png"));
    put(join(home, "Documents", "autre.png"));
    const t = make(home);
    await expect(t.run({}, ctx)).rejects.toThrow(/au moins un critère/);
    await expect(t.run({ limit: 5 }, ctx)).rejects.toThrow(/au moins un critère/);
    await expect(t.run({ kind: "musique" }, ctx)).rejects.toThrow(/kind doit être/);
    await expect(t.run({ when: "demain" }, ctx)).rejects.toThrow(/when doit être/);
    await expect(t.run({ name: "x", since: "hier" }, ctx)).rejects.toThrow(/date invalide/);
    await expect(t.run({ name: "x", scope: join(home, ".ssh") }, ctx)).rejects.toThrow(/protégé/);
    const out = await call(t, { kind: "screenshot", when: "today", scope: home });
    expect(out.count).toBe(1);
    expect(out.files[0].path).toBe(join(home, "Documents", "Capture d'écran 1.png"));
    expect(Object.keys(out.files[0]).sort()).toEqual(["created", "kind", "modified", "path", "size"]);
    expect(out.partial).toBe(false);
    expect(out.note).toBeNull();
    const none = await call(t, { name: "inexistant", scope: home });
    expect(none).toMatchObject({ count: 0, files: [], partial: false });
    expect(none.note).toMatch(/Aucun résultat dans ce dossier/);
  });

  it("limit est bornée (1-200), extensions de types étrangers ignorées, lecture seule audité sans accord", async () => {
    const home = temp();
    for (let i = 0; i < 3; i++) put(join(home, `n${i}.txt`));
    const t = make(home);
    expect(t.dangerous).toBeFalsy();
    expect(t.audited).toBe(true);
    expect((await call(t, { name: "n", scope: home, limit: 0 })).count).toBe(1); // 0 → 1
    expect((await call(t, { name: "n", scope: home, limit: 9999 })).count).toBe(3);
    expect((await call(t, { extensions: ["txt", 5, null], scope: home })).count).toBe(3);
  });
});
