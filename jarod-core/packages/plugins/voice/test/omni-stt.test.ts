// Dictée par LFM3-Omni : l'audio part dans une requête de conversation au moteur local, avec la consigne « Perform ASR in <langue> ».
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeWithOmni } from "../src/voice.js";

afterEach(() => vi.unstubAllGlobals());

const settings = (over: Record<string, unknown> = {}) => ({ get: (k: string) => ({ localEngine: { port: 8123 }, language: "fr", ...over })[k] }) as never;

describe("dictée par le modèle omni", () => {
  it("wav envoyé en input_audio au port du moteur, langue du réglage, texte rendu", async () => {
    const seen: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "  Bonjour Jarod.  " } }] }), { status: 200 });
    });
    expect(await transcribeWithOmni(settings(), Buffer.from("RIFF"), "audio/wav", "")).toBe("Bonjour Jarod.");
    expect(seen[0]!.url).toBe("http://127.0.0.1:8123/v1/chat/completions");
    expect(seen[0]!.body.messages[0]).toEqual({ role: "system", content: "Perform ASR in French." });
    expect(seen[0]!.body.messages[1].content[0]).toEqual({ type: "input_audio", input_audio: { data: Buffer.from("RIFF").toString("base64"), format: "wav" } });
    expect(seen[0]!.body.temperature).toBe(0);
  });

  it("un format que le moteur ne lit pas est refusé clairement ; un moteur éteint aussi", async () => {
    await expect(transcribeWithOmni(settings(), Buffer.from("x"), "audio/webm;codecs=opus", "")).rejects.toThrow(/wav, mp3 ou flac/);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(transcribeWithOmni(settings(), Buffer.from("x"), "audio/wav", "")).rejects.toThrow(/modèle omni local ne répond pas.*8123/);
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    await expect(transcribeWithOmni(settings(), Buffer.from("x"), "audio/wav", "")).rejects.toThrow(/HTTP 500/);
  });
});
