// Voix de synthèse n°2 : Gemini TTS (génération audio native de l'API Gemini, même clé AI Studio que la dictée de repli : GEMINI_API_KEY).
// Modèle : JAROD_GEMINI_TTS_MODEL (défaut « gemini-2.5-flash-preview-tts ») ; voix : JAROD_GEMINI_TTS_VOICE (défaut « Kore »).
// L'API rend du PCM 16 bits mono (24 kHz), enveloppé ici en WAV.
import { apiKey, fetchCloud, pcmToWav } from "./cloud.js";
import { geminiFailure } from "./stt-gemini.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_TTS_TIMEOUT_MS = 30_000;

type Inline = { data?: string; mimeType?: string; mime_type?: string };
type Part = { inlineData?: Inline; inline_data?: Inline };

export async function synthesizeWithGemini(text: string, env: NodeJS.ProcessEnv = process.env, deps: { fetch?: typeof fetch } = {}): Promise<Buffer> {
  const key = apiKey(env, "GEMINI_API_KEY", "Gemini");
  const model = env.JAROD_GEMINI_TTS_MODEL?.trim() || "gemini-2.5-flash-preview-tts";
  const body = {
    contents: [{ parts: [{ text: `Lis ce texte en français, d'une voix d'homme naturelle : ${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.JAROD_GEMINI_TTS_VOICE?.trim() || "Orus" } } },
    },
  };
  const res = await fetchCloud(
    "Gemini",
    `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
    { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) },
    GEMINI_TTS_TIMEOUT_MS,
    deps.fetch,
  );
  const raw = await res.text();
  if (!res.ok) throw new Error(geminiFailure(res.status, raw));
  let parts: Part[];
  try {
    parts = (JSON.parse(raw) as { candidates?: { content?: { parts?: Part[] } }[] }).candidates?.[0]?.content?.parts ?? [];
  } catch {
    throw new Error("réponse Gemini illisible");
  }
  const inline = parts.map((p) => p.inlineData ?? p.inline_data).find((d) => d?.data);
  if (!inline?.data) throw new Error("Gemini n'a renvoyé aucun son");
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? inline.mime_type ?? "")?.[1] ?? 24_000);
  return pcmToWav(Buffer.from(inline.data, "base64"), rate);
}
