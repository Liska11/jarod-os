// Vision locale : trouver le modèle multimodal (gguf + mmproj) dans le dossier des modèles, ne rien lancer sans moteur ni modèle.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@jarod/kernel/testing";
import { findVisionModel, LocalVisionServer } from "../src/local-vision.js";

function model(root: string, dir: string, files: Record<string, number>) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  for (const [name, size] of Object.entries(files)) writeFileSync(join(d, name), Buffer.alloc(size));
}

describe("vision locale", () => {
  it("trouve le dossier qui a un modèle ET son mmproj, les modèles de vision d'abord, le plus petit d'abord", () => {
    const root = tempDir();
    model(root, "LiquidAI/LFM3-1.7B-GGUF", { "LFM3-1.7B-Q8_0.gguf": 50 }); // pas de mmproj : ignoré
    model(root, "gros/Qwen3.8-27B-GGUF", { "Qwen3.8-27B-Q4.gguf": 900, "mmproj-Qwen3.8-27B-BF16.gguf": 10 });
    model(root, "Qwen/Qwen3-VL-4B-Instruct-GGUF", { "Qwen3VL-4B-Instruct-Q4_K_M.gguf": 300, "mmproj-Qwen3VL-4B-Instruct-F16.gguf": 20 });
    const found = findVisionModel(root);
    expect(found?.model).toContain("Qwen3VL-4B-Instruct-Q4_K_M.gguf");
    expect(found?.mmproj).toContain("mmproj-Qwen3VL-4B-Instruct-F16.gguf");
    expect(findVisionModel(join(root, "LiquidAI"))).toBeNull();
    expect(findVisionModel(join(root, "n'existe-pas"))).toBeNull();
  });

  it("sans moteur llama.cpp ou sans modèle : indisponible, et rien n'est lancé", async () => {
    const settings = { get: () => ({ installed: null, modelsDir: "" }) } as never;
    const local = new LocalVisionServer({ settings });
    expect(local.available()).toBe(false);
    await expect(local.ensure()).rejects.toThrow(/vision locale indisponible.*llama\.cpp/);
  });
});
