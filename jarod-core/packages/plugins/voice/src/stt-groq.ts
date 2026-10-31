// Dictée cloud n°2 : Groq (whisper-large-v3-turbo, point d'accès compatible OpenAI), tenté quand le whisper local échoue ou dépasse 5 s.
// Clé : GROQ_API_KEY (variable d'environnement utilisateur, jamais dans le code, les réglages ni le dépôt), en-tête Authorization.
// Modèle : JAROD_GROQ_STT_MODEL (défaut « whisper-large-v3-turbo »).
import { apiKey, bodyDetail, fetchCloud } from "./cloud.js";

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_TIMEOUT_MS = 15_000;
const EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/flac": "flac" };

export function groqFailure(status: number, body: string): string {
  const detail = bodyDetail(body);
  if (status === 429) return `quota Groq dépassé (HTTP 429) — ${detail}`;
  if (status === 401 || status === 403) return `clé Groq invalide ou refusée (HTTP ${status}) — vérifiez GROQ_API_KEY`;
  return `Groq a répondu HTTP ${status} — ${detail}`;
}

export async function transcribeWithGroq(audio: Buffer, mime: string, language: string, env: NodeJS.ProcessEnv = process.env, deps: { fetch?: typeof fetch } = {}): Promise<string> {
  const key = apiKey(env, "GROQ_API_KEY", "Groq");
  const base = mime.split(";")[0]!.trim();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: base }), `dictee.${EXT[base] ?? "webm"}`);
  form.append("model", env.JAROD_GROQ_STT_MODEL?.trim() || "whisper-large-v3-turbo");
  form.append("language", language);
  form.append("temperature", "0");
  form.append("response_format", "json");
  const res = await fetchCloud("Groq", ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form }, GROQ_TIMEOUT_MS, deps.fetch);
  const text = await res.text();
  if (!res.ok) throw new Error(groqFailure(res.status, text));
  let out: string;
  try {
    out = String((JSON.parse(text) as { text?: string }).text ?? "").trim();
  } catch {
    throw new Error("réponse Groq illisible");
  }
  if (!out) throw new Error("Groq n'a renvoyé aucune transcription");
  return out;
}
