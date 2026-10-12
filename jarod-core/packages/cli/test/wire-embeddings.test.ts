import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkEmbeddingsModel, DEFAULT_EMBEDDINGS_PORT, embeddingsConfigFor, writeEmbeddingsFile } from "../src/wire-embeddings.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-wire-emb-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("câblage des embeddings isolés (embeddings.json)", () => {
  it("par défaut : le modèle du dépôt (tools/ov-bge-m3-int8, chemin absolu) et le port 8920", () => {
    const c = embeddingsConfigFor();
    expect(DEFAULT_EMBEDDINGS_PORT).toBe(8920);
    expect(c.port).toBe(8920);
    expect(isAbsolute(c.modelDir)).toBe(true);
    expect(c.modelDir.split(String.fromCharCode(92)).join("/").endsWith("/tools/ov-bge-m3-int8")).toBe(true);
  });

  it("port et dossier explicites ; port hors bornes ou non entier refusé ; dossier relatif refusé", () => {
    expect(embeddingsConfigFor({ port: 9001, modelDir: tmpdir() })).toEqual({ modelDir: tmpdir(), port: 9001 });
    for (const port of [0, 70000, 8920.5, Number.NaN]) expect(() => embeddingsConfigFor({ port })).toThrow(/port/);
    expect(() => embeddingsConfigFor({ modelDir: "relatif/modele" })).toThrow(/absolu/);
  });

  it("le modèle doit exister et contenir openvino_model.xml", () => {
    const d = tmp();
    expect(checkEmbeddingsModel(join(d, "absent"))).toMatch(/introuvable/);
    expect(checkEmbeddingsModel(d)).toMatch(/openvino_model\.xml/);
    writeFileSync(join(d, "openvino_model.xml"), "<net/>");
    expect(checkEmbeddingsModel(d)).toBeNull();
  });

  it("simulation : rien n'est écrit ; --apply : fichier posé, relu, au format que lit le desktop", () => {
    const profile = tmp();
    const cfg = { modelDir: tmp(), port: 8920 };
    const dry = writeEmbeddingsFile(profile, cfg, false);
    expect(dry).toEqual({ written: false, path: join(profile, "embeddings.json"), backup: null });
    expect(existsSync(join(profile, "embeddings.json"))).toBe(false);
    const real = writeEmbeddingsFile(profile, cfg, true);
    expect(real.written).toBe(true);
    expect(JSON.parse(readFileSync(real.path, "utf8"))).toEqual(cfg);
  });

  it("un fichier existant est sauvegardé en .bak avant d'être remplacé (jamais écrasé sans trace)", () => {
    const profile = tmp();
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "embeddings.json"), JSON.stringify({ modelDir: "S:\\ancien", port: 1234 }));
    const r = writeEmbeddingsFile(profile, { modelDir: tmp(), port: 8920 }, true);
    expect(r.backup).toBe(join(profile, "embeddings.json.bak"));
    expect(JSON.parse(readFileSync(r.backup!, "utf8"))).toEqual({ modelDir: "S:\\ancien", port: 1234 });
    expect(JSON.parse(readFileSync(r.path, "utf8")).port).toBe(8920);
  });
});
