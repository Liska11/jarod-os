// SPECS-P5-CLI.md §4 (a) : l'aide est VRAIE. Chaque commande listée sans marque s'exécute (jamais « Commande inconnue »),
// chaque commande marquée « (pas encore disponible) » répond exactement cela (code 2), et `improve` n'est plus annoncé.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELP, main, PENDING_COMMANDS } from "../src/main.js";

const MARK = "(pas encore disponible)";
const listed = (): { name: string; marked: boolean }[] =>
  HELP.split("\n").flatMap((line) => {
    const m = /^ {2}jarod (\w+)/.exec(line);
    return m ? [{ name: m[1]!, marked: line.includes(MARK) }] : [];
  });

let out: string[] = [];
let err: string[] = [];
let root = "";
let saved: string | undefined;

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  root = mkdtempSync(join(tmpdir(), "jarod-help-"));
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  saved = process.env.JAROD_HOME;
  process.env.JAROD_HOME = root;
  // `ask` sans question lit l'entrée standard sauf en terminal : sous vitest elle ne se ferme jamais.
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(process.stdin, "isTTY");
  if (saved === undefined) delete process.env.JAROD_HOME;
  else process.env.JAROD_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("aide de la CLI", () => {
  it("n'annonce plus `improve` (retiré, décision Q1)", () => {
    expect(HELP).not.toMatch(/\bimprove\b/);
    expect(listed().map((c) => c.name)).not.toContain("improve");
  });

  it("marque exactement les commandes en attente", () => {
    const marked = listed().filter((c) => c.marked).map((c) => c.name).sort();
    expect(marked).toEqual([...PENDING_COMMANDS].sort());
    // Les commandes en attente sont bien annoncées (sinon la marque ne dirait rien à personne).
    for (const name of PENDING_COMMANDS) expect(listed().map((c) => c.name)).toContain(name);
  });

  it("répond « pas encore disponible » (code 2) à chaque commande marquée, sans ouvrir de profil", async () => {
    for (const name of PENDING_COMMANDS) {
      err = [];
      expect(await main([name]), name).toBe(2);
      expect(err.join("\n"), name).toContain("pas encore disponible");
      expect(err.join("\n"), name).not.toContain("Commande inconnue");
    }
  });

  it("exécute chaque commande listée sans marque (aucune ne répond « Commande inconnue »)", { timeout: 120_000 }, async () => {
    const real = listed().filter((c) => !c.marked).map((c) => c.name);
    expect(real).toEqual(expect.arrayContaining(["ask", "sessions", "show", "search", "memory", "profiles", "events", "serve", "mcp", "acp"]));
    for (const name of real) {
      if (name === "serve") continue; // démon : exécuté par serve.test.ts
      if (name === "mcp" || name === "acp") continue; // lisent l'entrée standard jusqu'à sa fermeture : exécutés par mcp-*.test.ts et acp-*.test.ts
      err = [];
      out = [];
      // `diagnostics` écrit un fichier : on lui donne une sortie dans le dossier temporaire, jamais dans le dossier courant.
      await main(name === "diagnostics" ? [name, "--out", join(root, "d.zip")] : [name]);
      expect(err.join("\n"), name).not.toContain("Commande inconnue");
    }
  });
});
