// `<profil>/embeddings.json` (SPECS-P5-EMBEDDINGS.md §3.1) : lecteur pur, même forme que `readRagConfig`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEmbeddingsConfig } from "../src/main/kernel.js";

const dirs: string[] = [];
function file(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jarod-emb-cfg-"));
  dirs.push(dir);
  const path = join(dir, "embeddings.json");
  writeFileSync(path, content);
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ABS = process.platform === "win32" ? "S:\\store\\projet\\jarod-cordis\\tools\\ov-bge-m3-int8" : "/opt/ov-bge-m3-int8";

describe("readEmbeddingsConfig", () => {
  it("fichier absent : null (rien ne démarre, comportement d'avant)", () => {
    expect(readEmbeddingsConfig(join(tmpdir(), "jarod-n-existe-pas", "embeddings.json"))).toBeNull();
  });

  it("modelDir absolu et port entier : lus tels quels ; devices optionnels", () => {
    expect(readEmbeddingsConfig(file(JSON.stringify({ modelDir: ABS, port: 8920 })))).toEqual({ modelDir: ABS, port: 8920 });
    expect(readEmbeddingsConfig(file(JSON.stringify({ modelDir: ABS, port: 8920, devices: ["NPU", "CPU"] })))).toEqual({ modelDir: ABS, port: 8920, devices: ["NPU", "CPU"] });
  });

  it("refus nets, jamais de valeur devinée", () => {
    const bad = (v: unknown) => readEmbeddingsConfig(file(JSON.stringify(v)));
    expect(() => bad({ modelDir: "relatif/modele", port: 8920 })).toThrow(/modelDir.*absolu/);
    expect(() => bad({ port: 8920 })).toThrow(/modelDir/);
    expect(() => bad({ modelDir: ABS })).toThrow(/port/);
    expect(() => bad({ modelDir: ABS, port: 0 })).toThrow(/port/);
    expect(() => bad({ modelDir: ABS, port: 70000 })).toThrow(/port/);
    expect(() => bad({ modelDir: ABS, port: 8920.5 })).toThrow(/port/);
    expect(() => bad({ modelDir: ABS, port: "8920" })).toThrow(/port/);
    expect(() => bad({ modelDir: ABS, port: 8920, devices: "NPU" })).toThrow(/devices/);
    expect(() => bad({ modelDir: ABS, port: 8920, devices: [] })).toThrow(/devices/);
    expect(() => bad([1, 2])).toThrow(/objet JSON/);
    expect(() => bad(null)).toThrow(/objet JSON/);
    expect(() => readEmbeddingsConfig(file("pas du json"))).toThrow();
  });

  it("le message d'erreur nomme le fichier", () => {
    const p = file(JSON.stringify({ modelDir: "x", port: 1 }));
    expect(() => readEmbeddingsConfig(p)).toThrow(p);
  });
});
