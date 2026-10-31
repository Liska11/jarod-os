// Chaîne de synthèse vocale : ElevenLabs → Gemini TTS → voix locale (SAPI ou Piper). Jamais de silence : tant que la voix locale marche, quelque chose est dit.
// Mode « 100 % local » (qwen-flash.json, relu à chaque requête) : voix locale seulement, aucun appel réseau. Groq n'est pas utilisé ici (son TTS ne parle ni le français).
import { type SpeechOptions, type SpeechResult, SPEECH_MAX_CHARS } from "./speech.js";
import { type Pronunciation, spokenText } from "./speech-text.js";
import { elevenQuota, synthesizeWithElevenLabs } from "./tts-elevenlabs.js";
import { synthesizeWithGemini } from "./tts-gemini.js";
import { readLocalOnly, scrubSecrets } from "./voice-mode.js";

export type TtsProvider = "elevenlabs" | "gemini" | "local";
export type TtsResult = SpeechResult & { wav: Buffer; provider: TtsProvider };

export interface TtsChainDeps {
  /** La voix locale (SAPI ou Piper), rendue en WAV. */
  local: (text: string, opts: SpeechOptions) => Promise<SpeechResult & { wav: Buffer }>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  localOnly?: () => boolean;
  pronunciations?: readonly Pronunciation[];
  elevenlabs?: typeof synthesizeWithElevenLabs;
  gemini?: typeof synthesizeWithGemini;
  quota?: typeof elevenQuota;
}

const why = (e: unknown): string => (e as Error).message.split("\n")[0]!.slice(0, 200);

export async function synthesizeChain(text: string, opts: SpeechOptions, deps: TtsChainDeps): Promise<TtsResult> {
  const env = deps.env ?? process.env;
  const out = deps.log ?? ((l: string) => console.error(l));
  const log = (line: string) => out(scrubSecrets(line, env));
  const localOnly = (deps.localOnly ?? (() => readLocalOnly(env)))();
  if (localOnly) {
    log("[voix] synthèse : mode 100 % local actif — voix locale seulement, aucun appel réseau");
    const r = await deps.local(text, opts);
    log("[voix] synthèse : fournisseur=local");
    return { ...r, provider: "local" };
  }
  log("[voix] synthèse : mode normal (repli cloud actif)");
  const body = spokenText(String(text ?? ""), deps.pronunciations).trim();
  const spoken = body.length > SPEECH_MAX_CHARS ? body.slice(0, SPEECH_MAX_CHARS) : body;
  const done = (wav: Buffer, provider: TtsProvider): TtsResult => ({ chars: spoken.length, truncated: spoken.length < body.length, voice: opts.voice ?? "", wav, provider });
  const causes: string[] = [];

  if (spoken) {
    const quota = deps.quota ?? elevenQuota;
    try {
      const before = await quota(env);
      if (before && before.remaining < spoken.length) throw new Error(`quota ElevenLabs insuffisant (${before.remaining} caractères restants pour ${spoken.length} demandés)`);
      const wav = await (deps.elevenlabs ?? synthesizeWithElevenLabs)(spoken, opts.rate ?? 1, env);
      log("[voix] synthèse : fournisseur=elevenlabs");
      const after = await quota(env);
      log(
        after
          ? `[voix] ElevenLabs : ${after.remaining} caractères restants sur ${after.limit} ce mois-ci${after.remaining < after.limit * 0.1 ? " — QUOTA PRESQUE ÉPUISÉ" : ""}`
          : `[voix] ElevenLabs : compteur de caractères indisponible (${spoken.length} caractères envoyés)`,
      );
      return done(wav, "elevenlabs");
    } catch (e) {
      causes.push(`ElevenLabs : ${why(e)}`);
      log(`[voix] synthèse : ElevenLabs indisponible (${why(e)}) : repli sur Gemini TTS`);
    }
    try {
      const wav = await (deps.gemini ?? synthesizeWithGemini)(spoken, env);
      log("[voix] synthèse : fournisseur=gemini (repli)");
      return done(wav, "gemini");
    } catch (e) {
      causes.push(`Gemini TTS : ${why(e)}`);
      log(`[voix] synthèse : Gemini TTS indisponible (${why(e)}) : repli sur la voix locale`);
    }
  }
  try {
    const r = await deps.local(text, opts);
    log("[voix] synthèse : fournisseur=local (dernier recours)");
    return { ...r, provider: "local" };
  } catch (e) {
    causes.push(`voix locale : ${why(e)}`);
    throw new Error(`Synthèse vocale impossible — ${causes.join(" ; ")}.`);
  }
}
