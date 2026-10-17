import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Racine du dépôt. */
export const ROOT = resolve(here, "../../../../../..");
export const PY_DIR = join(ROOT, "engines", "py", "Scripts");
export const PY = join(PY_DIR, "python.exe");
export const HAS_PY = existsSync(PY);
export const SIDECARS = join(ROOT, "jarod-core", "sidecars");
export const FIXTURES = here;

if (!HAS_PY) console.warn(`[moteurs] ${PY} absent : les tests Python réels sont ignorés. Créer le venv : uv venv engines/py --python 3.12 puis uv pip install -r jarod-core/engines.lock/py312-requirements.txt`);

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Synthèse vocale Windows (SAPI) vers un WAV 16 kHz, 16 bits, mono. Voix de la machine : le texte est fabriqué. */
export function synthSpeech(text: string, wavPath: string, voice?: string): void {
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voice ? `$s.SelectVoice('${voice}');` : ""} $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}', $f); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 60_000 });
}

/** PCM 16 bits d'un WAV, en flottants [-1, 1]. */
export function readWavPcm16(wavPath: string): Float32Array {
  const buf = readFileSync(wavPath);
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "data") {
      const n = Math.floor(Math.min(size, buf.length - pos - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(pos + 8 + i * 2) / 32768;
      return out;
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("WAV sans bloc data");
}
