import { execSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { AdapterRefused, parseWingetShow, wingetCall } from "../src/index.js";

describe("D3 — winget : identifiants exacts, jamais une ligne construite par un modèle", () => {
  it("construit des commandes à source et correspondance exactes imposées", () => {
    expect(wingetCall({ op: "show", id: "Microsoft.PowerShell" }).args.command).toBe("winget show --id Microsoft.PowerShell --exact --source winget --accept-source-agreements --disable-interactivity");
    const install = wingetCall({ op: "install", id: "Git.Git", version: "2.47.0" });
    expect(install.mutating).toBe(true);
    expect(install.args.command).toContain("--exact --source winget --version 2.47.0 --silent");
    expect(wingetCall({ op: "search", query: "git" }).mutating).toBe(false);
    expect(wingetCall({ op: "list" }).mutating).toBe(false);
  });

  it("refuse tout identifiant, version ou requête qui ne soit pas strictement simple", () => {
    const bad = ["git", "Git.Git && del *", "Git.Git --override x", "Git.Git;x", "../x.y", "Git.Git\n", 'Git."Git"', "Git. Git", "", "a.b.c.d.e"];
    for (const id of bad) expect(() => wingetCall({ op: "install", id }), id).toThrow(AdapterRefused);
    expect(() => wingetCall({ op: "install", id: "Git.Git", version: "1.0 --custom x" })).toThrow(/version/);
    expect(() => wingetCall({ op: "upgrade", id: "Git.Git", version: "1.0" })).toThrow(/installation/);
    for (const query of ["", "git & calc", 'a"b', "x".repeat(61), "-x"]) expect(() => wingetCall({ op: "search", query }), query).toThrow(AdapterRefused);
    expect(() => wingetCall({ op: "show" })).toThrow(/identifiant/);
    expect(() => wingetCall({ op: "format" as never, id: "A.B" })).toThrow(AdapterRefused);
  });

  it("aucune option qui changerait ce qui est installé ou où n'est jamais produite", () => {
    for (const op of ["show", "install", "upgrade", "uninstall"] as const) {
      const c = String(wingetCall({ op, id: "Git.Git" }).args.command);
      expect(c).not.toMatch(/--custom|--override|--location|--force|--ignore-security-hash/);
    }
  });
});

// winget présent ET sa source utilisable : sur un runner de CI, le binaire existe mais la source peut ne pas être initialisée
// (0x8A15000F, « données de la source manquantes ») ; ce n'est pas un défaut de Jarod.
const hasWinget =
  spawnSync("winget", ["--version"], { encoding: "utf8", shell: true }).status === 0 &&
  spawnSync("winget", ["search", "--id", "Microsoft.PowerShell", "--exact", "--source", "winget", "--accept-source-agreements", "--disable-interactivity"], { encoding: "utf8", shell: true, timeout: 120_000 }).status === 0;

describe.skipIf(!hasWinget)("D3 contre winget réel (lecture seule : show, search, list — rien n'est installé)", () => {
  it("show Microsoft.PowerShell : la sortie réelle est lue, la licence et l'éditeur sont reconnus", () => {
    const out = execSync(String(wingetCall({ op: "show", id: "Microsoft.PowerShell" }).args.command), { encoding: "utf8", timeout: 120_000 });
    const pkg = parseWingetShow(out);
    expect(pkg).toMatchObject({ id: "Microsoft.PowerShell", publisher: "Microsoft Corporation", license: "MIT" });
    expect(pkg?.version).toMatch(/^\d+\.\d+/);
  }, 130_000);

  it("search et list s'exécutent sans erreur", () => {
    const s = execSync(String(wingetCall({ op: "search", query: "Git.Git" }).args.command), { encoding: "utf8", timeout: 120_000 });
    expect(s).toContain("Git.Git");
    execSync(String(wingetCall({ op: "list" }).args.command), { encoding: "utf8", timeout: 120_000 });
  }, 250_000);

  it("une sortie qui n'est pas celle d'un paquet donne null", () => {
    expect(parseWingetShow("Aucun package ne correspond")).toBeNull();
  });
});
