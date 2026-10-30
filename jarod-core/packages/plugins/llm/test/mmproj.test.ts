// Modèles multimodaux (LFM3-Omni, Qwen3-VL…) : le projecteur `mmproj*.gguf` posé à côté du modèle part avec lui (`--mmproj`).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@jarod/kernel/testing";
import { describe, expect, it } from "vitest";
import { newPreset, presetArgs, siblingMmproj } from "../src/engine.js";

function dir(files: string[]) {
  const d = join(tempDir(), "modele");
  mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(join(d, f), "x");
  return d;
}

describe("projecteur multimodal", () => {
  it("un seul mmproj à côté du modèle : il est pris ; aucun ou plusieurs : on ne devine pas", () => {
    const one = dir(["LFM3-Omni-2B-Q8_0.gguf", "mmproj-LFM3-Omni-2B-F16.gguf"]);
    expect(siblingMmproj(join(one, "LFM3-Omni-2B-Q8_0.gguf"))).toBe(join(one, "mmproj-LFM3-Omni-2B-F16.gguf"));
    const none = dir(["a.gguf"]);
    expect(siblingMmproj(join(none, "a.gguf"))).toBe("");
    const many = dir(["a.gguf", "mmproj-a-F16.gguf", "mmproj-a-Q8_0.gguf"]);
    expect(siblingMmproj(join(many, "a.gguf"))).toBe("");
    expect(siblingMmproj("")).toBe("");
    expect(siblingMmproj(join(one, "absent", "x.gguf"))).toBe("");
  });

  it("presetArgs : --mmproj du voisin, de la valeur gardée, ou rien si elle est vidée", () => {
    const d = dir(["m.gguf", "mmproj-m.gguf"]);
    const model = join(d, "m.gguf");
    const at = (args: string[]) => args[args.indexOf("--mmproj") + 1];
    expect(at(presetArgs(newPreset({ model })))).toBe(join(d, "mmproj-m.gguf"));
    expect(at(presetArgs(newPreset({ model, mmproj: "C:\\ailleurs\\p.gguf" })))).toBe("C:\\ailleurs\\p.gguf");
    expect(presetArgs(newPreset({ model, mmproj: "" }))).not.toContain("--mmproj");
    expect(presetArgs(newPreset({ model: join(dir(["x.gguf"]), "x.gguf") }))).not.toContain("--mmproj");
  });
});
