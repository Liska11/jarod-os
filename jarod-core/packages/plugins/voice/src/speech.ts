// Portage de packages/core/src/services/speech.ts (rév. 2e180305) — verbatim, sauf `findOnPath` (@jarod/kernel/find-on-path) et le moteur Piper (Jarod-cordis, PLAN §4.3), balisé « Piper ».
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOnPath } from "@jarod/kernel/find-on-path";

/**
 * Read in one go. An answer longer than this is cut, and the caller is told: speaking four pages
 * out loud is not the same service as reading the beginning of them.
 */
export const SPEECH_MAX_CHARS = 1500;

/** Words per minute at rate 1. The engines' own default, so "normal" stays what it sounds like. */
const BASE_WPM = 175;

export interface SpeechOptions {
  /** Voice name as the engine reports it ("" = the engine's default). */
  voice?: string;
  /** 1 = normal speed, like the engines' own dial. */
  rate?: number;
}

export interface SpeechResult {
  chars: number;
  truncated: boolean;
  voice: string;
}

/** The little of a child process this service needs; a test replaces the launcher, not the engine. */
export interface SpeechChild {
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): void } | null;
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): void } | null;
  on(event: "close" | "error", listener: (value: unknown) => void): void;
  kill(): void;
}

export type SpeechSpawn = (command: string, args: string[], env: NodeJS.ProcessEnv) => SpeechChild;

/**
 * Piper (PLAN §4.3, Jarod-cordis) : moteur neuronal local sur CPU, pour une voix moins « robot
 * système ». Chemins EXPLICITES (config du plugin voice), jamais devinés : le binaire `piper` et, par
 * voix, son modèle `.onnx` (le `.onnx.json` à côté). Une voix Piper s'appelle `piper:<nom>` dans la
 * liste des voix et dans le réglage `voice.ttsVoice` — le DTO des réglages ne change pas.
 */
export interface PiperConfig {
  bin: string;
  voices: Record<string, string>;
}

export const PIPER_VOICE_PREFIX = "piper:";

export interface SpeechDeps {
  spawn?: SpeechSpawn;
  /** Piper ; absent = moteur de l'OS seul (comportement de la source). */
  piper?: PiperConfig;
  /** Where the text file waits for the engine. */
  tmpDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

interface Engine {
  kind: "sapi" | "say" | "espeak";
  command: string;
  /** Shown to the user: what will speak. */
  label: string;
}

const defaultSpawn: SpeechSpawn = (command, args, env) =>
  spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) as SpeechChild;

/**
 * Windows reads the text from the file and everything variable from the environment, so the command
 * line carries nothing but this constant: no length limit, no quoting, no code page turning French
 * accents into mojibake, and a voice name that contains a quote is just a name.
 */
const SAPI_SPEAK = [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "if ($env:JAROD_TTS_VOICE) { $s.SelectVoice($env:JAROD_TTS_VOICE) }",
  "if ($env:JAROD_TTS_RATE) { $s.Rate = [int]$env:JAROD_TTS_RATE }",
  "$s.Speak([IO.File]::ReadAllText($env:JAROD_TTS_TEXT, [Text.Encoding]::UTF8))",
  "$s.Dispose()",
].join("; ");

/** Comme SAPI_SPEAK, mais la voix va dans un fichier WAV (Jarod-OS : le noyau n'a pas de haut-parleur, la fenêtre joue le son). */
const SAPI_SYNTHESIZE = [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "if ($env:JAROD_TTS_VOICE) { $s.SelectVoice($env:JAROD_TTS_VOICE) }",
  "if ($env:JAROD_TTS_RATE) { $s.Rate = [int]$env:JAROD_TTS_RATE }",
  "$s.SetOutputToWaveFile($env:JAROD_TTS_WAV)",
  "$s.Speak([IO.File]::ReadAllText($env:JAROD_TTS_TEXT, [Text.Encoding]::UTF8))",
  "$s.Dispose()",
].join("; ");

const SAPI_VOICES = [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }",
  "$s.Dispose()",
].join("; ");

/**
 * Speech out loud through the machine's own engine — SAPI on Windows, `say` on macOS, `espeak-ng`
 * on Linux. Local by construction: no key, no request, and it works with the network off.
 */
export class SpeechService {
  private child: SpeechChild | null = null;
  private textFile: string | null = null;
  private detected: Engine | null | undefined;
  /** Piper : chaque lecture/arrêt change de génération (une synthèse finie après un `stop()` ne joue pas). */
  private generation = 0;

  constructor(private readonly d: SpeechDeps = {}) {}

  private platform(): NodeJS.Platform {
    return this.d.platform ?? process.platform;
  }

  private env(): NodeJS.ProcessEnv {
    return this.d.env ?? process.env;
  }

  /** What will speak here, or null. Detected once: a machine does not grow a voice engine. */
  engine(): Engine | null {
    if (this.detected === undefined) this.detected = this.detect();
    return this.detected;
  }

  private detect(): Engine | null {
    const platform = this.platform();
    const find = (cmd: string) => findOnPath(cmd, this.env(), platform);
    if (platform === "win32") {
      // Windows PowerShell carries System.Speech; PowerShell 7 may not have it, so it comes second.
      for (const exe of ["powershell.exe", "pwsh.exe"]) {
        const command = find(exe);
        if (command) return { kind: "sapi", command, label: `SAPI (${exe})` };
      }
      return null;
    }
    if (platform === "darwin") {
      const command = find("say");
      return command ? { kind: "say", command, label: "say" } : null;
    }
    const command = find("espeak-ng") ?? find("espeak");
    return command ? { kind: "espeak", command, label: command.split(/[\\/]/).pop() ?? "espeak" } : null;
  }

  available(): boolean {
    return this.engine() !== null || this.piperVoices().length > 0;
  }

  /** Piper : les voix dont le binaire ET le modèle existent (une voix annoncée doit pouvoir parler). */
  private piperVoices(): string[] {
    const p = this.d.piper;
    if (!p || !existsSync(p.bin)) return [];
    return Object.entries(p.voices)
      .filter(([, model]) => existsSync(model))
      .map(([name]) => `${PIPER_VOICE_PREFIX}${name}`);
  }

  busy(): boolean {
    return this.child !== null;
  }

  /** The voices of the installed engine, as the engine names them. Empty when there is none. */
  async voices(): Promise<string[]> {
    return [...(await this.osVoices()), ...this.piperVoices()];
  }

  private async osVoices(): Promise<string[]> {
    const engine = this.engine();
    if (!engine) return [];
    const args =
      engine.kind === "sapi"
        ? ["-NoProfile", "-NonInteractive", "-Command", SAPI_VOICES]
        : engine.kind === "say"
          ? ["-v", "?"]
          : ["--voices"];
    try {
      const out = await run(engine.command, args, this.env(), this.d.spawn ?? defaultSpawn);
      return parseVoices(engine.kind, out);
    } catch {
      // A list that cannot be read is not a reason to refuse to speak: the engine still has a default.
      return [];
    }
  }

  /**
   * Speaks `text` and resolves when the engine is done. Anything already speaking is stopped first:
   * two voices at once is never what was asked for.
   */
  async speak(text: string, opts: SpeechOptions = {}): Promise<SpeechResult> {
    if (String(opts.voice ?? "").trim().startsWith(PIPER_VOICE_PREFIX)) return this.speakPiper(text, opts);
    const engine = this.engine();
    if (!engine) throw new Error("SPEECH_NO_ENGINE: aucun moteur vocal sur cette machine.");
    const body = String(text ?? "").trim();
    if (!body) throw new Error("SPEECH_EMPTY: rien à lire.");
    const rate = normaliseRate(opts.rate);
    const spoken = body.length > SPEECH_MAX_CHARS ? body.slice(0, SPEECH_MAX_CHARS) : body;
    const voice = String(opts.voice ?? "").trim();
    if (voice && engine.kind !== "sapi" && /[\r\n]/.test(voice)) throw new Error("SPEECH_BAD_VOICE");

    await this.stop();

    const file = join(this.d.tmpDir ?? tmpdir(), `jarod-speech-${randomUUID()}.txt`);
    writeFileSync(file, spoken, "utf8");
    this.textFile = file;

    const env: NodeJS.ProcessEnv = { ...this.env() };
    const args: string[] = [];
    if (engine.kind === "sapi") {
      env.JAROD_TTS_TEXT = file;
      env.JAROD_TTS_VOICE = voice;
      // SAPI wants -10..10 where 0 is normal speed; the setting is a multiplier around 1.
      env.JAROD_TTS_RATE = String(Math.max(-10, Math.min(10, Math.round((rate - 1) * 10))));
      args.push("-NoProfile", "-NonInteractive", "-Command", SAPI_SPEAK);
    } else if (engine.kind === "say") {
      args.push("-f", file, "-r", String(Math.round(BASE_WPM * rate)));
      if (voice) args.push("-v", voice);
    } else {
      args.push("-f", file, "-s", String(Math.round(BASE_WPM * rate)));
      if (voice) args.push("-v", voice);
    }

    const child = (this.d.spawn ?? defaultSpawn)(engine.command, args, env);
    this.child = child;
    try {
      await waitFor(child, engine);
    } finally {
      if (this.child === child) this.child = null;
      this.dropFile();
    }
    return { chars: spoken.length, truncated: spoken.length < body.length, voice };
  }

  /**
   * La voix en octets WAV au lieu du haut-parleur : ce que `speak` dirait, rendu en fichier. Piper (voix `piper:<nom>`) et SAPI (Windows) ; macOS et Linux n'ont pas de
   * sortie WAV vérifiée ici : refus nommé plutôt qu'un format inattendu.
   */
  async synthesize(text: string, opts: SpeechOptions = {}): Promise<SpeechResult & { wav: Buffer }> {
    const wavPath = join(this.d.tmpDir ?? tmpdir(), `jarod-speech-${randomUUID()}.wav`);
    try {
      let result: SpeechResult;
      if (String(opts.voice ?? "").trim().startsWith(PIPER_VOICE_PREFIX)) {
        result = await this.synthesizePiper(text, opts, wavPath);
      } else {
        const engine = this.engine();
        if (!engine) throw new Error("SPEECH_NO_ENGINE: aucun moteur vocal sur cette machine.");
        if (engine.kind !== "sapi") throw new Error("SPEECH_NO_WAV: la sortie en fichier n'est pas prise en charge avec ce moteur vocal (Windows ou voix Piper).");
        const body = String(text ?? "").trim();
        if (!body) throw new Error("SPEECH_EMPTY: rien à lire.");
        const rate = normaliseRate(opts.rate);
        const spoken = body.length > SPEECH_MAX_CHARS ? body.slice(0, SPEECH_MAX_CHARS) : body;
        const voice = String(opts.voice ?? "").trim();
        await this.stop();
        const file = join(this.d.tmpDir ?? tmpdir(), `jarod-speech-${randomUUID()}.txt`);
        writeFileSync(file, spoken, "utf8");
        this.textFile = file;
        const env: NodeJS.ProcessEnv = { ...this.env(), JAROD_TTS_TEXT: file, JAROD_TTS_WAV: wavPath, JAROD_TTS_VOICE: voice, JAROD_TTS_RATE: String(Math.max(-10, Math.min(10, Math.round((rate - 1) * 10)))) };
        const child = (this.d.spawn ?? defaultSpawn)(engine.command, ["-NoProfile", "-NonInteractive", "-Command", SAPI_SYNTHESIZE], env);
        this.child = child;
        try {
          await waitFor(child, engine);
        } finally {
          if (this.child === child) this.child = null;
          this.dropFile();
        }
        result = { chars: spoken.length, truncated: spoken.length < body.length, voice };
      }
      if (!existsSync(wavPath)) throw new Error("SPEECH_ENGINE_FAILED: le moteur n'a rien écrit.");
      return { ...result, wav: readFileSync(wavPath) };
    } finally {
      rmSync(wavPath, { force: true });
    }
  }

  /**
   * Piper : synthétise `text` dans `wavPath` (WAV) sans le jouer. Mêmes bornes que `speak` (texte vide
   * refusé, coupé à SPEECH_MAX_CHARS) ; le débit devient `--length-scale` (durée des phonèmes = 1/débit).
   */
  async synthesizePiper(text: string, opts: SpeechOptions, wavPath: string, stopFirst = true): Promise<SpeechResult> {
    const p = this.d.piper;
    const voice = String(opts.voice ?? "").trim();
    const name = voice.startsWith(PIPER_VOICE_PREFIX) ? voice.slice(PIPER_VOICE_PREFIX.length) : voice;
    const model = p?.voices[name];
    if (!p || !model) throw new Error(`SPEECH_BAD_VOICE: voix Piper inconnue (${voice || "aucune"}).`);
    if (!existsSync(p.bin)) throw new Error(`SPEECH_NO_ENGINE: Piper introuvable (${p.bin}).`);
    if (!existsSync(model)) throw new Error(`SPEECH_NO_ENGINE: modèle Piper introuvable (${model}).`);
    const body = String(text ?? "").trim();
    if (!body) throw new Error("SPEECH_EMPTY: rien à lire.");
    const rate = normaliseRate(opts.rate);
    const spoken = body.length > SPEECH_MAX_CHARS ? body.slice(0, SPEECH_MAX_CHARS) : body;

    if (stopFirst) await this.stop();
    const file = join(this.d.tmpDir ?? tmpdir(), `jarod-speech-${randomUUID()}.txt`);
    writeFileSync(file, spoken, "utf8");
    this.textFile = file;
    const args = ["-m", model, "-i", file, "-f", wavPath, "--length-scale", String(Math.round((1 / rate) * 1000) / 1000)];
    const child = (this.d.spawn ?? defaultSpawn)(p.bin, args, { ...this.env(), PYTHONIOENCODING: "utf-8" });
    this.child = child;
    try {
      await waitFor(child, { kind: "sapi", command: p.bin, label: "Piper" });
    } finally {
      if (this.child === child) this.child = null;
      this.dropFile();
    }
    return { chars: spoken.length, truncated: spoken.length < body.length, voice };
  }

  /** Piper : synthèse, puis lecture du WAV par le lecteur de l'OS ; `stop()` interrompt l'un ou l'autre. */
  private async speakPiper(text: string, opts: SpeechOptions): Promise<SpeechResult> {
    const wav = join(this.d.tmpDir ?? tmpdir(), `jarod-speech-${randomUUID()}.wav`);
    try {
      await this.stop();
      const generation = this.generation;
      const result = await this.synthesizePiper(text, opts, wav, false);
      // Un `stop()` (ou une autre lecture) pendant la synthèse : on ne joue pas un son périmé.
      if (generation !== this.generation) return result;
      const player = this.player(wav);
      const child = (this.d.spawn ?? defaultSpawn)(player.command, player.args, player.env);
      this.child = child;
      try {
        await waitFor(child, { kind: "sapi", command: player.command, label: `Piper (${player.label})` });
      } finally {
        if (this.child === child) this.child = null;
      }
      return result;
    } finally {
      rmSync(wav, { force: true });
    }
  }

  /** Lecture d'un WAV : SoundPlayer (.NET) sous Windows, afplay sous macOS, aplay ailleurs. */
  private player(wav: string): { command: string; args: string[]; env: NodeJS.ProcessEnv; label: string } {
    const platform = this.platform();
    const find = (cmd: string) => findOnPath(cmd, this.env(), platform);
    if (platform === "win32") {
      const command = find("powershell.exe") ?? find("pwsh.exe");
      if (!command) throw new Error("SPEECH_NO_ENGINE: aucun lecteur audio (PowerShell) pour jouer la voix Piper.");
      const script = "(New-Object System.Media.SoundPlayer $env:JAROD_TTS_WAV).PlaySync()";
      return { command, args: ["-NoProfile", "-NonInteractive", "-Command", script], env: { ...this.env(), JAROD_TTS_WAV: wav }, label: "SoundPlayer" };
    }
    const command = platform === "darwin" ? find("afplay") : find("aplay");
    if (!command) throw new Error("SPEECH_NO_ENGINE: aucun lecteur audio pour jouer la voix Piper.");
    return { command, args: [wav], env: this.env(), label: command.split(/[\\/]/).pop() ?? command };
  }

  /** Ends what is being said, now. Returns whether there was anything to end. */
  async stop(): Promise<boolean> {
    this.generation++;
    const child = this.child;
    if (!child) {
      this.dropFile();
      return false;
    }
    const gone = new Promise<void>((done) => child.on("close", () => done()));
    child.kill();
    await gone;
    if (this.child === child) this.child = null;
    this.dropFile();
    return true;
  }

  private dropFile(): void {
    if (!this.textFile) return;
    try {
      rmSync(this.textFile, { force: true });
    } catch {
      // A file left behind in the temp folder is not worth failing a spoken answer over.
    }
    this.textFile = null;
  }
}

function normaliseRate(rate: number | undefined): number {
  if (rate === undefined) return 1;
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0 || value > 4) throw new Error("SPEECH_BAD_RATE: débit hors bornes (0–4).");
  return value;
}

/** Reads a child to its end, and turns a failure into the engine's own words. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, launch: SpeechSpawn): Promise<string> {
  const child = launch(command, args, env);
  const out: string[] = [];
  const err: string[] = [];
  let size = 0;
  const keep = (sink: string[]) => (chunk: unknown) => {
    if (size > 64 * 1024) return;
    const text = String(chunk);
    size += text.length;
    sink.push(text);
  };
  child.stdout?.on("data", keep(out));
  child.stderr?.on("data", keep(err));
  return new Promise((done, fail) => {
    child.on("error", (e) => fail(new Error(`SPEECH_ENGINE_FAILED: ${String(e)}`)));
    child.on("close", (code) => {
      if (code === 0) done(out.join(""));
      else fail(new Error(`SPEECH_ENGINE_FAILED: ${err.join("").trim().slice(0, 400) || `code ${String(code)}`}`));
    });
  });
}

function waitFor(child: SpeechChild, engine: Engine): Promise<void> {
  const err: string[] = [];
  child.stderr?.on("data", (chunk) => {
    if (err.length < 8) err.push(String(chunk));
  });
  return new Promise((done, fail) => {
    child.on("error", (e) => fail(new Error(`SPEECH_ENGINE_FAILED: ${String(e)}`)));
    child.on("close", (code) => {
      if (code === 0) done();
      else
        fail(
          new Error(
            `SPEECH_ENGINE_FAILED (${engine.label}): ${err.join("").trim().slice(0, 400) || `code ${String(code)}`}`,
          ),
        );
    });
  });
}

/** Engine listings, as they come. Names with spaces are kept whole where the format allows it. */
export function parseVoices(kind: Engine["kind"], out: string): string[] {
  const lines = out.split(/\r?\n/);
  if (kind === "sapi") return lines.map((l) => l.trim()).filter(Boolean);
  if (kind === "say") {
    // "Alex                en_US    # Most people recognize me by my voice."
    return lines
      .filter((l) => l.includes("#") && !l.startsWith("?"))
      .map((l) => l.split(/\s{2,}/)[0]!.trim())
      .filter(Boolean);
  }
  // espeak: " 5  en            M  en-us          English (America)   ..." — the name is the 4th column.
  return lines
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[3] ?? "")
    .filter((name) => Boolean(name) && !/^File$/i.test(name));
}
