/**
 * Q12 — garde fichiers (`src/main/file-gate.ts`) sur de vrais dossiers : racines, interdits, forme des chemins,
 * chemin RÉEL (jonction et lien symbolique pointant hors racine), journal. Dossier personnel SIMULÉ (`home` +
 * `env: {}`) : les racines interdites « ~/.ssh »… sont créées dans un dossier temporaire, jamais touchées pour de vrai.
 */
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { FileGate, GateDenied, isForbiddenName, sanitizeSegment } from "../src/main/file-gate.js";

afterEach(cleanup);

// La garde est jugée en `platform: "win32"` sur de VRAIS dossiers (jonctions, casse, « lecteur:\ ») : sous Linux et macOS, les dossiers
// temporaires ont des chemins POSIX que cette forme refuse par construction. Seuls les noms assainis (pure chaîne) tournent partout.
const win = process.platform === "win32";

function world(opts: { workspace?: string | null; env?: NodeJS.ProcessEnv } = {}) {
  const home = realpathSync.native(tempDir());
  const data = join(home, "AppData", "Roaming", "Jarod-One", "data");
  const staging = join(data, "profiles", "default", "attachments", "staging");
  mkdirSync(staging, { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "CLÉ");
  const logs = tempDir();
  const work = { folders: [] as { path: string; source: "workspace" | "session" }[] };
  if (opts.workspace) work.folders.push({ path: opts.workspace, source: "workspace" });
  const gate = new FileGate({
    protectedDirs: () => [data],
    stagingRoot: () => staging,
    mediaRoot: () => join(tempDir(), "absent-media"),
    workFolders: () => work.folders,
    logFile: () => join(logs, "file-gate.jsonl"),
    home,
    env: opts.env ?? {},
    platform: "win32",
  });
  const journal = () =>
    readFileSync(join(logs, "file-gate.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { gate, home, data, staging, work, journal };
}

const denied = (fn: () => unknown, reason: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GateDenied);
    expect((e as GateDenied).reason).toMatch(reason);
    return;
  }
  throw new Error("accès accordé alors qu'un refus était attendu");
};

describe.runIf(win)("Q12 garde fichiers : racines", () => {
  it("(b) sans dossier de travail : aucun accès (fail-closed) ; le dossier des pièces collées reste lisible", () => {
    const { gate, staging } = world();
    const file = join(realpathSync.native(tempDir()), "a.txt");
    writeFileSync(file, "x");
    denied(() => gate.authorize("read-file", file, "file"), /hors des dossiers de travail/);
    writeFileSync(join(staging, "collé.png"), "p");
    expect(gate.authorize("read-file", join(staging, "collé.png"), "file")).toBe(realpathSync.native(join(staging, "collé.png")));
  });

  it("(a) dossiers de travail = racines ; sous-dossiers compris ; casse ignorée ; JAROD_WORKDIR lu au démarrage", () => {
    const ws = realpathSync.native(tempDir());
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "main.ts"), "x");
    const other = realpathSync.native(tempDir());
    writeFileSync(join(other, "b.txt"), "y");
    const { gate } = world({ workspace: ws, env: { JAROD_WORKDIR: ` ${other} ; ` } });
    expect(gate.authorize("read-file", join(ws, "src", "main.ts"), "file")).toBe(join(ws, "src", "main.ts"));
    expect(gate.authorize("read-file", join(ws, "SRC", "MAIN.TS"), "file").toLowerCase()).toBe(join(ws, "src", "main.ts").toLowerCase());
    expect(gate.authorize("read-file", join(other, "b.txt"), "file")).toBe(join(other, "b.txt"));
    expect(gate.roots().map((r) => r.source)).toEqual(["workspace", "env", "staging"]);
  });

  it("une racine n'est ni le dossier personnel, ni une racine de lecteur, ni un ancêtre ou un intérieur d'une racine interdite", () => {
    const { gate, home, data, journal } = world();
    expect(gate.pick(home)).toMatchObject({ ok: false, reason: "dossier personnel" });
    expect(gate.pick("C:\\")).toMatchObject({ ok: false, reason: "racine de lecteur" });
    mkdirSync(join(home, "AppData", "Local"), { recursive: true });
    expect(gate.pick(join(home, "AppData"))).toMatchObject({ ok: false, reason: expect.stringMatching(/contient un dossier protégé/) });
    expect(gate.pick(join(home, ".ssh"))).toMatchObject({ ok: false, reason: expect.stringMatching(/nom protégé|dossier protégé/) });
    expect(gate.pick(data)).toMatchObject({ ok: false, reason: expect.stringMatching(/dossier protégé/) });
    const docs = join(home, "Documents");
    mkdirSync(docs);
    expect(gate.pick(docs)).toEqual({ ok: true, path: docs });
    // Ajouts et refus journalisés (Q12 : « journaliser les ajouts de racines »).
    const j = journal();
    expect(j.filter((e) => e.op === "root-refused").map((e) => e.reason)).toContain("dossier personnel");
    expect(j.filter((e) => e.op === "root-added")).toEqual([expect.objectContaining({ channel: "select-folder", path: docs, source: "select-folder" })]);
  });

  it("dossier de travail invalide (dossier personnel) : ignoré et journalisé UNE fois", () => {
    const { gate, home, work, journal } = world();
    work.folders.push({ path: home, source: "session" });
    const f = join(home, "note.txt");
    writeFileSync(f, "x");
    denied(() => gate.authorize("read-file", f, "file"), /hors des dossiers de travail/);
    denied(() => gate.authorize("read-file", f, "file"), /hors des dossiers de travail/);
    expect(journal().filter((e) => e.op === "root-refused" && e.source === "session")).toHaveLength(1);
  });

  it("dossier lié : choisi dans la boîte native ou sous un dossier de travail — jamais un chemin libre", () => {
    const ws = realpathSync.native(tempDir());
    mkdirSync(join(ws, "sous"));
    const { gate } = world({ workspace: ws });
    const free = realpathSync.native(tempDir());
    denied(() => gate.bindable("set-session-context-folder", free), /non choisi/);
    expect(gate.bindable("set-session-context-folder", join(ws, "sous"))).toBe(join(ws, "sous"));
    expect(gate.pick(free)).toEqual({ ok: true, path: free });
    expect(gate.bindable("set-session-context-folder", free)).toBe(free);
  });
});

describe.runIf(win)("Q12 garde fichiers : interdits et forme des chemins", () => {
  it("noms protégés partout, même sous une racine", () => {
    const ws = realpathSync.native(tempDir());
    const { gate } = world({ workspace: ws });
    for (const name of [".env", ".env.local", "server.key", "cert.pem", "a.pfx", "b.p12", "id_rsa", "id_ed25519.pub", "coffre.kdbx", "db.key.dpapi", "auth.json", "credentials.csv"]) {
      writeFileSync(join(ws, name), "s");
      denied(() => gate.authorize("read-file", join(ws, name), "file"), /nom protégé/);
    }
    mkdirSync(join(ws, "backup-hermes"));
    writeFileSync(join(ws, "backup-hermes", "config.yaml"), "s");
    denied(() => gate.authorize("read-file", join(ws, "backup-hermes", "config.yaml"), "file"), /nom protégé \(« backup-hermes »\)/);
    expect(isForbiddenName("notes.md")).toBe(false);
    expect(isForbiddenName("keyboard.txt")).toBe(false);
  });

  it("UNC, périphérique, flux alternatif, relatif au lecteur, relatif, octet nul : refusés avant tout accès disque", () => {
    const { gate } = world({ workspace: realpathSync.native(tempDir()) });
    denied(() => gate.authorize("read-file", "\\\\serveur\\partage\\a.txt", "file"), /UNC/);
    denied(() => gate.authorize("read-file", "\\\\?\\C:\\Windows\\win.ini", "file"), /UNC ou de périphérique/);
    denied(() => gate.authorize("read-file", "\\\\.\\PhysicalDrive0", "file"), /UNC ou de périphérique/);
    denied(() => gate.authorize("read-file", "C:\\a.txt:flux", "file"), /flux alternatif/);
    denied(() => gate.authorize("read-file", "C:a.txt", "file"), /chemin absolu attendu/);
    denied(() => gate.authorize("read-file", "dossier\\a.txt", "file"), /chemin absolu attendu/);
    denied(() => gate.authorize("read-file", "C:\\a\0.txt", "file"), /octet nul/);
    denied(() => gate.authorize("read-file", 42, "file"), /chemin absent/);
  });

  it("données de Jarod interdites, sauf le dossier des pièces collées ; dossier au lieu d'un fichier refusé", () => {
    const { gate, data, staging } = world();
    writeFileSync(join(data, "profiles", "default", "SOUL.md"), "s");
    denied(() => gate.authorize("read-file", join(data, "profiles", "default", "SOUL.md"), "file"), /hors des dossiers de travail|dossier protégé/);
    denied(() => gate.authorize("read-file", staging, "file"), /pas un fichier/);
  });

  it("destination choisie dans la boîte native : libre, mais jamais dans un dossier protégé ni sous un nom protégé", () => {
    const { gate, home } = world();
    const dl = join(home, "Downloads");
    mkdirSync(dl);
    expect(gate.userChosen("save-media-file", join(dl, "image.png"), false)).toBe(join(dl, "image.png"));
    denied(() => gate.userChosen("save-media-file", join(home, ".ssh", "authorized_keys"), false), /protégé/);
    denied(() => gate.userChosen("save-media-file", join(dl, "id_rsa"), false), /nom protégé/);
  });
});

describe.runIf(win)("Q12 garde fichiers : chemin RÉEL (jonction, lien symbolique pointant hors racine)", () => {
  it("jonction de dossier sous la racine vers l'extérieur : refus (contrôle sur le chemin réel)", () => {
    const ws = realpathSync.native(tempDir());
    const outside = realpathSync.native(tempDir());
    writeFileSync(join(outside, "secret.txt"), "hors racine");
    symlinkSync(outside, join(ws, "lien"), "junction");
    const { gate, journal } = world({ workspace: ws });
    denied(() => gate.authorize("read-file", join(ws, "lien", "secret.txt"), "file"), /hors des dossiers de travail/);
    denied(() => gate.authorize("read-directory", join(ws, "lien"), "dir"), /hors des dossiers de travail/);
    expect(journal().at(-1)).toMatchObject({ op: "deny", channel: "read-directory", path: join(ws, "lien") });
  });

  it("jonction sous la racine vers un dossier protégé (~/.ssh) : refus", () => {
    const ws = realpathSync.native(tempDir());
    const { gate, home } = world({ workspace: ws });
    symlinkSync(join(home, ".ssh"), join(ws, "cles"), "junction");
    denied(() => gate.authorize("read-file", join(ws, "cles", "id_ed25519"), "file"), /protégé/);
  });

  it("lien symbolique de FICHIER sous la racine vers l'extérieur : refus (si Windows autorise la création du lien)", (t) => {
    const ws = realpathSync.native(tempDir());
    const outside = realpathSync.native(tempDir());
    writeFileSync(join(outside, "secret.txt"), "hors racine");
    try {
      symlinkSync(join(outside, "secret.txt"), join(ws, "raccourci.txt"), "file");
    } catch (e) {
      // Sans le mode développeur, Windows refuse les liens de fichier à un compte non administrateur (EPERM).
      if ((e as NodeJS.ErrnoException).code === "EPERM") return t.skip();
      throw e;
    }
    const { gate } = world({ workspace: ws });
    denied(() => gate.authorize("read-file", join(ws, "raccourci.txt"), "file"), /hors des dossiers de travail/);
  });

  it("racine elle-même atteinte par une jonction : jugée sur son chemin réel", () => {
    const real = realpathSync.native(tempDir());
    writeFileSync(join(real, "a.txt"), "x");
    const via = join(realpathSync.native(tempDir()), "acces");
    symlinkSync(real, via, "junction");
    const { gate } = world({ workspace: via });
    expect(gate.authorize("read-file", join(real, "a.txt"), "file")).toBe(join(real, "a.txt"));
    expect(gate.roots()[0]).toEqual({ path: real, source: "workspace" });
  });
});

describe("Q12 : noms assainis", () => {
  it("ni séparateur, ni contrôle, ni « .. »", () => {
    expect(sanitizeSegment("../../evil.txt", "f")).toBe(".evil.txt");
    expect(sanitizeSegment("a\\b:c*?.png", "f")).toBe("abc.png");
    expect(sanitizeSegment("..", "f")).toBe("f");
    expect(sanitizeSegment("", "f")).toBe("f");
  });
});

describe.runIf(win)("SPECS-P5-WORKSPACE.md : garde du dossier de travail PAR DÉFAUT (pickedOnly, plus stricte que bindable)", () => {
  it("choisi dans la boîte native pendant ce lancement : accepté, chemin réel rendu", () => {
    const { gate } = world();
    const dir = realpathSync.native(tempDir());
    expect(gate.pick(dir)).toEqual({ ok: true, path: dir });
    expect(gate.pickedOnly("set-default-workspace", dir, null)).toBe(dir);
  });

  it("jamais choisi : REFUS, même sous un dossier de travail existant (ce que bindable accepte), et le refus est journalisé", () => {
    const ws = realpathSync.native(tempDir());
    mkdirSync(join(ws, "sous"));
    const { gate, journal } = world({ workspace: ws });
    expect(gate.bindable("set-session-context-folder", join(ws, "sous"))).toBe(join(ws, "sous")); // le bouton du Chat l'accepte
    denied(() => gate.pickedOnly("set-default-workspace", join(ws, "sous"), null), /non choisi/);
    const free = realpathSync.native(tempDir());
    denied(() => gate.pickedOnly("set-default-workspace", free, null), /non choisi/);
    expect(journal().filter((e) => e.op === "deny" && e.channel === "set-default-workspace")).toHaveLength(2);
  });

  it("fichier, dossier personnel, racine interdite (.ssh), dossier de données Jarod : refusés même après un choix", () => {
    const { gate, home, data } = world();
    const file = join(realpathSync.native(tempDir()), "a.txt");
    writeFileSync(file, "x");
    denied(() => gate.pickedOnly("set-default-workspace", file, null), /pas un dossier/);
    for (const forbidden of [home, join(home, ".ssh"), data]) {
      gate.pick(forbidden); // la boîte native peut proposer n'importe quoi : la garde juge
      denied(() => gate.pickedOnly("set-default-workspace", forbidden, null), /./);
    }
  });

  it("lien symbolique ou jonction vers un dossier interdit : refusé sur le chemin RÉEL", () => {
    const { gate, home } = world();
    const base = realpathSync.native(tempDir());
    const link = join(base, "innocent");
    try {
      symlinkSync(join(home, ".ssh"), link, "junction");
    } catch {
      return; // création de lien impossible sur cette machine : le cas n'est pas atteignable
    }
    gate.pick(link);
    denied(() => gate.pickedOnly("set-default-workspace", link, null), /./);
  });

  it("chemin relatif, UNC, flux alternatif, valeur non texte : refusés avant tout accès disque", () => {
    const { gate } = world();
    for (const bad of ["dossier\\sous", "\\\\serveur\\partage", "C:\\a:flux", "C:a", 42, null, undefined]) {
      denied(() => gate.pickedOnly("set-default-workspace", bad, null), /./);
    }
  });

  it("la valeur DÉJÀ enregistrée redonnée est acceptée sans nouveau choix (aucun effet) ; une autre non choisie reste refusée", () => {
    const { gate } = world();
    const stored = realpathSync.native(tempDir());
    const other = realpathSync.native(tempDir());
    expect(gate.pickedOnly("set-default-workspace", stored, stored)).toBe(stored);
    denied(() => gate.pickedOnly("set-default-workspace", other, stored), /non choisi/);
  });

  it("une valeur enregistrée devenue invalide (dossier supprimé) n'est plus acceptée", () => {
    const { gate } = world();
    const gone = join(realpathSync.native(tempDir()), "disparu");
    denied(() => gate.pickedOnly("set-default-workspace", gone, gone), /./);
  });
});
