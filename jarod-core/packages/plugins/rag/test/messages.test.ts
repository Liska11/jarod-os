// SPECS-P5-UI-PARITE.md § 17.1 : les deux messages du service nomment l'endroit où l'utilisateur peut agir (Réglages › Documents), pas un volet qui n'existe pas.
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { RagService } from "../src/index.js";

afterEach(cleanup);

async function setup(rag: Record<string, unknown>, local: boolean) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), ...rag });
  return new RagService({ db, settings, providers: { def: () => ({ local, name: "Fournisseur test", baseUrl: "http://127.0.0.1:1/v1" }) as never } });
}

describe("messages du service RAG", () => {
  it("éteint : indexer et chercher sont refusés, le message nomme Réglages › Documents", async () => {
    const rag = await setup({ enabled: false }, true);
    rag.setEmbedder(async (t) => t.map(() => Float32Array.from([1, 0])));
    await expect(rag.ingest("un texte")).rejects.toThrow(/Réglages › Documents/);
    await expect(rag.search("un texte")).rejects.toThrow(/Réglages › Documents/);
  });

  it("fournisseur actif non local et aucune adresse : le message invite à choisir une adresse dans Réglages › Documents", async () => {
    const rag = await setup({ enabled: true, embeddingsUrl: "" }, false);
    expect(() => rag.endpoint()).toThrow(/Réglages › Documents/);
  });
});
