/** Application installée : openvino-genai-node n'est pas embarqué (bundle-gateway.mjs, liste ABSENT). L'erreur doit le DIRE, pas citer un chemin de module. */
import { describe, expect, it } from "vitest";
import { makeGenaiLoader } from "../src/openvino.js";

describe("chargement d'openvino-genai-node", () => {
  it("module absent : message clair (moteur non inclus dans cette installation), cause d'origine conservée", async () => {
    const absent = Object.assign(new Error("Cannot find package 'openvino-genai-node' imported from /x/gateway.mjs"), { code: "ERR_MODULE_NOT_FOUND" });
    const load = makeGenaiLoader(() => Promise.reject(absent));
    const err = await load().then(() => null, (e: Error & { cause?: unknown }) => e);

    expect(err?.message).toMatch(/n'est pas inclus dans cette installation/);
    expect(err?.message).toMatch(/RAG/);
    expect(err?.cause).toBe(absent);
  });

  it("autre erreur (DLL, version) : propagée telle quelle, jamais présentée comme « non inclus »", async () => {
    const other = new Error("The specified module could not be found: openvino.dll");
    const err = await makeGenaiLoader(() => Promise.reject(other))().then(() => null, (e: Error) => e);

    expect(err).toBe(other);
  });

  it("un échec n'est pas mis en cache à vie, un succès l'est", async () => {
    let calls = 0;
    const load = makeGenaiLoader(() => (++calls === 1 ? Promise.reject(new Error("transitoire")) : Promise.resolve({ ok: true } as never)));

    await expect(load()).rejects.toThrow("transitoire");
    await expect(load()).resolves.toEqual({ ok: true });
    await load();
    expect(calls).toBe(2);
  });
});
