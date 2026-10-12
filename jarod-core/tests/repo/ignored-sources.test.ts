import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ignoredSources, isAllowedIgnored } from "./ignored-sources.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function fixture(gitignore: string, files: string[], ignorecase: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "jarod-ignored-"));
  temps.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "core.ignorecase", String(ignorecase)], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), gitignore);
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
  return dir;
}

describe("B16 — aucun fichier source ignoré sous packages/", () => {
  it("le dépôt réel : rien d'ignoré sous packages/ hors produits (node_modules, dist, out, coverage, *.log)", () => {
    expect(ignoredSources(repoRoot)).toEqual([]);
  });

  it("détecte la régression d'origine : `tools/` masque packages/plugins/tools et, casse ignorée, screens/Tools", () => {
    const files = ["tools/model.bin", "packages/plugins/tools/src/registry.ts", "packages/desktop/src/screens/Tools/Tools.tsx", "packages/x/node_modules/y/i.js"];
    const dir = fixture("tools/\nnode_modules/\n", files, true);
    expect(ignoredSources(dir)).toEqual(["packages/desktop/src/screens/Tools/", "packages/plugins/tools/"]);
  });

  it("la correction `/tools/` : le dossier utilisateur reste ignoré, packages/ n'a plus rien", () => {
    const files = ["tools/model.bin", "packages/plugins/tools/src/registry.ts", "packages/desktop/src/screens/Tools/Tools.tsx"];
    const dir = fixture("/tools/\n", files, true);
    expect(ignoredSources(dir)).toEqual([]);
    expect(execFileSync("git", ["check-ignore", "tools/model.bin"], { cwd: dir, encoding: "utf8" }).trim()).toBe("tools/model.bin");
  });

  it("produits admis, sources refusées", () => {
    expect(isAllowedIgnored("packages/desktop/out/")).toBe(true);
    expect(isAllowedIgnored("packages/a/node_modules/")).toBe(true);
    expect(isAllowedIgnored("packages/a/debug.log")).toBe(true);
    expect(isAllowedIgnored("packages/a/src/x.key")).toBe(false);
    expect(isAllowedIgnored("packages/a/logs.log/")).toBe(false);
  });
});
