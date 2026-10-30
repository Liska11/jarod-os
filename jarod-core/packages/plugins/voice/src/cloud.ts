// Outils communs aux services vocaux cloud (Groq, ElevenLabs, Gemini TTS) : appel HTTP avec un message d'échec lisible qui ne contient jamais la clé.
// La clé ne vient que de variables d'environnement utilisateur (setx) et ne part que dans un en-tête, jamais dans l'adresse.

/** Appelle `url` ; remplace les erreurs réseau par une phrase qui dit lequel des trois cas : délai, politique réseau de Jarod, pas de réseau. */
export async function fetchCloud(name: string, url: string, init: RequestInit, timeoutMs: number, impl: typeof fetch = fetch): Promise<Response> {
  try {
    return await impl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError") throw new Error(`${name} ne répond pas (délai de ${timeoutMs / 1000} s dépassé)`);
    // La garde réseau du noyau refuse avec un message qui nomme l'hôte ; sinon c'est l'absence de réseau.
    throw new Error(/réseau|network|refus|bloqu|policy/i.test(err.message) ? `connexion à ${name} refusée par la politique réseau de Jarod (${err.message.slice(0, 120)})` : `pas de réseau vers ${name} (${err.message.slice(0, 120)})`);
  }
}

export function apiKey(env: NodeJS.ProcessEnv, variable: string, name: string): string {
  const key = env[variable]?.trim();
  if (!key) throw new Error(`${variable} absente (variable d'environnement utilisateur pour ${name}, à définir avec setx puis relancer Jarod)`);
  return key;
}

export function bodyDetail(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: string } | string; detail?: { message?: string; status?: string } | string };
    const e = j.error ?? j.detail;
    return (typeof e === "string" ? e : (e?.message ?? e?.status ?? "")).slice(0, 160);
  } catch {
    return body.slice(0, 160);
  }
}

/** PCM 16 bits little-endian mono → fichier WAV (en-tête RIFF de 44 octets). */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
