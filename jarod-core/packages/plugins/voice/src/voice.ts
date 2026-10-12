// Portage de packages/core/src/services/voice.ts (rév. 2e180305).
import type { ProviderRouter } from "@jarod/plugin-llm";
import { secretKeyFor } from "@jarod/plugin-llm";
import type { SettingsService } from "@jarod/plugin-storage";

/** Providers exposing an OpenAI-compatible `/audio/transcriptions` endpoint, with a sensible default model. */
export const STT_DEFAULTS: Record<string, string> = {
  openai: "whisper-1",
  groq: "whisper-large-v3-turbo",
  custom: "whisper-1",
  lmstudio: "whisper-1",
  vllm: "whisper-1",
  // Jarod-cordis (G3) : whisper.cpp local, sans clé (plugin-voice, `whisper-server.ts`).
  "local-whisper-cpp": "large-v3-turbo",
};

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/** Speech-to-text through the configured Whisper-compatible provider. */
export async function transcribe(
  router: ProviderRouter,
  settings: SettingsService,
  audio: Buffer,
  mime: string,
): Promise<string> {
  const { sttProvider, sttModel } = settings.get("voice");
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
  const res = await fetch(`${def.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Transcription échouée (HTTP ${res.status}) : ${text.slice(0, 300)}`);
  try {
    return String((JSON.parse(text) as { text?: string }).text ?? "").trim();
  } catch {
    return text.trim();
  }
}
