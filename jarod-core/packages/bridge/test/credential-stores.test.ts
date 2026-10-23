// 2026-10-22 — le garde fichiers du pont refuse les mêmes magasins d'identifiants que les outils système, le garde du shell et le pont Python
// (contracts/v1/credential-stores.reference.json). Faux dossier personnel dans un dossier temporaire : rien de réel n'est ouvert.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { PROTECTED_HOME_DIRS, ShellGuardService } from "@jarod/plugin-permissions";
import { afterEach, describe, expect, it } from "vitest";
import { FileGate } from "../src/main/file-gate.js";

afterEach(cleanup);

function referenceFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++, dir = dirname(dir)) {
    const f = join(dir, "contracts", "v1", "credential-stores.reference.json");
    if (existsSync(f)) return f;
  }
  throw new Error("contracts/v1/credential-stores.reference.json introuvable");
}
const REF = JSON.parse(readFileSync(referenceFile(), "utf8")) as { homeDirs: string[]; homeFiles: string[]; windows: { roaming: string[]; local: string[]; programData: string[] } };
const HOME_ENTRIES = [...REF.homeDirs, ...REF.homeFiles];

function gate(home: string, env: NodeJS.ProcessEnv) {
  const data = join(home, "AppData", "Roaming", "Jarod-One", "data");
  mkdirSync(data, { recursive: true });
  return new FileGate({
    protectedDirs: () => [data],
    stagingRoot: () => join(data, "staging"),
    mediaRoot: () => join(tempDir(), "absent-media"),
    workFolders: () => [],
    logFile: () => join(tempDir(), "file-gate.jsonl"),
    home,
    env,
    platform: "win32",
  });
}

describe("garde fichiers — magasins d'identifiants de la référence", () => {
  it("chaque entrée de la référence est une racine interdite", () => {
    const home = realpathSync.native(tempDir());
    const env = { APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), ProgramData: join(home, "ProgramData") } as NodeJS.ProcessEnv;
    const roots = gate(home, env).forbiddenRoots().map((r) => r.toLowerCase());
    for (const rel of HOME_ENTRIES) expect(roots, rel).toContain(join(home, ...rel.split("/")).toLowerCase());
    for (const rel of REF.windows.roaming) expect(roots, rel).toContain(join(env.APPDATA!, ...rel.split("/")).toLowerCase());
    for (const rel of REF.windows.local) expect(roots, rel).toContain(join(env.LOCALAPPDATA!, ...rel.split("/")).toLowerCase());
    for (const rel of REF.windows.programData) expect(roots, rel).toContain(join(env.ProgramData!, ...rel.split("/")).toLowerCase());
  });

  it("un fichier de chacun de ces dossiers est refusé (chemin réel), un fichier ordinaire du dossier personnel ne l'est pas", () => {
    const home = realpathSync.native(tempDir());
    const g = gate(home, {});
    for (const rel of REF.homeDirs) {
      const dir = join(home, ...rel.split("/"));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "config");
      writeFileSync(file, "FAUX-SECRET-SENTINELLE");
      expect(g.forbiddenReason(realpathSync.native(file)), rel).toMatch(/protégé/);
    }
    mkdirSync(join(home, "Documents"), { recursive: true });
    writeFileSync(join(home, "Documents", "notes.txt"), "ordinaire");
    expect(g.forbiddenReason(realpathSync.native(join(home, "Documents", "notes.txt")))).toBeNull();
  });
});

describe("garde du shell — dossiers de lecture", () => {
  it("la liste des dossiers de clés est celle de la référence", () => {
    expect([...PROTECTED_HOME_DIRS].sort()).toEqual([...HOME_ENTRIES].sort());
  });

  it("un dossier de lecture qui est (ou contient) un de ces magasins est refusé en bloc", () => {
    const home = realpathSync.native(tempDir());
    for (const rel of REF.homeDirs) mkdirSync(join(home, ...rel.split("/")), { recursive: true });
    for (const rel of REF.homeDirs) {
      const entry = join(home, ...rel.split("/"));
      const g = new ShellGuardService({ workspace: tempDir(), policy: { writeScope: "workspace", readRoots: [entry] }, platform: "win32", home });
      const r = g.readRoots();
      expect(r.ok, rel).toBe(false);
    }
  });
});
