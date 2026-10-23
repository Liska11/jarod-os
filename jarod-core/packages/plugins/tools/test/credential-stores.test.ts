// 2026-10-22 — les outils système refusent les mêmes magasins d'identifiants que le garde fichiers, le garde du shell et le pont Python
// (contracts/v1/credential-stores.reference.json). Arborescence FACTICE : un faux dossier personnel dans un dossier temporaire, rien de réel.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { protectedRoots } from "../src/system/disk.js";
import { forbiddenReason } from "../src/system/files.js";

function referenceFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++, dir = dirname(dir)) {
    const f = join(dir, "contracts", "v1", "credential-stores.reference.json");
    if (existsSync(f)) return f;
  }
  throw new Error("contracts/v1/credential-stores.reference.json introuvable");
}
const REF = JSON.parse(readFileSync(referenceFile(), "utf8")) as { homeDirs: string[]; homeFiles: string[]; windows: { roaming: string[]; local: string[]; programData: string[] } };

const home = realpathSync.native(mkdtempSync(join(tmpdir(), "jarod-creds-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const env = { APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), PROGRAMDATA: join(home, "ProgramData"), SystemRoot: join(home, "Windows") } as NodeJS.ProcessEnv;

describe("outils système — magasins d'identifiants", () => {
  it("chaque entrée de la référence est une racine protégée", () => {
    const roots = protectedRoots(env, home).map((r) => r.toLowerCase());
    for (const rel of [...REF.homeDirs, ...REF.homeFiles]) expect(roots, rel).toContain(join(home, ...rel.split("/")).toLowerCase());
    for (const rel of REF.windows.roaming) expect(roots, rel).toContain(join(env.APPDATA!, ...rel.split("/")).toLowerCase());
    for (const rel of REF.windows.local) expect(roots, rel).toContain(join(env.LOCALAPPDATA!, ...rel.split("/")).toLowerCase());
    for (const rel of REF.windows.programData) expect(roots, rel).toContain(join(env.PROGRAMDATA!, ...rel.split("/")).toLowerCase());
  });

  it("un fichier réel de l'arborescence factice est refusé dans chacun de ces dossiers, et un fichier voisin ne l'est pas", async () => {
    const roots = protectedRoots(env, home);
    for (const rel of REF.homeDirs) {
      const dir = join(home, ...rel.split("/"));
      mkdirSync(dir, { recursive: true });
      const secret = join(dir, "config");
      writeFileSync(secret, "FAUX-SECRET-SENTINELLE");
      expect(await forbiddenReason(secret, roots, true), rel).toMatch(/emplacement protégé/);
    }
    for (const rel of REF.homeFiles) {
      const file = join(home, ...rel.split("/"));
      writeFileSync(file, "FAUX-SECRET-SENTINELLE");
      expect(await forbiddenReason(file, roots, true), rel).toMatch(/emplacement protégé/);
    }
    const neighbour = join(home, "Documents", "notes.txt");
    mkdirSync(dirname(neighbour), { recursive: true });
    writeFileSync(neighbour, "ordinaire");
    expect(await forbiddenReason(neighbour, roots, true)).toBeNull();
  });
});
