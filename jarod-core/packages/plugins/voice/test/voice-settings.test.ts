// SPECS-P5-VOICE-PANE.md Section 5 -- barres VS1-VS4 (core). Figées AVANT le code.
// Le voice plugin doit lire autoSpeak et ttsRate des reglages et les utiliser pour la synthese vocale.
import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

describe("VS1-VS4 -- Core voice settings (autoSpeak, ttsRate)", () => {
  it("VS1 : autoSpeak: false -> agent ne lit pas les reponses", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, llm: {}, voice: {} });
    // Par défaut autoSpeak = false
    expect(app.storage.settings.get("voice").autoSpeak).toBe(false);
    // Le service voice doit exposer une méthode speak qui ne fait rien si autoSpeak = false
    expect(typeof app.voice.speak).toBe("function");
    // Sans autoSpeak, speak ne doit pas lancer de synthese
    const result = await app.voice.speak("Test response");
    // Doit retourner un résultat indiquant que rien n'a été lu
    expect(result).toMatchObject({ spoken: false, reason: "autoSpeak=false" });
    await shutdown(app);
  });

  it("VS2 : autoSpeak: true -> agent lit la reponse finale via TTSService.speak", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, llm: {}, voice: {} });
    const s = app.storage.settings;
    s.set("voice", { ...s.get("voice"), autoSpeak: true, ttsRate: 1.0 });
    expect(s.get("voice").autoSpeak).toBe(true);
    // speak doit déclencher la synthese vocale
    const result = await app.voice.speak("Hello world");
    expect(result).toMatchObject({ spoken: true, chars: expect.any(Number) });
    await shutdown(app);
  });

  it("VS3 : ttsRate: 1.5 -> provider TTS reçoit rate: 1.5", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, llm: {}, voice: {} });
    const s = app.storage.settings;
    s.set("voice", { ...s.get("voice"), autoSpeak: true, ttsRate: 1.5 });
    expect(s.get("voice").ttsRate).toBe(1.5);
    const result = await app.voice.speak("Test rate");
    expect(result).toMatchObject({ spoken: true, rate: 1.5 });
    await shutdown(app);
  });

  it("VS4 : ttsRate hors bornes -> ramené dans [0.25, 4.0] (défaut 1.0)", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, llm: {}, voice: {} });
    const s = app.storage.settings;
    // Trop haut
    s.set("voice", { ...s.get("voice"), autoSpeak: true, ttsRate: 10 });
    const r1 = await app.voice.speak("Test");
    expect(r1.rate).toBeLessThanOrEqual(4.0);
    // Trop bas
    s.set("voice", { ...s.get("voice"), autoSpeak: true, ttsRate: 0.1 });
    const r2 = await app.voice.speak("Test");
    expect(r2.rate).toBeGreaterThanOrEqual(0.25);
    // NaN
    s.set("voice", { ...s.get("voice"), autoSpeak: true, ttsRate: NaN });
    const r3 = await app.voice.speak("Test");
    expect(r3.rate).toBe(1.0);
    await shutdown(app);
  });
});
