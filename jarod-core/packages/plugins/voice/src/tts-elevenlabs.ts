// Voix de synthèse n°1 : ElevenLabs (palier gratuit : 10 000 caractères par mois). Clé : ELEVENLABS_API_KEY (variable d'environnement utilisateur).
// Voix : JAROD_ELEVENLABS_VOICE_ID (défaut : une voix de base, utilisable avec le palier gratuit) ; modèle : JAROD_ELEVENLABS_MODEL
// (défaut « eleven_multilingual_v2 », français naturel). L'audio demandé est du PCM 24 kHz, enveloppé ici en WAV (la fenêtre joue du WAV).
// Compteur : `GET /v1/user/subscription` (caractères utilisés / limite) est lu avant et après chaque synthèse et journalisé ; indisponible si la clé n'a pas le droit « user_read ».
import { apiKey, bodyDetail, fetchCloud, pcmToWav } from "./cloud.js";

const BASE = "https://api.elevenlabs.io/v1";
export const ELEVENLABS_TIMEOUT_MS = 20_000;
export const ELEVENLABS_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

export interface ElevenQuota {
  used: number;
  limit: number;
  remaining: number;
}

export function elevenFailure(status: number, body: string): string {
  const detail = bodyDetail(body);
  if (status === 429 || /quota_exceeded/i.test(body)) return `quota ElevenLabs atteint (HTTP ${status}) — ${detail}`;
  if (status === 401 && /invalid_api_key|api key/i.test(body)) return `clé ElevenLabs invalide (HTTP 401) — vérifiez ELEVENLABS_API_KEY`;
  if (status === 401 || status === 403) return `clé ElevenLabs refusée ou sans droit (HTTP ${status}) — ${detail}`;
  if (status === 402) return `voix ou fonction réservée aux forfaits payants (HTTP 402) — ${detail}`;
  return `ElevenLabs a répondu HTTP ${status} — ${detail}`;
}

/** Caractères restants ce mois-ci, ou null si le compteur n'est pas lisible (jamais une erreur : c'est un indicateur). */
export async function elevenQuota(env: NodeJS.ProcessEnv = process.env, deps: { fetch?: typeof fetch } = {}): Promise<ElevenQuota | null> {
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetchCloud("ElevenLabs", `${BASE}/user/subscription`, { headers: { "xi-api-key": key } }, 4_000, deps.fetch);
    if (!res.ok) return null;
    const j = (await res.json()) as { character_count?: number; character_limit?: number };
    if (typeof j.character_count !== "number" || typeof j.character_limit !== "number") return null;
    return { used: j.character_count, limit: j.character_limit, remaining: Math.max(0, j.character_limit - j.character_count) };
  } catch {
    return null;
  }
}

export async function synthesizeWithElevenLabs(text: string, rate: number, env: NodeJS.ProcessEnv = process.env, deps: { fetch?: typeof fetch } = {}): Promise<Buffer> {
  const key = apiKey(env, "ELEVENLABS_API_KEY", "ElevenLabs");
  const voice = env.JAROD_ELEVENLABS_VOICE_ID?.trim() || ELEVENLABS_DEFAULT_VOICE;
  const body: Record<string, unknown> = { text, model_id: env.JAROD_ELEVENLABS_MODEL?.trim() || "eleven_multilingual_v2" };
  // L'API borne la vitesse à 0,7–1,2.
  if (rate !== 1) body.voice_settings = { stability: 0.5, similarity_boost: 0.75, speed: Math.max(0.7, Math.min(1.2, rate)) };
  const res = await fetchCloud(
    "ElevenLabs",
    `${BASE}/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_24000`,
    { method: "POST", headers: { "content-type": "application/json", "xi-api-key": key }, body: JSON.stringify(body) },
    ELEVENLABS_TIMEOUT_MS,
    deps.fetch,
  );
  if (!res.ok) throw new Error(elevenFailure(res.status, await res.text()));
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length < 480) throw new Error("ElevenLabs n'a renvoyé aucun son");
  return pcmToWav(pcm, 24_000);
}
