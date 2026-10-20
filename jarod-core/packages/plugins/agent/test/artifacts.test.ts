// Cockpit, lot 5 — scénario 6 de la mission : générer un diagramme ; la source et le rendu sont visibles dans les artefacts.
// Vraie base (migration), vrai dossier de travail, export SVG réel, preuve de l'export.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, artifactTools, extractSvg, inWorkspace } from "../src/artifacts.js";
import { makeCore, tempDir } from "./helpers.js";

const HTML = `<!doctype html><html><body><div class="card"><h1>Architecture</h1>
<svg viewBox="0 0 100 50" role="img"><title>App</title><g><svg x="1"><rect width="5" height="5"/></svg></g><text x="10" y="20">API</text></svg>
<p>légende</p></div></body></html>`;

describe("export SVG", () => {
  it("extrait le premier <svg> complet (imbriqués compris), avec son espace de noms ; sans svg, une erreur", () => {
    const svg = extractSvg(HTML);
    expect(svg).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 50"/);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain('<svg x="1"><rect width="5" height="5"/></svg>');
    expect(svg).not.toContain("légende");
    expect(() => extractSvg("<p>rien</p>")).toThrow(/Aucun/);
  });

  it("un chemin hors du dossier de travail est refusé", () => {
    expect(() => inWorkspace("C:\\ws", "..\\autre\\a.html")).toThrow(/hors du dossier/);
    expect(() => inWorkspace(null, "a.html")).toThrow(/dossier de travail/);
  });
});

describe("artefacts", () => {
  it("diagramme : la source .html et l'export .svg sont enregistrés, reliés, vérifiés ; une modification se voit", async () => {
    const core = await makeCore();
    const ws = tempDir();
    mkdirSync(join(ws, "docs"));
    writeFileSync(join(ws, "docs", "archi.html"), HTML);
    const store = new ArtifactStore(core.db);
    const [register, list, exporter] = artifactTools(store);
    const ctx = { sessionId: "s", workspace: ws };
    expect(await register!.run({ path: "docs/archi.html", kind: "diagram", title: "Architecture (source)" }, ctx)).toMatch(/Artefact enregistré/);
    const out = await exporter!.run({ path: "docs/archi.html" }, ctx);
    expect(JSON.parse(out)).toMatchObject({ svg: join("docs", "archi.svg"), source: join("docs", "archi.html") });
    expect((await exporter!.verify!({}, out, ctx)).status).toBe("verified");
    const all = store.list();
    expect(all.map((a) => [a.kind, a.mime])).toEqual([
      ["diagram", "image/svg+xml"],
      ["diagram", "text/html"],
    ]);
    expect(all[0]!.sourcePath).toBe(join(ws, "docs", "archi.html"));
    expect(readFileSync(join(ws, "docs", "archi.svg"), "utf8")).toMatch(/<title>App<\/title>/);
    expect(await list!.run({}, ctx)).toMatch(/intact/);
    writeFileSync(join(ws, "docs", "archi.svg"), "<svg/>");
    expect(store.check(all[0]!.id)).toBe("modified");
    expect((await exporter!.verify!({}, out, ctx)).status).toBe("failed");
    // Le même fichier au même contenu n'est pas enregistré deux fois.
    await register!.run({ path: "docs/archi.html", kind: "diagram", title: "encore" }, ctx);
    expect(store.list()).toHaveLength(2);
    expect(store.forget(all[0]!.id)).toBe(true);
    await core.dispose();
  });
});
