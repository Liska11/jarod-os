// Portage de packages/core/test/huggingface.test.ts (rév. 2e180305).
// Les trois tests de « télécharger un modèle » ont été RÉÉCRITS au chantier 3 de SPECS-P5-MODELS.md : l'ancien contrat (`resolve/main`, aucune taille ni
// empreinte attendue, aucune vérification) n'existe plus — `download` exige une révision épinglée et la taille/l'empreinte publiées. Leur intention est gardée.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { HuggingFaceService } from "../src/huggingface.js";

afterEach(async () => {
  await cleanup();
});

function temp() {
  return tempDir();
}

const REVISION = "9217f5db79a29953eb74d5343926648285ec7e67";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Un corps de téléchargement en morceaux, comme le vrai service en rend un. */
function bodyOf(text: string, chunks = 3) {
  const size = Math.ceil(text.length / chunks);
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("chercher un modèle", () => {
  it("rend les dépôts tels que le service les donne, sans filtre inventé", async () => {
    const fetchImpl = vi.fn(async (_url: string) =>
      jsonResponse([
        { id: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", downloads: 193781, likes: 135, tags: ["gguf"] },
        { notAnId: true },
      ]),
    );
    const service = new HuggingFaceService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const found = await service.search("qwen");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", downloads: 193781 });
    // Le filtre GGUF est dans la requête : pas de tri a posteriori qui laisserait passer autre chose.
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("filter=gguf");
  });

  it("un refus du service devient une erreur nommée, pas une liste vide", async () => {
    const service = new HuggingFaceService({
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(service.search("x")).rejects.toThrow(/HUGGINGFACE_FAILED/);
  });

  it("ne liste que les .gguf, et dit « inconnu » quand la taille manque", async () => {
    const service = new HuggingFaceService({
      fetchImpl: (async () =>
        jsonResponse({
          siblings: [
            { rfilename: ".gitattributes" },
            { rfilename: "model-Q4_K_M.gguf", size: null },
            { rfilename: "model-Q8_0.gguf", size: 1234 },
          ],
        })) as unknown as typeof fetch,
    });
    const files = await service.files("a/b");
    expect(files.map((f) => f.name)).toEqual(["model-Q4_K_M.gguf", "model-Q8_0.gguf"]);
    expect(files[0]?.bytes).toBeNull();
    expect(files[1]?.bytes).toBe(1234);
  });
});

describe("télécharger un modèle", () => {
  it("écrit le fichier entier, signale l'avancement, et ne laisse pas de .part", async () => {
    const dir = temp();
    const content = "GGUF".repeat(2000);
    const progress: number[] = [];
    const service = new HuggingFaceService({
      freeBytes: () => Number.MAX_SAFE_INTEGER, // indépendant du disque de la machine qui lance les tests
      fetchImpl: (async () =>
        new Response(bodyOf(content), {
          status: 200,
          headers: { "content-length": String(content.length) },
        })) as unknown as typeof fetch,
    });

    const result = await service.download({
      repo: "a/b",
      revision: REVISION,
      file: "model-Q4_K_M.gguf",
      destDir: dir,
      expected: { size: content.length, sha256: sha256(content) },
      onProgress: (received) => progress.push(received),
    });

    expect(result.bytes).toBe(content.length);
    expect(readFileSync(result.path, "utf8")).toBe(content);
    expect(existsSync(`${result.path}.part`)).toBe(false);
    // L'avancement monte : un téléchargement muet est indistinguable d'un blocage.
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(content.length);
  });

  it("une interruption supprime le morceau : un demi-modèle n'est pas un modèle", async () => {
    const dir = temp();
    const controller = new AbortController();
    // Un vrai `fetch` annule son flux : le faux doit le faire aussi, sinon il ne teste qu'un
    // client qui n'obéit à personne — et le fichier resterait sur le disque.
    const service = new HuggingFaceService({
      journal: () => undefined,
      freeBytes: () => Number.MAX_SAFE_INTEGER,
      fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("début"));
                init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
                // On ne ferme jamais : le flux reste ouvert jusqu'à l'interruption.
              },
            }),
            { status: 200 },
          ),
        )) as unknown as typeof fetch,
    });

    const started = service.download({
      repo: "a/b",
      revision: REVISION,
      file: "gros-Q4_K_M.gguf",
      destDir: dir,
      expected: { size: 1_000_000, sha256: null },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(started).rejects.toThrow();

    expect(existsSync(join(dir, "gros-Q4_K_M.gguf"))).toBe(false);
    expect(existsSync(join(dir, "gros-Q4_K_M.gguf.part"))).toBe(false);
  });

  it("refuse un fichier qui n'est pas un GGUF avant de télécharger quoi que ce soit", async () => {
    const dir = temp();
    const fetchImpl = vi.fn();
    const service = new HuggingFaceService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      service.download({ repo: "a/b", revision: REVISION, file: "poids.safetensors", destDir: dir, expected: { size: 10, sha256: null } }),
    ).rejects.toThrow(/UNSUPPORTED_FILE/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
