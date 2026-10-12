// Garde de commit contre les fichiers vidés par accident (incident du 2026-10-01 : tests/bench/voice-contention.ts committé vide).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readStaged, stagedProblems } from "./staged-files.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const CLI = join(ROOT, "scripts", "check-staged-files.ts");

describe("stagedProblems (règles)", () => {
  it("un fichier existant qui devient vide est refusé, avec sa taille d'avant", () => {
    const p = stagedProblems([{ path: "tests/bench/voice-contention.ts", newSize: 0, oldSize: 16095 }]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/voice-contention\.ts.*VIDÉ.*16095/);
  });

  it("un fichier vide NOUVEAU est refusé, sauf ceux qui sont vides par nature", () => {
    expect(stagedProblems([{ path: "src/a.ts", newSize: 0, oldSize: null }])).toHaveLength(1);
    for (const name of [".gitkeep", ".keep", "__init__.py", "py.typed"]) expect(stagedProblems([{ path: `d/${name}`, newSize: 0, oldSize: null }])).toEqual([]);
  });

  it("un fichier d'au moins 2 Kio qui perd 95 % ou plus est refusé ; une vraie réduction est permise", () => {
    expect(stagedProblems([{ path: "a.ts", newSize: 40, oldSize: 10_000 }])).toHaveLength(1);
    expect(stagedProblems([{ path: "a.ts", newSize: 500, oldSize: 10_000 }])).toHaveLength(1); // exactement 95 %
    expect(stagedProblems([{ path: "a.ts", newSize: 600, oldSize: 10_000 }])).toEqual([]); // 94 % : permis
    expect(stagedProblems([{ path: "a.ts", newSize: 3, oldSize: 1000 }])).toEqual([]); // petit fichier : permis
  });

  it("un fichier normal, nouveau ou modifié, passe", () => {
    expect(stagedProblems([{ path: "a.ts", newSize: 120, oldSize: null }, { path: "b.ts", newSize: 9000, oldSize: 8000 }])).toEqual([]);
  });
});

describe("garde sur un vrai index git", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  function repo(): string {
    const d = mkdtempSync(join(tmpdir(), "jarod-staged-"));
    dirs.push(d);
    git(d, "init", "-q");
    writeFileSync(join(d, "big.ts"), "export const x = 1;\n".repeat(400));
    writeFileSync(join(d, "small.ts"), "ok\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "init");
    return d;
  }

  it("readStaged voit un fichier vidé et le refuse ; une suppression et un fichier .gitkeep vide passent", () => {
    const d = repo();
    writeFileSync(join(d, "big.ts"), "");
    mkdirSync(join(d, "keep"));
    writeFileSync(join(d, "keep", ".gitkeep"), "");
    rmSync(join(d, "small.ts"));
    git(d, "add", "-A");
    const staged = readStaged(d);
    expect(staged.map((s) => s.path).sort()).toEqual(["big.ts", "keep/.gitkeep"]); // small.ts supprimé : ni ajouté ni modifié
    const bad = stagedProblems(staged);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/big\.ts/);
  });

  it("le script en ligne de commande sort en code 1 sur un fichier vidé, 0 sinon, et la dérogation JAROD_ALLOW_EMPTY=1 est dite", () => {
    const d = repo();
    const run = (env: Record<string, string> = {}) => spawnSync(TSX, [CLI], { cwd: d, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, ...env } });
    writeFileSync(join(d, "big.ts"), "export const x = 2;\n".repeat(400));
    git(d, "add", "-A");
    expect(run().status).toBe(0);
    writeFileSync(join(d, "big.ts"), "");
    git(d, "add", "-A");
    const refused = run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/big\.ts.*VIDÉ/);
    expect(refused.stderr).toMatch(/JAROD_ALLOW_EMPTY=1/);
    const allowed = run({ JAROD_ALLOW_EMPTY: "1" });
    expect(allowed.status).toBe(0);
    expect(allowed.stderr + allowed.stdout).toMatch(/dérogation/i);
  });

  it("un index vide ne pose aucun problème", () => {
    const d = repo();
    expect(readStaged(d)).toEqual([]);
  });
});
