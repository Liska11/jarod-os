/**
 * Le cycle d'un bac : création, exécution confinée ou refus, collecte, destruction. Les tests de refus et
 * de destruction emploient de vrais dossiers ; le test de bout en bout emploie le vrai AppContainer quand le
 * binaire `herald-sandbox` est construit (sinon il est sauté, et le dit).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxError, type SandboxEvent, SandboxService } from "../src/index.js";

const made: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-sbx-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const probeAbsent = (input: { id: string }) => ({ ok: false, path: null, detail: `absent (simulé, ${input.id})` });
const binary = join(__dirname, "..", "..", "..", "..", "..", "host-rust", "target", "debug", "herald-sandbox.exe");

describe("plugin-sandbox", () => {
  it("crée un dossier propre au bac, sous la racine gérée, avec un profil connu", () => {
    const root = temp();
    const svc = new SandboxService({ root });
    const box = svc.create("short");

    expect(box.dir.startsWith(root.replace(/\\/g, "/")) || box.dir.toLowerCase().includes("jarod-sbx-")).toBe(true);
    expect(existsSync(box.dir)).toBe(true);
    expect(box.profile).toBe("short");
    expect(() => svc.create("inconnu")).toThrow(SandboxError);
    expect(svc.create().id).not.toBe(box.id);
  });

  it("sans mécanisme vérifié, rien n'est lancé : refus, avec la raison, et le fichier n'existe pas", async () => {
    const events: SandboxEvent[] = [];
    const svc = new SandboxService({
      root: temp(),
      guard: { platform: "linux", probe: probeAbsent as never },
      onEvent: (e) => events.push(e),
      runner: async () => {
        throw new Error("le runner ne doit pas être appelé");
      },
    });
    const box = svc.create();
    const result = await svc.exec(box.id, "echo valeur-sensible > x.txt");

    expect(result.kind).toBe("refused");
    expect(existsSync(join(box.dir, "x.txt"))).toBe(false);
    // L'audit garde l'empreinte de la ligne, jamais son texte.
    const refused = events.find((e) => e.action === "refused")!;
    expect(JSON.stringify(refused)).not.toContain("valeur-sensible");
    expect(refused.detail.line).toMatch(/^[0-9a-f]{12}$/);
  });

  it("collecte : fichiers, empreintes, ajouts / modifications / suppressions depuis la dernière collecte", () => {
    const svc = new SandboxService({ root: temp() });
    const box = svc.create();

    writeFileSync(join(box.dir, "a.txt"), "un");
    mkdirSync(join(box.dir, "sub"));
    writeFileSync(join(box.dir, "sub", "b.txt"), "deux");
    const first = svc.collect(box.id);
    expect(first.added.sort()).toEqual(["a.txt", "sub/b.txt"]);
    expect(first.files.find((f) => f.path === "a.txt")).toMatchObject({ size: 2 });
    expect(first.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    writeFileSync(join(box.dir, "a.txt"), "UN!");
    rmSync(join(box.dir, "sub", "b.txt"));
    const second = svc.collect(box.id);
    expect(second.modified).toEqual(["a.txt"]);
    expect(second.removed).toEqual(["sub/b.txt"]);
    expect(second.added).toEqual([]);
  });

  it("la destruction retire le bac, et un bac détruit n'est plus utilisable", () => {
    const svc = new SandboxService({ root: temp() });
    const box = svc.create();
    writeFileSync(join(box.dir, "a.txt"), "x");
    svc.destroy(box.id);

    expect(existsSync(box.dir)).toBe(false);
    expect(() => svc.collect(box.id)).toThrow(/détruit/);
    expect(() => svc.destroy("pas-un-id")).toThrow(/inconnu/);
  });

  it("la destruction refuse un bac remplacé par un lien, et ne touche pas à la cible", () => {
    const root = temp();
    const cible = temp();
    writeFileSync(join(cible, "precieux.txt"), "precieux");
    const svc = new SandboxService({ root });
    const box = svc.create();

    rmSync(box.dir, { recursive: true });
    try {
      symlinkSync(cible, box.dir, "junction");
    } catch {
      return; // Plateforme sans droit de créer le lien : rien à prouver ici.
    }

    expect(() => svc.destroy(box.id)).toThrow(/refusée/);
    expect(readFileSync(join(cible, "precieux.txt"), "utf8")).toBe("precieux");
  });

  const reel = process.platform === "win32" && existsSync(binary) ? it : it.skip;

  reel("pour de vrai : écrit dedans, collecte, et ne sort pas du bac", async () => {
    const dehors = temp();
    const svc = new SandboxService({ root: temp(), guard: { env: { ...process.env, HERALD_SANDBOX_BIN: binary } } });
    const box = svc.create();
    const cible = join(dehors, "interdit.txt");

    const ok = await svc.exec(box.id, "echo bonjour> dedans.txt");
    expect(ok).toMatchObject({ kind: "ran", code: 0, mechanism: "herald-sandbox" });

    const piege = await svc.exec(box.id, `echo piege> "${cible}"`);
    expect(piege.kind === "ran" && piege.code !== 0).toBe(true);
    expect(existsSync(cible)).toBe(false);

    expect(svc.collect(box.id).added).toEqual(["dedans.txt"]);
    svc.destroy(box.id);
    expect(existsSync(box.dir)).toBe(false);
  });
});
