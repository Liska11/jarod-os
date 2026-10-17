// B1 contre transformers.js 4.3.1 (moteur réel, installé dans engines/transformers) avec all-MiniLM-L6-v2 épinglé par révision et SHA-256.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cosine, Embeddings, type EmbeddingBackend, MemoryIndex, type ModelPin } from "../../src/index.js";
import { ROOT } from "./helpers.js";

const REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const PIN: ModelPin = { id: `Xenova/all-MiniLM-L6-v2@${REVISION.slice(0, 7)}`, sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1", sizeBytes: 22972370, dimensions: 384 };
const INSTALLED = join(ROOT, "engines", "models", "minilm");
const TF = join(ROOT, "engines", "transformers", "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs");
const ready = existsSync(join(INSTALLED, "onnx", "model_quantized.onnx")) && existsSync(TF);
const SIDE_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"];
const work = mkdtempSync(join(tmpdir(), "jarod-tf-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Colle transformers.js à `EmbeddingBackend` : les octets VÉRIFIÉS sont écrits dans un cache privé, puis chargés hors ligne. */
function backend(): EmbeddingBackend & { loadCount: number } {
  let extractor: ((t: string[], o: object) => Promise<{ tolist(): number[][] }>) | null = null;
  const b = {
    loadCount: 0,
    async load(weights: Uint8Array, _pin: ModelPin) {
      b.loadCount++;
      const cache = join(work, `cache-${b.loadCount}`);
      const model = join(cache, "minilm");
      mkdirSync(join(model, "onnx"), { recursive: true });
      for (const f of SIDE_FILES) copyFileSync(join(INSTALLED, f), join(model, f));
      writeFileSync(join(model, "onnx", "model_quantized.onnx"), weights);
      const tf = (await import(pathToFileURL(TF).href)) as { env: Record<string, unknown>; pipeline: (task: string, model: string, o: object) => Promise<typeof extractor> };
      tf.env.allowRemoteModels = false;
      tf.env.localModelPath = cache;
      extractor = await tf.pipeline("feature-extraction", "minilm", { dtype: "q8" });
    },
    async embed(texts: string[]) {
      const out = await extractor!(texts, { pooling: "mean", normalize: true });
      return out.tolist();
    },
  };
  return b;
}

describe.skipIf(!ready)("B1 contre transformers.js (moteur réel)", () => {
  const installed = async (_p: ModelPin, mode: "installed" | "download") => (mode === "installed" ? new Uint8Array(readFileSync(join(INSTALLED, "onnx", "model_quantized.onnx"))) : null);

  it("les poids installés correspondent à l'épingle, se chargent hors ligne, et donnent des vecteurs sémantiques de dimension 384", async () => {
    const e = new Embeddings(PIN, { backend: backend(), fetchWeights: installed });
    expect(await e.ensureLoaded()).toBe("installed");
    const [chat, chaton, finance] = await e.embed(["The cat sleeps on the sofa.", "A kitten is napping on the couch.", "Quarterly revenue grew by twelve percent."]);
    expect(chat).toHaveLength(384);
    expect(cosine(chat!, chaton!)).toBeGreaterThan(cosine(chat!, finance!) + 0.2);

    // et l'index vectoriel de repli range les phrases dans le bon ordre
    const idx = new MemoryIndex(384);
    idx.add("chaton", chaton!);
    idx.add("finance", finance!);
    expect(idx.search(chat!, 1)[0]!.id).toBe("chaton");
  }, 300_000);

  it("des poids altérés d'un seul octet sont refusés et JAMAIS chargés", async () => {
    const b = backend();
    const bytes = new Uint8Array(readFileSync(join(INSTALLED, "onnx", "model_quantized.onnx")));
    bytes[1000] = bytes[1000]! ^ 0xff;
    await expect(new Embeddings(PIN, { backend: b, fetchWeights: async () => bytes }).ensureLoaded()).rejects.toThrow(/épingle/);
    expect(b.loadCount).toBe(0);
  }, 120_000);

  it("sans poids installés : rien n'est téléchargé sans accord ; avec accord, le téléchargement épinglé est vérifié puis chargé", async () => {
    const modes: string[] = [];
    const download = async (_p: ModelPin, mode: "installed" | "download") => {
      modes.push(mode);
      if (mode === "installed") return null;
      const res = await fetch(`https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${REVISION}/onnx/model_quantized.onnx`);
      return new Uint8Array(await res.arrayBuffer());
    };
    await expect(new Embeddings(PIN, { backend: backend(), fetchWeights: download }).ensureLoaded()).rejects.toThrow(/non accordé/);
    expect(modes).toEqual(["installed"]);
    const b = backend();
    const e = new Embeddings(PIN, { backend: b, fetchWeights: download, consent: async () => true });
    expect(await e.ensureLoaded()).toBe("downloaded");
    expect(modes).toEqual(["installed", "installed", "download"]);
    expect((await e.embed(["bonjour"]))[0]).toHaveLength(384);
  }, 300_000);
});
