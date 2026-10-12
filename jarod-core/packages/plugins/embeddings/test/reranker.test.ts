// SPECS-P5-RERANKER.md §2.3–2.4, §6 : moteur du reranker — lots FIXES (remplissage), choix de l'appareil par sonde, aucun texte au journal.
// Sans OpenVINO : un faux runtime remplace `TextRerankPipeline`.
import { describe, expect, it } from "vitest";
import { classCorrect, OpenVinoReranker, PAD_TEXT, probeDocs, RerankerError, type RerankPipeline, type RerankRuntime, scoreAll } from "../src/reranker.js";

/** Textes sondes pertinents (a priori) : le faux pipeline les reconnaît, ainsi que tout texte contenant « PERTINENT ». */
const REL_TEXTS = new Set(probeDocs(8).docs.filter((_, i) => probeDocs(8).relevant.has(i)));
const isRel = (d: string): boolean => REL_TEXTS.has(d) || d.includes("PERTINENT");
/** Un faux pipeline : score 1 pour un document pertinent, 0 sinon (le remplissage vide vaut 0), rendu trié comme le vrai. */
const goodPipeline = (calls: string[][] = []): RerankPipeline => ({
  rerank: async (_q, docs) => {
    calls.push([...docs]);
    return docs.map((d, i) => [i, isRel(d) ? 1 : 0] as [number, number]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  },
});

describe("scoreAll : lot fixe", () => {
  const backend = (batch: number, seen: string[][]) => ({
    batch,
    scoreBatch: async (_q: string, docs: string[]) => {
      seen.push([...docs]);
      return docs.map((d) => (d === PAD_TEXT ? -1 : d.length));
    },
  });

  it("le remplissage est un texte NEUTRE ET LONG, jamais vide : le tokenizer d'OpenVINO échoue sur un lot de documents trop courts (mesuré)", () => {
    expect(PAD_TEXT.length).toBeGreaterThan(150);
    expect(PAD_TEXT.trim()).not.toBe("");
  });

  it("3 candidats pour un lot de 8 : un appel, remplissage neutre, scores rendus dans l'ordre sans le remplissage", async () => {
    const seen: string[][] = [];
    const scores = await scoreAll(backend(8, seen), "q", ["a", "bb", "ccc"]);
    expect(scores).toEqual([1, 2, 3]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(8);
    expect(seen[0]!.slice(3)).toEqual([PAD_TEXT, PAD_TEXT, PAD_TEXT, PAD_TEXT, PAD_TEXT]);
  });

  it("8 exacts : un appel sans remplissage", async () => {
    const seen: string[][] = [];
    const docs = Array.from({ length: 8 }, (_, i) => "x".repeat(i + 1));
    expect(await scoreAll(backend(8, seen), "q", docs)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(PAD_TEXT);
  });

  it("17 candidats : trois appels séquentiels, ordre d'origine conservé, dernier lot rempli", async () => {
    const seen: string[][] = [];
    const docs = Array.from({ length: 17 }, (_, i) => "x".repeat(i + 1));
    const scores = await scoreAll(backend(8, seen), "q", docs);
    expect(scores).toEqual(docs.map((d) => d.length));
    expect(seen.map((s) => s.length)).toEqual([8, 8, 8]);
    expect(seen[2]!.filter((d) => d === PAD_TEXT)).toHaveLength(7);
  });

  it("aucun candidat : aucun appel", async () => {
    const seen: string[][] = [];
    expect(await scoreAll(backend(8, seen), "q", [])).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("un lot qui rend le mauvais nombre de scores est une erreur franche", async () => {
    await expect(scoreAll({ batch: 4, scoreBatch: async () => [1, 2] }, "q", ["a"])).rejects.toMatchObject({ code: "RERANKER_BAD_RESULT" });
  });
});

describe("sonde de classe", () => {
  it("probeDocs : autant de documents que le lot, des pertinents et des non pertinents, étiquettes a priori", () => {
    const { docs, relevant } = probeDocs(8);
    expect(docs).toHaveLength(8);
    expect(relevant.size).toBeGreaterThan(0);
    expect(relevant.size).toBeLessThan(8);
  });

  it("classCorrect : tout pertinent strictement au-dessus de tout non pertinent", () => {
    const rel = new Set([0, 2]);
    expect(classCorrect([0.9, 0.1, 0.8, 0.2], rel)).toBe(true);
    expect(classCorrect([0.9, 0.85, 0.8, 0.2], rel)).toBe(false);
    expect(classCorrect([1, 1, 1, 1], rel)).toBe(false); // égalité : pas de séparation
  });
});

describe("OpenVinoReranker : choix de l'appareil", () => {
  const cfg = { modelDir: "/m", port: 8930, batch: 8, maxLength: 512, devices: ["NPU", "GPU.0", "CPU"] };
  it("le premier appareil qui compile ET passe la sonde sert ; l'effectif est rapporté", async () => {
    const ov = new OpenVinoReranker(cfg, { compile: async () => goodPipeline() });
    await ov.init();
    expect(ov.available).toBe(true);
    expect(ov.metrics().device).toBe("NPU");
    expect(ov.metrics().attempts).toMatchObject([{ device: "NPU", ok: true }]);
  });

  it("NPU refuse à la compilation : GPU.0 sert, l'échec du NPU est journalisé, jamais silencieux", async () => {
    const tried: string[] = [];
    const rt: RerankRuntime = {
      compile: async (_m, d) => {
        tried.push(d);
        if (d === "NPU") throw new Error("Upper bounds are not specified");
        return goodPipeline();
      },
    };
    const logs: string[] = [];
    const ov = new OpenVinoReranker(cfg, rt, (l) => logs.push(l));
    await ov.init();
    expect(tried).toEqual(["NPU", "GPU.0"]);
    expect(ov.metrics().device).toBe("GPU.0");
    expect(ov.metrics().attempts.map((a) => [a.device, a.ok])).toEqual([["NPU", false], ["GPU.0", true]]);
    expect(logs.join("\n")).toContain("NPU");
  });

  it("un appareil qui compile mais échoue la sonde (classement faux) est écarté", async () => {
    const bad: RerankPipeline = { rerank: async (_q, docs) => docs.map((_, i) => [i, 0.5] as [number, number]) }; // aucune séparation
    const rt: RerankRuntime = { compile: async (_m, d) => (d === "NPU" ? bad : goodPipeline()) };
    const ov = new OpenVinoReranker(cfg, rt);
    await ov.init();
    expect(ov.metrics().device).toBe("GPU.0");
    expect(ov.metrics().attempts[0]).toMatchObject({ device: "NPU", ok: false });
  });

  it("aucun appareil : RERANKER_NO_DEVICE, indisponible, rerank refusé avec un code", async () => {
    const ov = new OpenVinoReranker(cfg, { compile: async () => { throw new Error("non"); } });
    await expect(ov.init()).rejects.toMatchObject({ code: "RERANKER_NO_DEVICE" });
    expect(ov.available).toBe(false);
    await expect(ov.scoreBatch("q", [])).rejects.toMatchObject({ code: "RERANKER_UNAVAILABLE" });
  });

  it("scoreBatch : scores rendus par indice d'entrée (pas dans l'ordre trié), métriques mises à jour, appels sérialisés", async () => {
    const calls: string[][] = [];
    const ov = new OpenVinoReranker(cfg, { compile: async () => goodPipeline(calls) });
    await ov.init();
    const docs = Array.from({ length: 8 }, (_, i) => (i === 5 ? "le PERTINENT" : `autre ${i}`));
    const [a, b] = await Promise.all([ov.scoreBatch("q", docs), ov.scoreBatch("q", docs)]);
    expect(a![5]).toBe(1);
    expect(a!.filter((s) => s === 1)).toHaveLength(1);
    expect(b).toEqual(a);
    const m = ov.metrics();
    expect(m.calls).toBeGreaterThanOrEqual(2);
    expect(m.p50Ms).not.toBeNull();
  });

  it("scoreBatch refuse un lot de taille différente de celle de l'IR figée", async () => {
    const ov = new OpenVinoReranker(cfg, { compile: async () => goodPipeline() });
    await ov.init();
    await expect(ov.scoreBatch("q", ["a", "b"])).rejects.toBeInstanceOf(RerankerError);
  });

  it("les journaux et métriques ne contiennent ni la requête ni les documents", async () => {
    const logs: string[] = [];
    const ov = new OpenVinoReranker(cfg, { compile: async () => goodPipeline() }, (l) => logs.push(l));
    await ov.init();
    await ov.scoreBatch("SECRET-REQUETE", Array.from({ length: 8 }, (_, i) => `SECRET-DOC-${i}`));
    expect(JSON.stringify([logs, ov.metrics()])).not.toContain("SECRET");
  });
});
