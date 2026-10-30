// Portage de packages/core/src/services/voice.ts (rév. 2e180305).
import type { ProviderRouter } from "@jarod/plugin-llm";
import { secretKeyFor } from "@jarod/plugin-llm";
import type { SettingsService } from "@jarod/plugin-storage";
import { transcribeWithGemini } from "./stt-gemini.js";
import { transcribeWithGroq } from "./stt-groq.js";
import { readLocalOnly, scrubSecrets } from "./voice-mode.js";

/** Providers exposing an OpenAI-compatible `/audio/transcriptions` endpoint, with a sensible default model. */
export const STT_DEFAULTS: Record<string, string> = {
  openai: "whisper-1",
  groq: "whisper-large-v3-turbo",
  custom: "whisper-1",
  lmstudio: "whisper-1",
  vllm: "whisper-1",
  // Jarod-cordis (G3) : whisper.cpp local, sans clé (plugin-voice, `whisper-server.ts`).
  "local-whisper-cpp": "large-v3-turbo",
  "local-openvino-stt": "whisper-fr",
  "local-omni-stt": "omni",
  // whisper.cpp CPU (large-v3-turbo q5_0, port 8090, lean-qwenflash) : dictée par défaut, avec repli Gemini (stt-gemini.ts).
  "local-whisper-cpu": "large-v3-turbo-q5_0",
};

/** Au-delà, le whisper local est tenu pour en panne et la dictée passe au repli cloud (Groq, puis Gemini). */
export const LOCAL_STT_TIMEOUT_MS = 5_000;

const OMNI_LANGUAGES: Record<string, string> = { fr: "French", en: "English" };

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/** Délai de la dictée locale seule (mode 100 % local) : pas de repli possible, on laisse le temps d'un modèle froid. */
export const LOCAL_ONLY_STT_TIMEOUT_MS = 30_000;

export interface TranscribeDeps {
  groq?: typeof transcribeWithGroq;
  gemini?: typeof transcribeWithGemini;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Mode « 100 % local » (relu à chaque requête) ; absent = lu dans qwen-flash.json. */
  localOnly?: () => boolean;
}

/**
 * Speech-to-text through the configured Whisper-compatible provider. Avec « local-whisper-cpu » : chaîne whisper local (défaut, la voix ne quitte pas le PC)
 * → Groq (si le local échoue ou dépasse 5 s) → Gemini (si Groq échoue aussi). Mode « 100 % local » : whisper local seul, jamais d'appel réseau.
 * Chaque requête journalise le mode et le fournisseur qui a répondu ; si toute la chaîne échoue, l'erreur dit les trois causes.
 */
export async function transcribe(router: ProviderRouter, settings: SettingsService, audio: Buffer, mime: string, deps: TranscribeDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const out = deps.log ?? ((line: string) => console.error(line));
  const log = (line: string) => out(scrubSecrets(line, env));
  const localOnly = (deps.localOnly ?? (() => readLocalOnly(env)))();
  const provider = settings.get("voice").sttProvider;
  if (provider !== "local-whisper-cpu") {
    // Hors chaîne : le fournisseur choisi tel quel — sauf en mode 100 % local, où un fournisseur qui sort de la machine est refusé.
    if (localOnly && !router.def(provider).local)
      throw new Error(`Mode 100 % local actif : la dictée par ${router.def(provider).name} enverrait la voix hors de ce PC. Choisissez le whisper local (Réglages › Voix) ou désactivez le mode 100 % local.`);
    log(`[voix] dictée : mode ${localOnly ? "100 % local" : "normal"}, fournisseur=${provider}`);
    return transcribeDirect(router, settings, audio, mime, 120_000);
  }
  if (localOnly) {
    log("[voix] dictée : mode 100 % local actif — whisper local seulement, aucun appel réseau");
    const text = await transcribeDirect(router, settings, audio, mime, LOCAL_ONLY_STT_TIMEOUT_MS);
    log("[voix] dictée : fournisseur=whisper-local");
    return text;
  }
  log("[voix] dictée : mode normal (repli cloud actif)");
  const short = (e: unknown) => (e as Error).message.split("\n")[0]!.slice(0, 200);
  try {
    const text = await transcribeDirect(router, settings, audio, mime, LOCAL_STT_TIMEOUT_MS);
    log("[voix] dictée : fournisseur=whisper-local");
    return text;
  } catch (local) {
    log(`[voix] dictée : whisper local indisponible (${short(local)}) : repli sur Groq`);
    const language = settings.get("language");
    try {
      const text = await (deps.groq ?? transcribeWithGroq)(audio, mime, language, env);
      log("[voix] dictée : fournisseur=groq (repli)");
      return text;
    } catch (groq) {
      log(`[voix] dictée : Groq indisponible (${short(groq)}) : repli sur Gemini`);
      try {
        const text = await (deps.gemini ?? transcribeWithGemini)(audio, mime, language, env);
        log("[voix] dictée : fournisseur=gemini (repli)");
        return text;
      } catch (gemini) {
        throw new Error(`Dictée impossible : whisper local (${short(local)}), Groq (${short(groq)}) et Gemini (${short(gemini)}) ont tous échoué.`);
      }
    }
  }
}

async function transcribeDirect(
  router: ProviderRouter,
  settings: SettingsService,
  audio: Buffer,
  mime: string,
  timeoutMs: number,
): Promise<string> {
  const { sttProvider, sttModel } = settings.get("voice");
  if (sttProvider === "local-omni-stt") return transcribeWithOmni(settings, audio, mime, sttModel);
  const def = router.def(sttProvider);
  if (def.protocol !== "openai")
    throw new Error(
      `${def.name} ne propose pas de transcription audio. Choisissez OpenAI, Groq ou un serveur compatible.`,
    );
  const key = settings.getSecret(secretKeyFor(sttProvider));
  if (!key && !def.local) throw new Error(`Aucune clé API pour ${def.name} (nécessaire pour la dictée).`);
  const base = mime.split(";")[0]!.trim();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: base }), `dictee.${EXT[base] ?? "webm"}`);
  form.append("model", sttModel || STT_DEFAULTS[sttProvider] || "whisper-1");
  const lang = settings.get("language");
  form.append("language", lang);
  const url = `${def.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: key ? { authorization: `Bearer ${key}` } : {}, body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // « fetch failed » ne disait rien : on nomme le service et l'adresse qui ne répondent pas.
    const why = (e as Error).name === "TimeoutError" ? "délai dépassé" : "aucune réponse";
    throw new Error(`Dictée impossible : ${def.name} ne répond pas (${why}, ${def.baseUrl}).${def.local ? " Ce service local n'est pas démarré ou pas installé : choisissez un autre fournisseur dans Réglages › Voix." : ""}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Transcription échouée (HTTP ${res.status}) : ${text.slice(0, 300)}`);
  let parsed: { text?: string; error?: string };
  try {
    parsed = JSON.parse(text) as { text?: string; error?: string };
  } catch {
    return text.trim();
  }
  // Le serveur local répond 200 avec `error` quand aucun appareil ne peut transcrire : c'est une erreur, pas une phrase vide.
  if (parsed.error) throw new Error(`Transcription échouée : ${parsed.error}`);
  return String(parsed.text ?? "").trim();
}

/**
 * Dictée par le modèle omni du moteur local (LFM3-Omni) : l'audio part dans une requête de conversation, avec la consigne « Perform ASR in
 * <langue> » de la fiche du modèle. Le moteur ne lit que le wav, le mp3 et le flac (la fenêtre envoie du wav).
 */
export async function transcribeWithOmni(settings: SettingsService, audio: Buffer, mime: string, model: string): Promise<string> {
  const format = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/flac": "flac" }[mime.split(";")[0]!.trim()];
  if (!format) throw new Error(`Dictée par le modèle omni : le format ${mime} n'est pas lu (wav, mp3 ou flac seulement).`);
  const port = settings.get("localEngine")?.port ?? 8080;
  const language = OMNI_LANGUAGES[settings.get("language")] ?? "French";
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model || "omni",
        temperature: 0,
        max_tokens: 400,
        messages: [
          { role: "system", content: `Perform ASR in ${language}.` },
          { role: "user", content: [{ type: "input_audio", input_audio: { data: audio.toString("base64"), format } }] },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    const why = (e as Error).name === "TimeoutError" ? "délai dépassé" : "aucune réponse";
    throw new Error(`Dictée impossible : le modèle omni local ne répond pas (${why}, port ${port}). Le moteur local est-il démarré avec LFM3-Omni (Réglages › Modèles locaux) ?`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Transcription échouée (HTTP ${res.status}) : ${text.slice(0, 300)}`);
  const content = (JSON.parse(text) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Transcription échouée : réponse du modèle omni illisible.");
  return content.trim();
}
