/**
 * Priorité de la voix (SPECS-P5-VOIX-PRIORITAIRE.md §2, §6) : la fenêtre va de la détection du mot d'activation à la fin de la
 * transcription ; l'écoute passive ne compte jamais ; la reprise est immédiate et garantie, même si la dictée échoue.
 * Capture réelle (`VoiceCapture`), détecteur et STT simulés, horloge simulée.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CaptureDeps, VoiceCapture } from "../src/capture.js";
import { VoicePriorityGate } from "../src/priority.js";

const ms = (n: number) => (n * 16000) / 1000;
const silence = (n: number) => new Int16Array(ms(n));
const speech = (n: number) => Int16Array.from({ length: ms(n) }, (_, i) => Math.round(5000 * Math.sin(i * 0.2)));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Une capture branchée sur la porte exactement comme dans `index.ts` (onState → porte, transcribe → porte.track). */
function rig(opts: { wakeOnCall?: number; stt?: () => Promise<string>; priority?: ConstructorParameters<typeof VoicePriorityGate>[0] } = {}) {
  const warnings: string[] = [];
  const gate = new VoicePriorityGate(opts.priority, (l) => warnings.push(l));
  let calls = 0;
  const deps: CaptureDeps = {
    detect: async () => (calls++ === (opts.wakeOnCall ?? -1) ? [{ model: "hey_jarvis", score: 0.9, atMs: 1000 }] : []),
    transcribe: (wav, mime) => gate.track(() => (opts.stt ?? (async () => "ok"))()),
    resetDetector: () => {},
    onState: (s) => gate.onCaptureState(s),
    onTranscript: () => {},
    onError: () => {},
  };
  const capture = new VoiceCapture(deps);
  return { gate, capture, warnings };
}

/** Une promesse dont on tient la clé (pour retenir la transcription). */
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

describe("fenêtre de priorité", () => {
  it("l'écoute passive ne compte JAMAIS : 10 minutes de blocs sans mot d'activation, aucune fenêtre", async () => {
    const { gate, capture } = rig();
    let everActive = false;
    for (let s = 0; s < 600; s++) {
      await capture.feed(silence(1000));
      vi.advanceTimersByTime(1000);
      everActive ||= gate.active;
    }
    expect(everActive).toBe(false);
    await expect(gate.whenIdle()).resolves.toBeUndefined();
  });

  it("le mot d'activation ouvre la fenêtre ; la fin de la transcription la ferme et réveille l'attente SANS délai", async () => {
    const stt = deferred<string>();
    const { gate, capture } = rig({ wakeOnCall: 0, stt: () => stt.promise });
    expect(gate.active).toBe(false);
    await capture.feed(silence(100)); // détection
    expect(capture.state()).toBe("recording");
    expect(gate.active).toBe(true);

    let released = false;
    void gate.whenIdle().then(() => (released = true));
    await capture.feed(speech(600));
    const ending = capture.feed(silence(1000)); // fin de parole → transcribing, STT retenu (ce bloc n'est rendu qu'à la fin)
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.state()).toBe("transcribing");
    expect(gate.active).toBe(true);
    expect(released).toBe(false);

    stt.resolve("bonjour");
    await ending;
    await vi.advanceTimersByTimeAsync(0); // aucun temps simulé ne s'écoule : reprise IMMÉDIATE
    expect(capture.state()).toBe("listening");
    expect(gate.active).toBe(false);
    expect(released).toBe(true);
  });

  it("une transcription qui ÉCHOUE referme la fenêtre (reprise garantie)", async () => {
    const stt = deferred<string>();
    const { gate, capture } = rig({ wakeOnCall: 0, stt: () => stt.promise });
    await capture.feed(silence(100));
    await capture.feed(speech(600));
    const ending = capture.feed(silence(1000));
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.active).toBe(true);
    let released = false;
    void gate.whenIdle().then(() => (released = true));
    stt.reject(new Error("WHISPER_DIED: test"));
    await ending;
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.state()).toBe("listening");
    expect(gate.active).toBe(false);
    expect(released).toBe(true);
  });

  it("l'abandon « aucune parole après le mot d'activation » referme la fenêtre", async () => {
    const { gate, capture } = rig({ wakeOnCall: 0 });
    await capture.feed(silence(100));
    expect(gate.active).toBe(true);
    for (let i = 0; i < 6; i++) await capture.feed(silence(1000)); // > noSpeechMs (5 s) de silence
    expect(capture.state()).toBe("listening");
    expect(gate.active).toBe(false);
  });

  it("cancel() referme la fenêtre", async () => {
    const { gate, capture } = rig({ wakeOnCall: 0 });
    await capture.feed(silence(100));
    expect(gate.active).toBe(true);
    capture.cancel();
    expect(gate.active).toBe(false);
  });
});

describe("garde-fous d'horloge (ne modifient pas l'état de la capture)", () => {
  it("flux du micro interrompu en pleine écoute : fermeture d'office à 20 s, avec avertissement", async () => {
    const { gate, capture, warnings } = rig({ wakeOnCall: 0 });
    await capture.feed(silence(100)); // recording ... puis plus aucun bloc
    let released = false;
    void gate.whenIdle().then(() => (released = true));
    await vi.advanceTimersByTimeAsync(19_900);
    expect(gate.active).toBe(true);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(gate.active).toBe(false);
    expect(released).toBe(true);
    expect(capture.state()).toBe("recording"); // la capture n'est pas touchée
    expect(warnings.join(" ")).toContain("fenêtre fermée d'office");
    expect(warnings.join(" ")).toContain("écoute (20000 ms)");
  });

  it("transcription qui ne rend pas la main : fermeture d'office à 130 s", async () => {
    const stt = deferred<string>(); // jamais résolue
    const { gate, capture, warnings } = rig({ wakeOnCall: 0, stt: () => stt.promise });
    await capture.feed(silence(100));
    await capture.feed(speech(600));
    void capture.feed(silence(1000)); // ne revient jamais : la transcription est bloquée
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.state()).toBe("transcribing");
    await vi.advanceTimersByTimeAsync(129_900);
    expect(gate.active).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(gate.active).toBe(false);
    expect(warnings.join(" ")).toContain("130000 ms");
  });

  it("plafonds réglables pour les tests", async () => {
    const { gate, capture } = rig({ wakeOnCall: 0, priority: { recordingCapMs: 1000 } });
    await capture.feed(silence(100));
    await vi.advanceTimersByTimeAsync(1100);
    expect(gate.active).toBe(false);
  });
});

describe("appels de transcription directs (bouton micro du chat, messages vocaux)", () => {
  it("la fenêtre couvre l'appel, et deux appels imbriqués la gardent ouverte jusqu'au dernier", async () => {
    const gate = new VoicePriorityGate();
    const a = deferred<string>();
    const b = deferred<string>();
    const pa = gate.track(() => a.promise);
    const pb = gate.track(() => b.promise);
    expect(gate.active).toBe(true);
    let released = false;
    void gate.whenIdle().then(() => (released = true));
    a.resolve("a");
    await pa;
    expect(gate.active).toBe(true);
    expect(released).toBe(false);
    b.reject(new Error("échec"));
    await expect(pb).rejects.toThrow("échec");
    expect(gate.active).toBe(false);
    expect(released).toBe(true);
  });

  it("un appel direct qui bloque est aussi plafonné à 130 s", async () => {
    const warnings: string[] = [];
    const gate = new VoicePriorityGate({}, (l) => warnings.push(l));
    void gate.track(() => new Promise<string>(() => {}));
    expect(gate.active).toBe(true);
    await vi.advanceTimersByTimeAsync(130_100);
    expect(gate.active).toBe(false);
    expect(warnings.join(" ")).toContain("appel de transcription");
  });
});

describe("réglages et attente", () => {
  it("enabled: false (condition témoin) : jamais active, aucune attente", async () => {
    const { gate, capture } = rig({ wakeOnCall: 0, priority: { enabled: false } });
    await capture.feed(silence(100));
    expect(capture.state()).toBe("recording");
    expect(gate.active).toBe(false);
    await expect(gate.whenIdle()).resolves.toBeUndefined();
    await gate.track(async () => 1);
    expect(gate.active).toBe(false);
  });

  it("whenIdle respecte l'annulation : rejette et ne laisse pas d'attente derrière lui", async () => {
    const { gate, capture } = rig({ wakeOnCall: 0 });
    await capture.feed(silence(100));
    const ac = new AbortController();
    const waiting = gate.whenIdle(ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow();
    capture.cancel(); // ne réveille personne d'oublié, ne lève rien
    expect(gate.active).toBe(false);
  });

  it("un signal déjà annulé rejette tout de suite quand la voix est active ; inactive, il résout", async () => {
    const { gate, capture } = rig({ wakeOnCall: 0 });
    const ac = new AbortController();
    ac.abort();
    await expect(gate.whenIdle(ac.signal)).resolves.toBeUndefined();
    await capture.feed(silence(100));
    await expect(gate.whenIdle(ac.signal)).rejects.toThrow();
  });

  it("dispose() libère les attentes", async () => {
    const { gate, capture } = rig({ wakeOnCall: 0 });
    await capture.feed(silence(100));
    let released = false;
    void gate.whenIdle().then(() => (released = true));
    gate.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(true);
  });
});
