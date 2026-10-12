/**
 * Capture vocale continue (W10) : canaux PROPRES à Jarod (`JAROD_INVOKE_CHANNELS`, absents de hermesAPI).
 * Le renderer capte le micro (AudioWorklet, 16 kHz mono int16) et pousse des blocs par `voice-capture-feed` ;
 * le kernel (plugin-voice `capture.ts`) fait mot d'activation (NPU) → enregistrement → whisper.cpp (iGPU) ;
 * `bindVoiceEvents` relaie `voice:state|transcript|error` du kernel vers la fenêtre.
 */
import { assertProfile, type HandlerContext } from "./context.js";

/** Au plus 1 s d'audio par bloc : le renderer envoie des blocs de 80 ms. */
const MAX_SAMPLES = 16_000;

function toPcm(input: unknown): Int16Array {
  if (input instanceof Int16Array) return input;
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (bytes.byteLength % 2) throw new Error("[oneai] voice-capture-feed : PCM int16 attendu (nombre d'octets impair)");
    return new Int16Array(bytes.slice().buffer);
  }
  throw new Error("[oneai] voice-capture-feed : PCM int16 attendu");
}

export function createVoiceHandlers(ctx: HandlerContext) {
  const capture = () => {
    const c = ctx.kernel().voice?.capture;
    if (!c) throw new Error("[oneai] capture vocale non configurée (plugin voice : `wakeword`)");
    return c;
  };
  return {
    "voice-capture-feed": async (pcm: unknown, profile?: unknown): Promise<string> => {
      assertProfile(ctx, profile);
      const samples = toPcm(pcm);
      if (samples.length > MAX_SAMPLES) throw new Error(`[oneai] voice-capture-feed : bloc trop long (${samples.length} > ${MAX_SAMPLES})`);
      return capture().feed(samples);
    },
    "voice-capture-status": (): { enabled: boolean; state: string | null; words: string[]; devices: Record<string, string> } => {
      const v = ctx.kernel().voice;
      const ww = v?.wakeword ?? null;
      return {
        enabled: Boolean(v?.capture),
        state: v?.capture?.state() ?? null,
        words: ww?.words() ?? [],
        devices: ww?.metrics().devices ?? {},
      };
    },
  };
}

/** Événements kernel → fenêtre. Rend la désinscription. */
export function bindVoiceEvents(
  app: { on(name: string, cb: (...args: never[]) => void): () => void },
  send: (channel: string, ...args: unknown[]) => void,
): () => void {
  const offs = [
    app.on("voice:state", (state: string, info?: { reason?: string }) => send("voice-state", state, info ?? null)),
    app.on("voice:transcript", (t: unknown) => send("voice-transcript", t)),
    app.on("voice:error", (e: { message: string }) => send("voice-error", e.message)),
  ];
  return () => {
    for (const off of offs) off();
  };
}
