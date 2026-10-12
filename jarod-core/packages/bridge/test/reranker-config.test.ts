// `<profil>/reranker.json` (SPECS-P5-RERANKER.md §2.1) : lecteur pur, même forme que `readEmbeddingsConfig`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRerankerConfig } from "../src/main/kernel.js";

const dirs: string[] = [];
function file(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jarod-rr-cfg-"));
  dirs.push(dir);
  const path = join(dir, "reranker.json");
  writeFileSync(path, content);
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ABS = process.platform === "win32" ? "S:\\store\\projet\\jarod-cordis\\tools\\ov-bge-reranker-int8-b8x512" : "/opt/ov-bge-reranker-int8-b8x512";

describe("readRerankerConfig", () => {
  it("fichier absent : null (rien ne démarre, comportement d'avant)", () => {
    expect(readRerankerConfig(join(tmpdir(), "jarod-n-existe-pas", "reranker.json"))).toBeNull();
  });

  it("modelDir absolu et port entier : lus tels quels ; batch, maxLength et devices optionnels", () => {
    expect(readRerankerConfig(file(JSON.stringify({ modelDir: ABS, port: 8930 })))).toEqual({ modelDir: ABS, port: 8930 });
    expect(readRerankerConfig(file(JSON.stringify({ modelDir: ABS, port: 8930, batch: 8, maxLength: 512, devices: ["NPU", "CPU"] })))).toEqual({
      modelDir: ABS,
      port: 8930,
      batch: 8,
      maxLength: 512,
      devices: ["NPU", "CPU"],
    });
  });

  it("voicePriority (SPECS-P5-RERANKER-PAUSE.md) : booléen optionnel lu tel quel, autre type refusé", () => {
    expect(readRerankerConfig(file(JSON.stringify({ modelDir: ABS, port: 8930, voicePriority: false })))).toEqual({ modelDir: ABS, port: 8930, voicePriority: false });
    expect(readRerankerConfig(file(JSON.stringify({ modelDir: ABS, port: 8930, voicePriority: true })))).toEqual({ modelDir: ABS, port: 8930, voicePriority: true });
    expect(() => readRerankerConfig(file(JSON.stringify({ modelDir: ABS, port: 8930, voicePriority: "non" })))).toThrow(/voicePriority/);
  });

  it("refus nets, jamais de valeur devinée", () => {
    const bad = (v: unknown) => readRerankerConfig(file(JSON.stringify(v)));
    expect(() => bad({ modelDir: "relatif/modele", port: 8930 })).toThrow(/modelDir.*absolu/);
    expect(() => bad({ port: 8930 })).toThrow(/modelDir/);
    expect(() => bad({ modelDir: ABS })).toThrow(/port/);
    expect(() => bad({ modelDir: ABS, port: 0 })).toThrow(/port/);
    expect(() => bad({ modelDir: ABS, port: 70000 })).toThrow(/port/);
    expect(() => bad({ modelDir: ABS, port: 8930.5 })).toThrow(/port/);
    expect(() => bad({ modelDir: ABS, port: "8930" })).toThrow(/port/);
    expect(() => bad({ modelDir: ABS, port: 8930, batch: 0 })).toThrow(/batch/);
    expect(() => bad({ modelDir: ABS, port: 8930, batch: 2.5 })).toThrow(/batch/);
    expect(() => bad({ modelDir: ABS, port: 8930, maxLength: -1 })).toThrow(/maxLength/);
    expect(() => bad({ modelDir: ABS, port: 8930, devices: "NPU" })).toThrow(/devices/);
    expect(() => bad({ modelDir: ABS, port: 8930, devices: [] })).toThrow(/devices/);
    expect(() => bad({ modelDir: ABS, port: 8930, inconnu: true })).toThrow(/inconnu/);
    expect(() => bad([1, 2])).toThrow(/objet JSON/);
    expect(() => bad(null)).toThrow(/objet JSON/);
    expect(() => readRerankerConfig(file("pas du json"))).toThrow();
  });

  it("le message d'erreur nomme le fichier", () => {
    const p = file(JSON.stringify({ modelDir: "x", port: 1 }));
    expect(() => readRerankerConfig(p)).toThrow(p);
  });
});
