// Jarod-OS : la voix rendue en octets WAV (`SpeechService.synthesize`) au lieu du haut-parleur. Moteurs factices : aucune voix ne parle pendant les tests.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type SpeechChild, SpeechService, type SpeechSpawn } from "../src/speech.js";

afterEach(cleanup);

const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(24)]);

function pathWith(...names: string[]): string {
  const dir = tempDir();
  for (const name of names) writeFileSync(join(dir, name), "");
  return dir;
}

/** Un moteur factice : lit le texte là où le vrai le lirait, écrit un WAV là où le vrai l'écrirait (sauf demande contraire), puis ferme. */
function engine(over: { code?: number; stderr?: string; writeWav?: boolean } = {}) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; text: string }[] = [];
  const spawn: SpeechSpawn = (command, args, env) => {
    const textFile = env.JAROD_TTS_TEXT ?? (args.includes("-i") ? args[args.indexOf("-i") + 1] : undefined);
    calls.push({ command, args, env, text: textFile ? readFileSync(textFile, "utf8") : "" });
    const wav = env.JAROD_TTS_WAV ?? (args.includes("-f") ? args[args.indexOf("-f") + 1] : undefined);
    if (wav && over.writeWav !== false && (over.code ?? 0) === 0) writeFileSync(wav, WAV);
    const on: Record<string, ((v: unknown) => void)[]> = {};
    const child: SpeechChild = {
      stdout: { on: () => {} },
      stderr: { on: (event, cb) => void (event === "data" && over.stderr !== undefined && queueMicrotask(() => cb(over.stderr))) },
      on: (event, cb) => void (on[event] ??= []).push(cb),
      kill: () => queueMicrotask(() => on.close?.forEach((cb) => cb(0))),
    };
    setTimeout(() => on.close?.forEach((cb) => cb(over.code ?? 0)), 0);
    return child;
  };
  return { spawn, calls };
}

function windows(over: Parameters<typeof engine>[0] = {}) {
  const e = engine(over);
  return { ...e, service: new SpeechService({ spawn: e.spawn, tmpDir: tempDir(), platform: "win32", env: { PATH: pathWith("powershell.exe"), PATHEXT: ".EXE" } }) };
}

describe("synthesize avec SAPI", () => {
  it("rend les octets du WAV que le moteur a écrits ; texte, voix et débit passent par fichier et environnement, jamais par la ligne de commande", async () => {
    const text = "Bonjour ! L'apostrophe et le « guillemet » ne cassent rien.";
    const w = windows();
    const out = await w.service.synthesize(text, { voice: "Microsoft Hortense Desktop", rate: 1.5 });
    expect(out.wav.equals(WAV)).toBe(true);
    expect([out.chars, out.truncated, out.voice]).toEqual([text.length, false, "Microsoft Hortense Desktop"]);
    const call = w.calls[0]!;
    expect(call.text).toBe(text);
    expect(call.env.JAROD_TTS_VOICE).toBe("Microsoft Hortense Desktop");
    expect(call.env.JAROD_TTS_RATE).toBe("5");
    expect(call.args.join(" ")).toContain("SetOutputToWaveFile");
    expect(call.args.join(" ")).not.toContain("Bonjour");
  });

  it("coupe un texte trop long et le dit ; refuse un texte vide, un débit hors bornes", async () => {
    const w = windows();
    const out = await w.service.synthesize("x".repeat(5000));
    expect(out.truncated).toBe(true);
    expect(out.chars).toBe(1500);
    await expect(windows().service.synthesize("   ")).rejects.toThrow(/SPEECH_EMPTY/);
    await expect(windows().service.synthesize("a", { rate: 9 })).rejects.toThrow(/SPEECH_BAD_RATE/);
  });

  it("un moteur qui échoue, ou qui n'écrit rien, est une erreur dite avec les mots du moteur", async () => {
    await expect(windows({ code: 1, stderr: "voix introuvable" }).service.synthesize("a")).rejects.toThrow(/SPEECH_ENGINE_FAILED.*voix introuvable/);
    await expect(windows({ writeWav: false }).service.synthesize("a")).rejects.toThrow(/n'a rien écrit/);
  });

  it("aucun moteur : erreur nommée ; macOS et Linux : pas de sortie WAV, refus nommé", async () => {
    const none = new SpeechService({ spawn: engine().spawn, platform: "win32", env: { PATH: pathWith() } });
    await expect(none.synthesize("a")).rejects.toThrow(/SPEECH_NO_ENGINE/);
    const mac = new SpeechService({ spawn: engine().spawn, platform: "darwin", env: { PATH: pathWith("say") } });
    await expect(mac.synthesize("a")).rejects.toThrow(/SPEECH_NO_WAV/);
  });
});

describe("synthesize avec Piper", () => {
  it("une voix piper:<nom> passe par Piper (même fichier WAV), pas par SAPI", async () => {
    const dir = tempDir();
    const bin = join(dir, "piper.exe");
    const model = join(dir, "fr.onnx");
    writeFileSync(bin, "");
    writeFileSync(model, "");
    const e = engine();
    const service = new SpeechService({ spawn: e.spawn, tmpDir: tempDir(), platform: "win32", env: { PATH: pathWith("powershell.exe"), PATHEXT: ".EXE" }, piper: { bin, voices: { fr: model } } });
    const out = await service.synthesize("Salut", { voice: "piper:fr", rate: 2 });
    expect(out.wav.equals(WAV)).toBe(true);
    expect(e.calls[0]!.command).toBe(bin);
    expect(e.calls[0]!.args).toEqual(expect.arrayContaining(["-m", model, "--length-scale", "0.5"]));
    await expect(service.synthesize("Salut", { voice: "piper:inconnue" })).rejects.toThrow(/SPEECH_BAD_VOICE/);
  });
});
