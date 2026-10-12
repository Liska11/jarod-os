// Chantier 2 de SPECS-P5-MODELS.md : les noms sont validés AVANT toute requête et toute écriture (barre (2-C)), y compris ceux qui viennent de l'API (barre
// (2-D)). Serveur Hugging Face factice local ; `guardedFetch` rend rouge tout accès au vrai réseau. Barres figées dans DECISIONS le 2026-10-03.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { HuggingFaceService } from "../src/huggingface.js";
import { type FakeHf, SHA, guardedFetch, startFakeHf } from "./fake-hf-server.js";
import { TRAPPED_FILES, TRAPPED_REPOS } from "./hf-name-cases.js";

let fake: FakeHf | undefined;
afterEach(async () => {
  await cleanup();
  await fake?.close();
  fake = undefined;
});

async function setup(options: Parameters<typeof startFakeHf>[0] = { files: {} }) {
  fake = await startFakeHf(options);
  const guarded = guardedFetch([fake.origin]);
  const service = new HuggingFaceService({ baseUrl: fake.origin, fetchImpl: guarded.fetch });
  const dest = join(tempDir(), "dest-jamais-cree");
  return { fake, guarded, service, dest };
}

describe("(2-C) un nom refusé : 0 requête, 0 fetch, 0 octet écrit, aucun dossier", () => {
  it("les dépôts piégés, par files() et par download()", async () => {
    const { fake, guarded, service, dest } = await setup();
    for (const [why, repo] of TRAPPED_REPOS) {
      await expect(service.files(repo as string), why).rejects.toThrow(/INVALID_REPO/);
      await expect(service.download({ repo: repo as string, revision: SHA, file: "m.gguf", destDir: dest, expected: { size: 5, sha256: null } }), why).rejects.toThrow(/INVALID_REPO/);
    }
    expect(fake.log).toHaveLength(0);
    expect(guarded.calls).toHaveLength(0);
    expect(existsSync(dest)).toBe(false);
  });

  it("les fichiers piégés, par download()", async () => {
    const { fake, guarded, service, dest } = await setup();
    for (const [why, file] of TRAPPED_FILES) {
      await expect(service.download({ repo: "acme/tiny-GGUF", revision: SHA, file: file as string, destDir: dest, expected: { size: 5, sha256: null } }), why).rejects.toThrow(
        /INVALID_FILE|UNSUPPORTED_FILE/,
      );
    }
    expect(fake.log).toHaveLength(0);
    expect(guarded.calls).toHaveLength(0);
    expect(existsSync(dest)).toBe(false);
  });

  it("témoin : un dépôt valide est bien interrogé, avec l'adresse encodée par segment", async () => {
    const { fake, service } = await setup({ files: {}, models: { "acme/tiny-GGUF": { sha: SHA, siblings: [{ rfilename: "m.gguf", size: 3 }] } } });
    const files = await service.files("acme/tiny-GGUF");
    expect(files.map((f) => f.name)).toEqual(["m.gguf"]);
    expect(fake.log.map((l) => l.path)).toEqual(["/api/models/acme/tiny-GGUF"]);
  });
});

describe("(2-D) les noms qui viennent de l'API", () => {
  it("la liste des fichiers n'expose que les noms valides, les autres sont signalés avec leur raison", async () => {
    const { service } = await setup({
      files: {},
      models: {
        "acme/tiny-GGUF": {
          sha: SHA,
          siblings: [
            { rfilename: "ok-Q4_K_M.gguf", size: 10 },
            { rfilename: "../../evil.gguf", size: 1 },
            { rfilename: "CON.gguf", size: 1 },
            { rfilename: "sub/dir /x.gguf", size: 1 },
            { rfilename: "..\\win.gguf", size: 1 },
            { rfilename: "sub/ok-00001-of-00002.gguf", size: 20 },
            { rfilename: "README.md" },
            { rfilename: "nom-faux.gguf.exe" },
          ],
        },
      },
    });
    const skipped: { name: string; reason: string }[] = [];
    const files = await service.files("acme/tiny-GGUF", { onSkipped: (name, reason) => skipped.push({ name: String(name), reason }) });
    expect(files.map((f) => f.name)).toEqual(["ok-Q4_K_M.gguf", "sub/ok-00001-of-00002.gguf"]);
    expect(skipped.map((s) => s.name).sort()).toEqual(["../../evil.gguf", "..\\win.gguf", "CON.gguf", "sub/dir /x.gguf"]);
    for (const s of skipped) expect(s.reason.length).toBeGreaterThan(5);
  });

  it("la recherche n'expose que les identifiants de dépôt valides", async () => {
    const { service } = await setup({
      files: {},
      searchRows: [
        { id: "acme/ok-GGUF", downloads: 3, likes: 1, tags: ["gguf"] },
        { id: "../etc/passwd" },
        { id: "a/b/c" },
        { id: "evil%2e/x" },
        { id: "acme/espace faux" },
        { id: 42 },
        { id: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", downloads: 5 },
      ],
    });
    const skipped: string[] = [];
    const found = await service.search("qwen", 20, { onSkipped: (name) => skipped.push(String(name)) });
    expect(found.map((m) => m.id)).toEqual(["acme/ok-GGUF", "Qwen/Qwen2.5-0.5B-Instruct-GGUF"]);
    expect(skipped).toEqual(["../etc/passwd", "a/b/c", "evil%2e/x", "acme/espace faux", "42"]);
  });
});
