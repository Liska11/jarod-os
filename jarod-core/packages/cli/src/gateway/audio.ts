// Passerelle compatible Hermes : la voix du shell. La conversation vocale de Herald envoie un énoncé à transcrire (`POST /api/audio/transcribe`) et demande la voix d'une réponse
// (`POST /api/audio/speak`) ; le noyau de Jarod fait l'un par son fournisseur de transcription (OpenAI, Groq, whisper.cpp local…) et l'autre par la voix de la machine
// (SAPI, ou Piper), rendue en WAV : la fenêtre la joue. Le flux phrase par phrase (`speak-stream`) n'est pas servi : il répond « repli » et la fenêtre dit la réponse entière.
export interface VoicePort {
  /** Transcription de l'énoncé par le fournisseur des réglages ; lève avec ses propres mots (pas de clé, serveur absent…). */
  transcribe(audio: Buffer, mime: string): Promise<string>;
  /** La voix de la machine en octets WAV. */
  synthesize(text: string): Promise<Buffer>;
}

/** Un énoncé de 5 minutes en WAV 16 kHz mono fait 9,6 Mo : 25 Mo laissent de la marge sans laisser un envoi sans fin. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** La taille d'un corps JSON qui porte cet audio en base64 (4/3) avec une petite marge. */
export const MAX_AUDIO_BODY = Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4096;
export const MAX_SPEAK_CHARS = 5000;

const AUDIO_MIMES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/mp3", "audio/flac"]);

export class AudioError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** `data:<mime>[;codecs=…];base64,<données>` → octets. Tout autre forme est refusée, comme une taille hors bornes. */
export function parseDataUrl(dataUrl: unknown, declaredMime?: unknown): { mime: string; bytes: Buffer } {
  if (typeof dataUrl !== "string") throw new AudioError(400, "data_url attendu (texte)");
  const m = /^data:([^;,]*)((?:;[^;,=]+=[^;,]*)*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!m) throw new AudioError(400, "data_url : « data:audio/…;base64,… » attendu");
  const mime = (m[1] || (typeof declaredMime === "string" ? declaredMime : "")).split(";")[0]!.trim().toLowerCase();
  if (!AUDIO_MIMES.has(mime)) throw new AudioError(415, `format audio non pris en charge : ${mime || "inconnu"}`);
  const bytes = Buffer.from(m[3]!, "base64");
  if (bytes.length === 0) throw new AudioError(400, "audio vide");
  if (bytes.length > MAX_AUDIO_BYTES) throw new AudioError(413, "audio trop long");
  return { mime, bytes };
}

export function wavDataUrl(wav: Buffer): string {
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}

/** Le texte d'une réponse à dire : texte non vide, borné. */
export function speakText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new AudioError(400, "text attendu (texte non vide)");
  if (value.length > MAX_SPEAK_CHARS) throw new AudioError(413, `texte trop long (${MAX_SPEAK_CHARS} caractères au plus)`);
  return value;
}
