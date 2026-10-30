// Repli cloud de la dictée : l'API Gemini transcrit l'audio quand le whisper local ne répond pas (arrêté, trop lent, en erreur).
// La clé vient UNIQUEMENT de la variable d'environnement GEMINI_API_KEY (setx, jamais dans le code, les réglages ni le dépôt) ; elle part dans l'en-tête
// `x-goog-api-key`, jamais dans l'adresse. L'appel passe par la garde réseau du noyau (network-policy.json) comme tout fetch.
// Modèle : JAROD_GEMINI_STT_MODEL (défaut « gemini-flash-latest »).

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_TIMEOUT_MS = 30_000;

const PROMPT: Record<string, string> = {
  fr: "Transcris fidèlement cet enregistrement audio en français. Réponds uniquement par la transcription, sans commentaire ni guillemets.",
  en: "Transcribe this audio recording faithfully in English. Reply with the transcription only, without comment or quotation marks.",
};

const MIME: Record<string, string> = { "audio/wav": "audio/wav", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/mpeg": "audio/mp3", "audio/mp3": "audio/mp3", "audio/flac": "audio/flac", "audio/ogg": "audio/ogg", "audio/webm": "audio/webm", "audio/mp4": "audio/aac" };

export interface GeminiDeps {
  fetch?: typeof fetch;
}

/** Message lisible pour un échec de l'API Gemini ; ne contient jamais la clé. */
export function geminiFailure(status: number, body: string): string {
  const detail = (() => {
    try {
      return String((JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "").slice(0, 160);
    } catch {
      return body.slice(0, 160);
    }
  })();
  if (status === 429) return `quota Gemini dépassé (HTTP 429) — ${detail}`;
  if (status === 400 && /api key/i.test(detail)) return `clé Gemini invalide (HTTP 400) — vérifiez GEMINI_API_KEY`;
  if (status === 401 || status === 403) return `clé Gemini refusée ou sans droit (HTTP ${status}) — vérifiez GEMINI_API_KEY`;
  return `Gemini a répondu HTTP ${status} — ${detail}`;
}

export async function transcribeWithGemini(
  audio: Buffer,
  mime: string,
  language: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: GeminiDeps = {},
): Promise<string> {
  const key = env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY absente (variable d'environnement utilisateur, à définir avec setx puis relancer Jarod)");
  const model = env.JAROD_GEMINI_STT_MODEL?.trim() || "gemini-flash-latest";
  const type = MIME[mime.split(";")[0]!.trim()];
  if (!type) throw new Error(`format audio ${mime} non lu par Gemini`);
  const body = {
    contents: [{ parts: [{ text: PROMPT[language] ?? PROMPT.fr! }, { inline_data: { mime_type: type, data: audio.toString("base64") } }] }],
    generationConfig: { temperature: 0 },
  };
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError") throw new Error(`Gemini ne répond pas (délai de ${GEMINI_TIMEOUT_MS / 1000} s dépassé)`);
    // La garde réseau du noyau refuse avec un message qui nomme l'hôte ; sinon c'est l'absence de réseau.
    throw new Error(/réseau|network|refus|bloqu|policy/i.test(err.message) ? `connexion refusée par la politique réseau de Jarod (${err.message.slice(0, 120)})` : `pas de réseau vers Gemini (${err.message.slice(0, 120)})`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(geminiFailure(res.status, text));
  let parsed: { candidates?: { content?: { parts?: { text?: string }[] } }[]; promptFeedback?: { blockReason?: string } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error("réponse Gemini illisible");
  }
  const out = (parsed.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  if (!out) throw new Error(parsed.promptFeedback?.blockReason ? `Gemini a refusé l'audio (${parsed.promptFeedback.blockReason})` : "Gemini n'a renvoyé aucune transcription");
  return out;
}
