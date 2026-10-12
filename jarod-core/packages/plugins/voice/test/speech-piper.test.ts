/**
 * W4 — Piper dans `SpeechService` (Jarod-cordis, PLAN §4.3). Même harnais que `speech.test.ts` (source) :
 * le lanceur est remplacé, aucun moteur ne tourne. La synthèse réelle est éprouvée par
 * `tests/bench/tts-piper.test.ts` (Piper → WAV → whisper.cpp).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type SpeechChild, SpeechService, type SpeechSpawn } from "../src/speech.js";

afterEach(cleanup);

interface Call {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  text: string;
}

function rig(codes: number[] = [], hangFirst = false) {
  const calls: Call[] = [];
  const spawn: SpeechSpawn = (command, args, env) => {
    const n = calls.length;
    const input = args[args.indexOf("-i") + 1];
    calls.push({ command, args, env, text: args.includes("-i") && input && existsSync(input) ? readFileSync(input, "utf8") : "" });
    const on: Record<string, ((v: unknown) => void)[]> = {};
    const emit = (e: string, v?: unknown) => {
      for (const cb of on[e] ?? []) cb(v);
    };
    const child: SpeechChild = {
      stdout: { on: () => {} },
      stderr: { on: (e, cb) => (codes[n] ? queueMicrotask(() => cb("piper: boom")) : undefined) },
      on: (e, cb) => void (on[e] ??= []).push(cb),
      kill: () => queueMicrotask(() => emit("close", 0)),
    };
    if (!(hangFirst && n === 0)) setTimeout(() => emit("close", codes[n] ?? 0), 0);
    return child;
  };
  return { spawn, calls };
}

function setup(opts: { codes?: number[]; hangFirst?: boolean; os?: boolean; model?: boolean } = {}) {
  const dir = tempDir();
  const bin = join(dir, "piper.exe");
  const model = join(dir, "fr_FR-siwis-medium.onnx");
  writeFileSync(bin, "");
  if (opts.model !== false) writeFileSync(model, "");
  const path = tempDir();
  if (opts.os !== false) writeFileSync(join(path, "powershell.exe"), "");
  const r = rig(opts.codes, opts.hangFirst);
  const service = new SpeechService({
    spawn: r.spawn,
    tmpDir: tempDir(),
    platform: "win32",
    env: { PATH: path, PATHEXT: ".EXE" },
    piper: { bin, voices: { "fr_FR-siwis-medium": model } },
  });
  return { ...r, service, bin, model };
}

describe("speech — Piper (PLAN §4.3)", () => {
  it("annonce une voix piper:<nom> seulement si binaire et modèle existent", async () => {
    const ok = setup({ os: false });
    expect(await ok.service.voices()).toEqual(["piper:fr_FR-siwis-medium"]);
    expect(ok.service.available()).toBe(true); // Piper seul suffit
    const missing = setup({ os: false, model: false });
    expect(await missing.service.voices()).toEqual([]);
    expect(missing.service.available()).toBe(false);
  });

  it("synthétise (texte par fichier, débit → length-scale) puis joue le WAV par SoundPlayer ; fichiers retirés", async () => {
    const t = setup();
    const r = await t.service.speak("Bonjour, je suis Jarod. « Accents » compris.", { voice: "piper:fr_FR-siwis-medium", rate: 2 });
    expect(r).toEqual({ chars: 44, truncated: false, voice: "piper:fr_FR-siwis-medium" });
    expect(t.calls).toHaveLength(2);
    const [synth, play] = t.calls as [Call, Call];
    expect(synth.command).toBe(t.bin);
    expect(synth.args.slice(0, 2)).toEqual(["-m", t.model]);
    expect(synth.args.slice(-2)).toEqual(["--length-scale", "0.5"]);
    expect(synth.text).toBe("Bonjour, je suis Jarod. « Accents » compris.");
    const wav = synth.args[synth.args.indexOf("-f") + 1]!;
    expect(wav).toMatch(/\.wav$/);
    expect(play.command).toMatch(/powershell\.exe$/i);
    expect(play.args.at(-1)).toContain("System.Media.SoundPlayer $env:JAROD_TTS_WAV");
    expect(play.env.JAROD_TTS_WAV).toBe(wav);
    expect(existsSync(wav)).toBe(false);
    expect(existsSync(synth.args[synth.args.indexOf("-i") + 1]!)).toBe(false);
  });

  it("voix Piper inconnue, texte vide, échec de Piper : erreurs nommées, rien n'est joué", async () => {
    const t = setup();
    await expect(t.service.speak("x", { voice: "piper:inconnue" })).rejects.toThrow(/SPEECH_BAD_VOICE/);
    await expect(t.service.speak("   ", { voice: "piper:fr_FR-siwis-medium" })).rejects.toThrow(/SPEECH_EMPTY/);
    const failing = setup({ codes: [1] });
    await expect(failing.service.speak("x", { voice: "piper:fr_FR-siwis-medium" })).rejects.toThrow(/SPEECH_ENGINE_FAILED \(Piper\): piper: boom/);
    expect(failing.calls).toHaveLength(1);
  });

  it("stop() pendant la synthèse : pas de lecture d'un son périmé", async () => {
    const t = setup({ hangFirst: true });
    const speaking = t.service.speak("Une longue phrase.", { voice: "piper:fr_FR-siwis-medium" });
    await new Promise((r) => setImmediate(r));
    expect(t.service.busy()).toBe(true);
    expect(await t.service.stop()).toBe(true);
    await speaking;
    expect(t.calls).toHaveLength(1);
  });

  it("une voix non Piper reste servie par le moteur de l'OS (comportement source)", async () => {
    const t = setup();
    await t.service.speak("Bonjour", { voice: "Microsoft Hortense Desktop" });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.env.JAROD_TTS_VOICE).toBe("Microsoft Hortense Desktop");
  });
});
