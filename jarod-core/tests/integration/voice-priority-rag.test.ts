/**
 * SPECS-P5-VOIX-PRIORITAIRE.md §3, §6 (intégration) : les VRAIS plugins `voice` et `rag` chargés ensemble. Le RAG lit la voix
 * paresseusement ; l'ingestion s'arrête dans la fenêtre de la voix, reprend à sa fermeture ; un service supplémentaire
 * (`createService`) a le même câblage, et la condition témoin (voix retirée) n'attend jamais.
 */
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { type VoicePriorityGate } from "@jarod/plugin-voice";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

const TEXT = Array.from({ length: 130 }, (_, i) => `Phrase numéro ${i} du document de test, assez longue pour faire plusieurs passages dans le découpage.`).join("\n");
const vec = (t: string) => Float32Array.from({ length: 4 }, (_, i) => (t.charCodeAt(i) || 1) / 255);
const tick = () => new Promise<void>((r) => setTimeout(r, 40));

async function boot(order: "voice-first" | "rag-first") {
  const plugins = order === "voice-first" ? { voice: {}, rag: {} } : { rag: {}, voice: {} };
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, ...plugins } as never);
  const a = app as unknown as {
    storage: { settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } };
    rag: { rag: import("@jarod/plugin-rag").RagService; createService(o?: Record<string, unknown>): import("@jarod/plugin-rag").RagService };
    voice: { priority: VoicePriorityGate };
  };
  a.storage.settings.set("rag", { ...a.storage.settings.get("rag"), enabled: true, chunkSize: 200, chunkOverlap: 0 });
  return a;
}

describe.each(["voice-first", "rag-first"] as const)("plugins voice et rag, ordre %s", (order) => {
  it("l'ingestion du service du plugin s'arrête dans la fenêtre de la voix et reprend à sa fermeture", async () => {
    const a = await boot(order);
    let batches = 0;
    a.rag.rag.setEmbedder(async (texts) => {
      batches += 1;
      if (batches === 1) a.voice.priority.onCaptureState("recording"); // le mot d'activation est détecté pendant le 1er lot
      return texts.map(vec);
    });
    const done = a.rag.rag.ingest(TEXT, { docId: "d", source: "d.md" });
    await tick();
    expect(batches).toBe(1);
    expect(a.voice.priority.active).toBe(true);
    a.voice.priority.onCaptureState("listening"); // fin de la transcription
    await done;
    expect(batches).toBeGreaterThan(1);
    expect(a.rag.rag.voicePauses().pauses).toBe(1);
  });

  it("createService : même câblage (voix prioritaire) ; `voice: () => undefined` = condition témoin, jamais d'attente", async () => {
    const a = await boot(order);
    const embed = async (texts: string[]) => texts.map(vec);
    const withVoice = a.rag.createService();
    withVoice.setEmbedder(embed);
    const control = a.rag.createService({ voice: () => undefined });
    control.setEmbedder(embed);

    a.voice.priority.onCaptureState("recording");
    let controlDone = false;
    void control.ingest(TEXT, { docId: "c", source: "c.md" }).then(() => (controlDone = true));
    let withDone = false;
    void withVoice.ingest(TEXT, { docId: "w", source: "w.md" }).then(() => (withDone = true));
    await tick();
    expect(controlDone).toBe(true); // le témoin ne cède jamais
    expect(withDone).toBe(false); // le service câblé attend la fin de la fenêtre
    a.voice.priority.onCaptureState("listening");
    await tick();
    expect(withDone).toBe(true);
  });
});

describe("plugin voice absent", () => {
  it("aucune attente, aucune erreur : le RAG ingère comme avant (un seul appel à l'embedder)", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} } as never);
    const a = app as unknown as {
      storage: { settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } };
      rag: { rag: import("@jarod/plugin-rag").RagService };
    };
    a.storage.settings.set("rag", { ...a.storage.settings.get("rag"), enabled: true, chunkSize: 200, chunkOverlap: 0 });
    let calls = 0;
    a.rag.rag.setEmbedder(async (texts) => (calls++, texts.map(vec)));
    await a.rag.rag.ingest(TEXT, { docId: "d", source: "d.md" });
    expect(calls).toBe(1);
    expect(a.rag.rag.voicePauses()).toEqual({ pauses: 0, pausedMs: 0 });
  });
});
