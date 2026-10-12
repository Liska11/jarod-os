// Leçon du 2026-10-02 : un banc vérifie son état au départ de chaque barre (calculateur d'embeddings de test resté actif = chiffres faux sans erreur).
import { describe, expect, it } from "vitest";
import { BenchStateError, resetBenchState, type StateRag } from "../bench/bench-state.js";

const canary = { text: "extrait connu", ok: new Set(["doc.pdf#3"]) };

function fakeRag(opts: { stale?: boolean } = {}) {
  const log: string[] = [];
  let stubbed = opts.stale === true;
  const rag: StateRag = {
    setEmbedder: () => {
      log.push("setEmbedder(null)");
      if (!opts.stale) stubbed = false; // un calculateur « collé » ne se retire pas : le canari doit alors le voir
    },
    search: async () => (stubbed ? [{ docId: "autre.pdf", ord: 9 }] : [{ docId: "doc.pdf", ord: 3 }]),
  };
  return { rag, log, setFlag: (v: "on" | "off") => void log.push(`flag=${v}`) };
}

describe("resetBenchState", () => {
  it("retire le calculateur de test, éteint le drapeau, puis laisse passer si le canari revient en tête", async () => {
    const f = fakeRag();
    await expect(resetBenchState("barre (f)", { rag: f.rag, setFlag: f.setFlag, canary })).resolves.toBeUndefined();
    expect(f.log).toEqual(["setEmbedder(null)", "flag=off"]);
  });

  it("calculateur de test resté actif (le canari ne revient pas) : le banc s'arrête avec le nom de la barre, jamais de chiffre faux", async () => {
    const f = fakeRag({ stale: true });
    const err = await resetBenchState("barre (f)", { rag: f.rag, setFlag: f.setFlag, canary }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BenchStateError);
    expect((err as Error).message).toMatch(/barre \(f\) : état du banc invalide/);
    expect((err as Error).message).toMatch(/autre\.pdf#9/);
  });

  it("recherche qui ne rend rien : état invalide aussi", async () => {
    const rag: StateRag = { setEmbedder: () => {}, search: async () => [] };
    await expect(resetBenchState("barre (a)", { rag, setFlag: () => {}, canary })).rejects.toThrow(/rien/);
  });
});
