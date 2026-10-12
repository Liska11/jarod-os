// Q2 (BESOINS, tranché) : découverte récursive des skills rangées par catégorie + cache manifeste.
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { SKILL_ARCHIVE_DIR, SKILL_MANIFEST_FILE, SkillRegistry } from "../src/skills.js";

afterEach(cleanup);

const md = (name: string, body = `corps de ${name}`) => `---\nname: ${name}\ndescription: d ${name}\nversion: 1.0.0\n---\n${body}`;

/** Écrit `<root>/<rel>/SKILL.md` (ou `<root>/<rel>` si `rel` finit par un nom de fichier). */
function put(root: string, rel: string, text: string): string {
  const file = /\.\w+$/.test(rel) ? join(root, ...rel.split("/")) : join(root, ...rel.split("/"), "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** Recule le mtime d'une heure : fichier « posé » (hors fenêtre racy), donc mis en cache. */
function settle(file: string): void {
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(file, past, past);
}

/** Kernel dont le dossier de skills est pré-rempli (pas de graines : le dossier existe déjà). */
async function boot(tree: Record<string, string>) {
  const dataDir = tempDir();
  const root = join(dataDir, "skills");
  mkdirSync(root, { recursive: true });
  for (const [rel, text] of Object.entries(tree)) put(root, rel, text);
  const app = await bootApp({ storage: { dataDir, encryptDb: false }, skills: {} });
  const fresh = () => new SkillRegistry(root, app.storage.settings, app.storage.notifications);
  return { app, root, skills: app.skills, notifications: app.storage.notifications, fresh };
}

describe("Q2 — découverte récursive", () => {
  it("lit les skills à plat, par catégorie et sous-catégorie ; ignore les dossiers « . » et l'intérieur d'une skill", async () => {
    const { skills } = await boot({
      plate: md("Plate"),
      "creative/ascii-art": md("ASCII"),
      "mlops/inference/llama-cpp": md("llama.cpp"),
      "vide/rien/README.md": "pas une skill",
      ".archive/vieille": md("Vieille"),
      ".hub/staging/x": md("Staging"),
      "plate/templates/inclus": md("Inclus"),
    });
    expect(skills.list().map((s) => s.id).sort()).toEqual(["ascii-art", "llama-cpp", "plate"]);
    expect(skills.get("llama-cpp")).toMatchObject({ name: "llama.cpp", body: "corps de llama.cpp" });
    expect(skills.collisions()).toEqual([]);
    expect(skills.promptSection()).toContain("- ascii-art : ASCII — d ASCII");
  });

  it("folder, files, readFile, update, patchBody et archive servent une skill rangée", async () => {
    const { skills, root } = await boot({
      "creative/ascii-art": md("ASCII", "étape un"),
      "creative/ascii-art/scripts/run.py": "print(1)",
    });
    const folder = join(root, "creative", "ascii-art");
    expect(skills.folder("ascii-art")).toBe(folder);
    expect(await skills.files("ascii-art")).toEqual(["scripts/run.py"]);
    expect(await skills.readFile("ascii-art", "scripts/run.py")).toBe("print(1)");

    const updated = await skills.update("ascii-art", { description: "neuve" });
    expect(updated).toMatchObject({ description: "neuve", version: "1.0.1", path: join(folder, "SKILL.md") });
    await skills.patchBody("ascii-art", "un", "deux");
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toContain("étape deux");
    expect(existsSync(join(root, "ascii-art"))).toBe(false);

    const target = await skills.archive("ascii-art");
    expect(dirname(target)).toBe(join(root, SKILL_ARCHIVE_DIR));
    expect(existsSync(join(target, "scripts", "run.py"))).toBe(true);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(join(root, "creative"))).toBe(true);
    expect(skills.get("ascii-art")).toBeUndefined();
  });

  it("create réécrit une skill rangée sur place, refuse le doublon côté agent et un id de catégorie", async () => {
    const { skills, root } = await boot({ "creative/ascii-art": md("ASCII") });
    await expect(skills.create("ascii-art", "x", "y", "z", { author: "agent", overwrite: false })).rejects.toThrow(/existe déjà/);
    const rewritten = await skills.create("ascii-art", "ASCII 2", "d2", "nouveau corps");
    expect(rewritten.path).toBe(join(root, "creative", "ascii-art", "SKILL.md"));
    expect(existsSync(join(root, "ascii-art"))).toBe(false);
    await expect(skills.create("creative", "Catégorie", "d", "corps")).rejects.toThrow(/dossier de catégorie/);
    expect(existsSync(join(root, "creative", "SKILL.md"))).toBe(false);
    expect(skills.get("ascii-art")!.body).toBe("nouveau corps");
  });
});

describe("Q2 — collisions d'identifiants", () => {
  it("la moins profonde gagne, puis le premier chemin ; signalée une fois par jeu de collisions", async () => {
    const { skills, notifications, root } = await boot({
      "z-cat/dup": md("Z"),
      dup: md("Plate"),
      "a-cat/dup": md("A"),
      "b-cat/pair": md("B"),
      "a-cat/pair": md("A pair"),
    });
    expect(skills.get("dup")!.name).toBe("Plate");
    expect(skills.get("pair")!.name).toBe("A pair");
    expect(skills.collisions()).toEqual([
      { id: "dup", kept: "dup", ignored: ["a-cat/dup", "z-cat/dup"] },
      { id: "pair", kept: "a-cat/pair", ignored: ["b-cat/pair"] },
    ]);
    const warnings = () => notifications.list().filter((n) => n.kind === "warning");
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({ title: "Skills en double : 2 identifiant(s)" });
    expect(warnings()[0]!.body).toContain("dup : dup chargée, ignorée(s) : a-cat/dup, z-cat/dup");

    await skills.reload();
    expect(warnings()).toHaveLength(1);

    // La gagnante archivée : la suivante dans l'ordre prend l'id, la collision restante est re-signalée.
    await skills.archive("dup");
    expect(skills.get("dup")).toMatchObject({ name: "A", path: join(root, "a-cat", "dup", "SKILL.md") });
    expect(skills.collisions()[0]).toEqual({ id: "dup", kept: "a-cat/dup", ignored: ["z-cat/dup"] });
    expect(warnings()).toHaveLength(2);
  });
});

describe("Q2 — cache manifeste", () => {
  it("met en cache les SKILL.md posés, jamais les récents ; relit un fichier modifié ; purge les disparus", async () => {
    const { root, fresh } = await boot({});
    const posee = put(root, "cat/posee", md("Posée"));
    const recente = put(root, "recente", md("Récente"));
    settle(posee);
    const a = fresh();
    await a.reload();
    const manifestPath = join(root, SKILL_MANIFEST_FILE);
    const manifest = () => JSON.parse(readFileSync(manifestPath, "utf8")) as { v: number; skills: Record<string, { body: string }> };
    expect(manifest().v).toBe(1);
    expect(Object.keys(manifest().skills)).toEqual(["cat/posee"]);
    expect(a.get("recente")!.name).toBe("Récente");
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // Une entrée valide (taille + mtime identiques) est servie SANS relire le fichier.
    const m = manifest();
    m.skills["cat/posee"]!.body = "depuis le cache";
    writeFileSync(manifestPath, JSON.stringify(m));
    const b = fresh();
    await b.reload();
    expect(b.get("posee")!.body).toBe("depuis le cache");

    // Fichier modifié (taille ou mtime) : relu.
    writeFileSync(posee, md("Posée", "corps modifié"));
    settle(recente);
    await b.reload();
    expect(b.get("posee")!.body).toBe("corps modifié");
    expect(Object.keys(manifest().skills).sort()).toEqual(["recente"]);

    settle(posee);
    await b.reload();
    expect(Object.keys(manifest().skills).sort()).toEqual(["cat/posee", "recente"]);
    await b.archive("recente");
    expect(Object.keys(manifest().skills)).toEqual(["cat/posee"]);
  });

  it("un manifeste illisible ou d'une autre version est ignoré puis réécrit", async () => {
    const { root, fresh } = await boot({});
    settle(put(root, "cat/x", md("X")));
    const manifestPath = join(root, SKILL_MANIFEST_FILE);
    for (const bad of ["{ pas du json", JSON.stringify({ v: 99, skills: { "cat/x": { body: "faux" } } })]) {
      writeFileSync(manifestPath, bad);
      const r = fresh();
      await r.reload();
      expect(r.get("x")!.body).toBe("corps de X");
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({ v: 1, skills: { "cat/x": { body: "corps de X" } } });
    }
  });
});
