/**
 * SPECS-P5-UI-PARITE.md §3.4 — recherche dans les documents (RAG) et moteurs de l'écosystème dans les réglages. Bornes de plugin-rag reprises à
 * l'identique, aucun chemin de programme exposé, envoi des documents hors machine et moteurs qui changent ce qui est servi : boîte native.
 * VRAI kernel, VRAIS handlers.
 */
import { DEFAULT_ECOSYSTEM_FLAGS } from "@jarod/contracts";
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

describe("RAG", () => {
  it("lecture : les réglages utiles, et JAMAIS les chemins de programmes (docling, pdfium)", async () => {
    const { call } = await setupKernel();
    const v = (await call("get-jarod-settings")) as { rag: Record<string, unknown> };
    expect(v.rag).toEqual({ enabled: false, embeddingsUrl: "", embeddingsModel: "", chunkSize: 800, chunkOverlap: 100, maxChunksPerDoc: 2, topK: 5 });
    for (const k of ["doclingPython", "doclingWorker", "pdfiumWorker"]) expect(v.rag).not.toHaveProperty(k);
  });

  it("écriture partielle : fusionnée avec le reste, les chemins d'analyseurs existants sont préservés", async () => {
    const { call, app } = await setupKernel();
    app.agent.settings.set("rag", { ...app.agent.settings.get("rag"), doclingPython: "C:\\py\\python.exe", doclingWorker: "C:\\w.py", pdfiumWorker: "C:\\p.py" });
    await call("set-jarod-settings", { rag: { enabled: true, chunkSize: 1200, chunkOverlap: 200, maxChunksPerDoc: 3, topK: 8, embeddingsModel: "bge-m3" } });
    expect(app.agent.settings.get("rag")).toMatchObject({ enabled: true, chunkSize: 1200, chunkOverlap: 200, maxChunksPerDoc: 3, topK: 8, embeddingsModel: "bge-m3", doclingPython: "C:\\py\\python.exe", doclingWorker: "C:\\w.py", pdfiumWorker: "C:\\p.py" });
  });

  it("adresse d'embeddings locale : sans boîte ; hors machine : boîte native qui nomme l'hôte, refusée = rien d'écrit ; vider ne demande rien", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    await call("set-jarod-settings", { rag: { embeddingsUrl: "http://127.0.0.1:8080/v1/" } });
    await call("set-jarod-settings", { rag: { embeddingsUrl: "http://localhost:11434/v1" } });
    expect(confirms).toHaveLength(0);
    expect(app.agent.settings.get("rag").embeddingsUrl).toBe("http://localhost:11434/v1");
    await rejects(() => call("set-jarod-settings", { rag: { embeddingsUrl: "https://embeddings.example.org/v1" } }), /refusé par l'utilisateur/);
    expect(app.agent.settings.get("rag").embeddingsUrl).toBe("http://localhost:11434/v1");
    expect(confirms[0]!.detail).toContain("embeddings.example.org");
    expect(confirms[0]!.detail).toMatch(/hors de cette machine/);
    await call("set-jarod-settings", { rag: { embeddingsUrl: "https://embeddings.example.org/v1" } });
    expect(app.agent.settings.get("rag").embeddingsUrl).toBe("https://embeddings.example.org/v1");
    await call("set-jarod-settings", { rag: { embeddingsUrl: "" } });
    expect(confirms).toHaveLength(2);
    expect(app.agent.settings.get("rag").embeddingsUrl).toBe("");
  });

  it("bornes de plugin-rag reprises : refus (jamais « ramené »), aucun patch à moitié écrit", async () => {
    const { call, app } = await setupKernel();
    const before = app.agent.settings.getAll();
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ chunkSize: 99 }, /entre 100 et 4000/],
      [{ chunkSize: 4001 }, /entre 100 et 4000/],
      [{ chunkOverlap: -1 }, /entre/],
      [{ chunkOverlap: 1001 }, /entre/],
      [{ chunkSize: 200, chunkOverlap: 101 }, /la moitié/],
      [{ maxChunksPerDoc: 0 }, /entre 1 et 20/],
      [{ maxChunksPerDoc: 21 }, /entre 1 et 20/],
      [{ topK: 0 }, /entre 1 et 50/],
      [{ topK: 51 }, /entre 1 et 50/],
      [{ topK: 2.5 }, /entier/],
      [{ enabled: "oui" }, /booléen/],
      [{ embeddingsUrl: "ftp://x" }, /http\(s\) seulement/],
      [{ embeddingsUrl: "pas une adresse" }, /adresse invalide/],
      [{ embeddingsUrl: "http://user:pw@127.0.0.1" }, /identifiants/],
      [{ embeddingsModel: "x".repeat(201) }, /au plus 200/],
      [{ doclingPython: "C:\\evil.exe" }, /inconnue/],
      [{ pdfiumWorker: "C:\\evil.py" }, /inconnue/],
    ];
    for (const [patch, why] of bad) await rejects(() => call("set-jarod-settings", { agentMode: "plan", rag: patch }), why);
    expect(app.agent.settings.getAll()).toEqual(before);
  });
});

describe("moteurs de l'écosystème", () => {
  it("lecture : les interrupteurs, éteints par défaut (pile actuelle)", async () => {
    const { call } = await setupKernel();
    expect(((await call("get-jarod-settings")) as { ecosystem: unknown }).ecosystem).toEqual(DEFAULT_ECOSYSTEM_FLAGS);
  });

  it("un moteur qui change ce que la recherche sert : boîte native qui le nomme ; refusée, rien n'est écrit ; l'éteindre ne demande rien", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    await rejects(() => call("set-jarod-settings", { ecosystem: { hybrid: "on", reranker: "bge-reranker-v2-m3-npu", rerankMode: "active" } }), /refusé par l'utilisateur/);
    expect(app.agent.settings.get("ecosystem")).toEqual(DEFAULT_ECOSYSTEM_FLAGS);
    expect(confirms[0]!.detail).toContain("recherche hybride");
    expect(confirms[0]!.detail).toContain("bge-reranker-v2-m3-npu (SERVI)");
    expect(confirms[0]!.detail).toMatch(/barres de décision/);
    await call("set-jarod-settings", { ecosystem: { hybrid: "on", reranker: "bge-reranker-v2-m3-npu", rerankMode: "active" } });
    expect(app.agent.settings.get("ecosystem")).toMatchObject({ hybrid: "on", reranker: "bge-reranker-v2-m3-npu", rerankMode: "active" });
    await call("set-jarod-settings", { ecosystem: { hybrid: "off", reranker: "off" } });
    expect(confirms).toHaveLength(2);
    expect(app.agent.settings.get("ecosystem")).toMatchObject({ hybrid: "off", reranker: "off", rerankMode: "active" }); // fusion : le reste est gardé
  });

  it("le mode fantôme et le journal ne demandent rien ; passer du fantôme à « servi » redemande", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [true, true]);
    await call("set-jarod-settings", { ecosystem: { decisionLog: false, rerankMode: "shadow", rerankTopN: 20 } });
    expect(confirms).toHaveLength(0);
    await call("set-jarod-settings", { ecosystem: { reranker: "bge-reranker-v2-m3-npu" } });
    expect(confirms[0]!.detail).toContain("(fantôme)");
    await call("set-jarod-settings", { ecosystem: { rerankMode: "active" } });
    expect(confirms[1]!.detail).toContain("(SERVI)");
    expect(app.agent.settings.get("ecosystem")).toMatchObject({ rerankTopN: 20, decisionLog: false });
  });

  it("validé par le MÊME schéma que le kernel : valeurs hors liste, clés inconnues, nombres invalides — refus sans écriture", async () => {
    const { call, app } = await setupKernel();
    const before = app.agent.settings.getAll();
    const bad: [unknown, RegExp][] = [
      [{ vectorIndex: "faiss" }, /ecosystem\.vectorIndex/],
      [{ reranker: "autre" }, /ecosystem\.reranker/],
      [{ hybrid: true }, /ecosystem\.hybrid/],
      [{ rerankTopN: -3 }, /ecosystem\.rerankTopN/],
      [{ rerankTopN: 2.5 }, /ecosystem\.rerankTopN/],
      [{ virus: 1 }, /inconnue/],
      ["tout", /objet attendu/],
      [[], /objet attendu/],
    ];
    for (const [patch, why] of bad) await rejects(() => call("set-jarod-settings", { agentMode: "plan", ecosystem: patch }), why);
    expect(app.agent.settings.getAll()).toEqual(before);
  });
});
