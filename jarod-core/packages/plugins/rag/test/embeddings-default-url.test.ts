// SPECS-P5-EMBEDDINGS.md §3.5 : ordre de résolution de l'URL d'embeddings du RAG —
// (1) `rag.embeddingsUrl` du profil, (2) URL du worker d'embeddings de l'application (`embeddingsDefaultUrl`, jamais écrite
// dans les réglages), (3) fournisseur actif s'il est local, (4) erreur franche.
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { RagService } from "../src/index.js";

afterEach(cleanup);

const LOCAL = { local: true, baseUrl: "http://127.0.0.1:8080/v1", name: "custom" };
const CLOUD = { local: false, baseUrl: "https://api.example.com/v1", name: "cloud" };
const WORKER = "http://127.0.0.1:8920/v1";

async function setup(opts: { provider: typeof LOCAL | typeof CLOUD; profileUrl?: string; defaultUrl?: string }) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, embeddingsUrl: opts.profileUrl ?? "" });
  const svc = new RagService({
    db,
    settings,
    providers: { def: () => opts.provider as never },
    ...(opts.defaultUrl !== undefined ? { embeddingsDefaultUrl: opts.defaultUrl } : {}),
  });
  return { svc, settings, app };
}

describe("URL d'embeddings du RAG : ordre de résolution", () => {
  it("(1) l'URL explicite du profil gagne sur tout le reste", async () => {
    const { svc } = await setup({ provider: LOCAL, profileUrl: "http://127.0.0.1:9999/v1/", defaultUrl: WORKER });
    expect(svc.endpoint().url).toBe("http://127.0.0.1:9999/v1");
    expect(svc.status().endpoint).toBe("http://127.0.0.1:9999/v1/embeddings");
  });

  it("(2) sans URL de profil : l'URL du worker, même si le fournisseur actif est local ou distant", async () => {
    for (const provider of [LOCAL, CLOUD]) {
      const { svc } = await setup({ provider, defaultUrl: WORKER });
      expect(svc.endpoint().url).toBe(WORKER);
      expect(svc.status().endpoint).toBe(`${WORKER}/embeddings`);
    }
  });

  it("(3) sans URL de profil ni de worker : le fournisseur local, comme avant", async () => {
    const { svc } = await setup({ provider: LOCAL });
    expect(svc.endpoint().url).toBe("http://127.0.0.1:8080/v1");
  });

  it("(4) rien du tout et fournisseur distant : erreur franche, aucune requête vers le nuage", async () => {
    const { svc } = await setup({ provider: CLOUD });
    expect(svc.status().endpoint).toBeNull();
    expect(() => svc.endpoint()).toThrow(/n'est pas local/);
  });

  it("une URL de worker vide ou blanche ne compte pas (équivaut à absente)", async () => {
    const { svc } = await setup({ provider: CLOUD, defaultUrl: "  " });
    expect(svc.status().endpoint).toBeNull();
  });

  it("slash final retiré ; le modèle du profil reste celui du profil", async () => {
    const { svc, settings } = await setup({ provider: LOCAL, defaultUrl: `${WORKER}/` });
    settings.set("rag", { ...settings.get("rag"), embeddingsModel: "bge-m3-int8-ov" });
    expect(svc.endpoint()).toEqual({ url: WORKER, model: "bge-m3-int8-ov" });
  });

  it("l'URL du worker n'est JAMAIS écrite dans les réglages du profil", async () => {
    const { svc, settings } = await setup({ provider: LOCAL, defaultUrl: WORKER });
    svc.endpoint();
    svc.status();
    expect(settings.get("rag").embeddingsUrl).toBe("");
  });

  it("l'embarquement part bien vers l'URL du worker (requête HTTP observée)", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
    const { db, settings } = app.storage;
    settings.set("rag", { ...settings.get("rag"), enabled: true });
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new RagService({ db, settings, providers: { def: () => CLOUD as never }, embeddingsDefaultUrl: WORKER, fetch: fakeFetch });
    await svc.ingest("Un court texte à indexer.", { docId: "d1", source: "d1" });
    expect(seen).toEqual([`${WORKER}/embeddings`]);
  });
});

describe("plugin-rag : la configuration `embeddingsDefaultUrl` atteint le service", () => {
  it("le service du plugin résout l'URL du worker", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: { embeddingsDefaultUrl: WORKER } });
    expect(app.rag.rag.status().endpoint).toBe(`${WORKER}/embeddings`);
  });

  it("sans la clé : comportement inchangé (aucun point d'accès par défaut)", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
    expect(app.rag.rag.status().endpoint ?? "").not.toContain("8920");
  });
});
