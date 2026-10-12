/**
 * Capture continue (`capture.ts`) : mot d'activation → enregistrement → fin de parole → transcription,
 * avec un détecteur et un STT simulés. La chaîne réelle (micro Electron, NPU, whisper.cpp iGPU) :
 * `packages/desktop/test/e2e/voice.e2e.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { type CaptureDeps, type CaptureState, type CaptureTranscript, pcm16ToWav, VoiceCapture } from "../src/capture.js";
import { readWavPcm16 } from "../src/wakeword.js";

const ms = (n: number) => (n * 16000) / 1000;
const silence = (n: number) => new Int16Array(ms(n));
const speech = (n: number) => Int16Array.from({ length: ms(n) }, (_, i) => Math.round(5000 * Math.sin(i * 0.2)));

function harness(opts: { wakeOnCall?: number; failStt?: boolean; slowStt?: Promise<void> } = {}) {
  let calls = 0;
  const states: CaptureState[] = [];
  const transcripts: CaptureTranscript[] = [];
  const errors: string[] = [];
  const wavs: Buffer[] = [];
  let prepared = 0;
  let resets = 0;
  const deps: CaptureDeps = {
    detect: async () => (calls++ === (opts.wakeOnCall ?? 0) ? [{ model: "hey_jarvis", score: 0.9, atMs: 1840 }] : []),
    prepare: async () => void prepared++,
    transcribe: async (wav) => {
      wavs.push(wav);
      if (opts.slowStt) await opts.slowStt;
      if (opts.failStt) throw new Error("WHISPER_DIED: test");
      return "rappelle-moi d'acheter du pain";
    },
    resetDetector: () => void resets++,
    onState: (s) => void states.push(s),
    onTranscript: (t) => void transcripts.push(t),
    onError: (e) => void errors.push(e.message),
  };
  return { deps, states, transcripts, errors, wavs, detectCalls: () => calls, prepared: () => prepared, resets: () => resets };
}

describe("VoiceCapture", () => {
  it("écoute, mot, parole puis silence → une transcription du seul audio d'après le mot", async () => {
    const h = harness({ wakeOnCall: 2 });
    const c = new VoiceCapture(h.deps);
    for (let i = 0; i < 3; i++) await c.feed(silence(80)); // 3e bloc : mot détecté
    expect(c.state()).toBe("recording");
    for (let i = 0; i < 10; i++) await c.feed(speech(100)); // 1 s de parole
    expect(c.state()).toBe("recording");
    for (let i = 0; i < 9; i++) await c.feed(silence(100)); // 900 ms de silence terminent la commande
    expect(h.states).toEqual(["recording", "transcribing", "listening"]);
    expect(h.transcripts).toHaveLength(1);
    expect(h.transcripts[0]).toMatchObject({ text: "rappelle-moi d'acheter du pain", wake: { model: "hey_jarvis", atMs: 1840 } });
    // L'audio transcrit = la parole + le silence reçu jusqu'à la fin détectée (1 s + 0,9 s).
    const { sampleRate, pcm } = readWavPcm16(h.wavs[0]!);
    expect(sampleRate).toBe(16000);
    expect(pcm.length).toBe(ms(1000) + ms(900));
    expect(h.transcripts[0]!.audioMs).toBe(1900);
    expect(h.detectCalls()).toBe(3); // le détecteur ne voit pas l'enregistrement
    expect(h.prepared()).toBe(2); // au mot (démarrage anticipé) et avant la transcription
    expect(h.resets()).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it("fin du mot puis pause avant la commande : l'enregistrement attend la commande", async () => {
    const h = harness();
    const c = new VoiceCapture(h.deps);
    await c.feed(silence(80));
    await c.feed(speech(60)); // queue de « Jarvis » (dans les 300 premiers ms)
    for (let i = 0; i < 12; i++) await c.feed(silence(100)); // 1,2 s de pause : plus que endSilenceMs
    expect(c.state()).toBe("recording");
    await c.feed(speech(100)); // 100 ms de bruit bref : pas encore une commande
    for (let i = 0; i < 10; i++) await c.feed(silence(100));
    expect(c.state()).toBe("recording");
    for (let i = 0; i < 15; i++) await c.feed(speech(100)); // la commande
    for (let i = 0; i < 9; i++) await c.feed(silence(100));
    expect(h.states).toEqual(["recording", "transcribing", "listening"]);
    expect(h.transcripts[0]!.audioMs).toBe(60 + 1200 + 100 + 1000 + 1500 + 900);
  });

  it("sans parole après le mot : abandon, rien n'est transcrit", async () => {
    const h = harness();
    const c = new VoiceCapture(h.deps, { noSpeechMs: 2000 });
    await c.feed(silence(80));
    for (let i = 0; i < 20; i++) await c.feed(silence(100));
    expect(h.states).toEqual(["recording", "listening"]);
    expect(h.transcripts).toEqual([]);
    expect(h.wavs).toEqual([]);
  });

  it("parole continue : coupée à maxMs", async () => {
    const h = harness();
    const c = new VoiceCapture(h.deps, { maxMs: 3000 });
    await c.feed(silence(80));
    for (let i = 0; i < 40 && h.transcripts.length === 0; i++) await c.feed(speech(100));
    expect(h.transcripts).toHaveLength(1);
    expect(h.transcripts[0]!.audioMs).toBe(3000);
  });

  it("échec de la transcription : erreur remontée, retour à l'écoute", async () => {
    const h = harness({ failStt: true });
    const c = new VoiceCapture(h.deps);
    await c.feed(silence(80));
    await c.feed(speech(500));
    await c.feed(silence(1000));
    expect(h.errors).toEqual(["WHISPER_DIED: test"]);
    expect(h.transcripts).toEqual([]);
    expect(c.state()).toBe("listening");
  });

  it("l'audio reçu pendant la transcription est ignoré (ni détecteur ni enregistrement)", async () => {
    let release!: () => void;
    const h = harness({ slowStt: new Promise<void>((r) => (release = r)) });
    const c = new VoiceCapture(h.deps);
    await c.feed(silence(80));
    await c.feed(speech(500));
    const finishing = c.feed(silence(1000));
    await new Promise((r) => setTimeout(r, 10));
    expect(c.state()).toBe("transcribing");
    const during = c.feed(speech(500)); // sérialisé derrière la transcription
    release();
    await finishing;
    expect(await during).toBe("transcribing"); // rejeté à l'appel
    expect(h.detectCalls()).toBe(1);
    expect(h.transcripts).toHaveLength(1);
  });

  it("cancel() abandonne l'enregistrement", async () => {
    const h = harness();
    const c = new VoiceCapture(h.deps);
    await c.feed(silence(80));
    c.cancel();
    expect(c.state()).toBe("listening");
    expect(h.states).toEqual(["recording", "listening"]);
  });

  it("pcm16ToWav : relu à l'identique", () => {
    const pcm = speech(50);
    const back = readWavPcm16(pcm16ToWav(pcm));
    expect(back.sampleRate).toBe(16000);
    expect(Array.from(back.pcm)).toEqual(Array.from(pcm));
  });
});
