// Portage de packages/core/test/speech.test.ts (rév. 2e180305) — verbatim, imports réécrits.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseVoices,
  SPEECH_MAX_CHARS,
  type SpeechChild,
  SpeechService,
  type SpeechSpawn,
} from "../src/speech.js";
import { cleanup, tempDir } from "@jarod/kernel/testing";

afterEach(cleanup);

/** A PATH with exactly the executables the test wants the machine to have. */
function pathWith(...names: string[]): string {
  const dir = tempDir();
  for (const name of names) writeFileSync(join(dir, name), "");
  return dir;
}

interface Rig {
  spawn: SpeechSpawn;
  calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; text: string }[];
  killed: number[];
}

/** Lets every pending microtask run: an async service needs a turn boundary to be observed. */
const tick = (): Promise<void> => new Promise((done) => setImmediate(done));

const read = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** Records the launch instead of performing it: no voice engine runs during the test suite. */
function rig(over: { code?: number; stderr?: string; stdout?: string; hang?: boolean } = {}): Rig {
  const calls: Rig["calls"] = [];
  const killed: number[] = [];
  const spawn: SpeechSpawn = (command, args, env) => {
    const mine = calls.length;
    // Read it where the engine would read it: the file is gone by the time speak() resolves.
    const file = env.JAROD_TTS_TEXT ?? (args[0] === "-f" ? args[1] : undefined);
    calls.push({ command, args, env, text: file ? read(file) : "" });
    const on: Record<string, ((value: unknown) => void)[]> = {};
    const emit = (event: string, value?: unknown) => {
      for (const cb of on[event] ?? []) cb(value);
    };
    const child: SpeechChild = {
      stdout: {
        on: (event, cb) => {
          if (event === "data" && over.stdout !== undefined) queueMicrotask(() => cb(over.stdout));
        },
      },
      stderr: {
        on: (event, cb) => {
          if (event === "data" && over.stderr !== undefined) queueMicrotask(() => cb(over.stderr));
        },
      },
      on: (event, cb) => {
        (on[event] ??= []).push(cb);
      },
      kill: () => {
        killed.push(mine);
        queueMicrotask(() => emit("close", 0));
      },
    };
    // A real process sends its output first and closes after; the order matters to a reader.
    if (!over.hang) setTimeout(() => emit("close", over.code ?? 0), 0);
    return child;
  };
  return { spawn, calls, killed };
}

function windows(over: Parameters<typeof rig>[0] = {}, names = ["powershell.exe"]) {
  const r = rig(over);
  const bin = pathWith(...names);
  const service = new SpeechService({
    spawn: r.spawn,
    tmpDir: tempDir(),
    platform: "win32",
    env: { PATH: bin, PATHEXT: ".EXE" },
  });
  return { ...r, service };
}

describe("speech — which engine is used", () => {
  it("finds the machine's engine, and says there is none when there is none", () => {
    expect(windows().service.engine()).toMatchObject({ kind: "sapi", label: "SAPI (powershell.exe)" });
    // PowerShell 7 does not always carry System.Speech, so it is the second choice.
    expect(windows({}, ["pwsh.exe"]).service.engine()).toMatchObject({ kind: "sapi", label: "SAPI (pwsh.exe)" });
    expect(windows({}, []).service.engine()).toBeNull();
    expect(windows({}, []).service.available()).toBe(false);

    const mac = new SpeechService({ spawn: rig().spawn, platform: "darwin", env: { PATH: pathWith("say") } });
    expect(mac.engine()).toMatchObject({ kind: "say" });
    const linux = new SpeechService({
      spawn: rig().spawn,
      platform: "linux",
      env: { PATH: pathWith("espeak-ng") },
    });
    expect(linux.engine()).toMatchObject({ kind: "espeak", label: "espeak-ng" });
  });

  it("reads each engine's voice listing", () => {
    expect(parseVoices("sapi", "Microsoft Hortense Desktop\r\nMicrosoft Julie\r\n")).toEqual([
      "Microsoft Hortense Desktop",
      "Microsoft Julie",
    ]);
    const say =
      "?                     # Special keyword\nAlex                en_US    # Most people recognize me\nAmelie              fr_FR    # Bonjour, je m'appelle Amélie.\n";
    expect(parseVoices("say", say)).toEqual(["Alex", "Amelie"]);
    const espeak =
      "Pty Language Age/Gender VoiceName          File          Other Languages\n 5  en            M  en-us              English (America)  ...\n 5  fr            M  fr                 French             ...\n";
    expect(parseVoices("espeak", espeak)).toEqual(["en-us", "fr"]);
  });

  it("lists voices through the engine, and stays quiet when the listing fails", async () => {
    const ok = windows({ stdout: "Microsoft Hortense Desktop\r\nMicrosoft Julie\r\n" });
    expect(await ok.service.voices()).toEqual(["Microsoft Hortense Desktop", "Microsoft Julie"]);
    expect(ok.calls[0]?.args.join(" ")).toContain("GetInstalledVoices");

    const bad = windows({ code: 1, stderr: "boom" });
    expect(await bad.service.voices()).toEqual([]);
  });
});

describe("speech — speaking", () => {
  it("hands the text over in a file, never on the command line", async () => {
    const text = "Bonjour ! Voici l'apostrophe et le « guillemet » qui cassent les lignes de commande.";
    const r = windows();
    const out = await r.service.speak(text, { voice: "Microsoft Hortense Desktop" });

    expect(out).toEqual({ chars: text.length, truncated: false, voice: "Microsoft Hortense Desktop" });
    const call = r.calls[0]!;
    const file = String(call.env.JAROD_TTS_TEXT);

    // The text is in the file, and nowhere in what was launched.
    expect(call.text).toBe(text);
    expect(call.args.join("\u0000")).not.toContain("Bonjour");
    expect(call.command.endsWith("powershell.exe")).toBe(true);
    expect(call.env.JAROD_TTS_VOICE).toBe("Microsoft Hortense Desktop");
    expect(call.env.JAROD_TTS_RATE).toBe("0");
    // The script is a constant: no user value is ever spliced into it.
    expect(call.args.at(-1)).toContain("System.Speech");

    // And the file does not stay behind.
    expect(existsSync(String(call.env.JAROD_TTS_TEXT))).toBe(false);
  });

  it("keeps a hostile voice name out of the script", async () => {
    const r = windows();
    const voice = "x'; Remove-Item -Recurse -Force C:\\ ; '";
    await r.service.speak("salut", { voice });
    const call = r.calls[0]!;
    // It travels as a value, and the command line is byte-for-byte the constant script.
    expect(call.env.JAROD_TTS_VOICE).toBe(voice);
    expect(call.args.at(-1)).not.toContain("Remove-Item");
  });

  it("cuts what is too long to read, and says so", async () => {
    const long = "a".repeat(SPEECH_MAX_CHARS + 500);
    const r = windows();
    const out = await r.service.speak(long);
    expect(out.chars).toBe(SPEECH_MAX_CHARS);
    expect(out.truncated).toBe(true);
    expect(r.calls[0]!.text.length).toBe(SPEECH_MAX_CHARS);
  });

  it("maps the speed setting onto each engine's own dial", async () => {
    const win = windows();
    await win.service.speak("vite", { rate: 2 });
    expect(win.calls[0]!.env.JAROD_TTS_RATE).toBe("10");
    await win.service.speak("trop vite", { rate: 4 });
    // Clamped: SAPI's dial stops at 10, and asking beyond it must not become something else.
    expect(win.calls[1]!.env.JAROD_TTS_RATE).toBe("10");

    // macOS and Linux take the file with -f too, and the speed in words per minute.
    const macRig = rig();
    const mac = new SpeechService({
      spawn: macRig.spawn,
      tmpDir: tempDir(),
      platform: "darwin",
      env: { PATH: pathWith("say") },
    });
    await mac.speak("bonjour", { voice: "Amelie", rate: 2 });
    const macCall = macRig.calls[0]!;
    expect(macCall.args.slice(2)).toEqual(["-r", "350", "-v", "Amelie"]);
    expect(macCall.args[0]).toBe("-f");
    expect(macCall.text).toBe("bonjour");

    for (const bad of [0, -1, 5, Number.NaN]) {
      await expect(mac.speak("x", { rate: bad })).rejects.toThrow("SPEECH_BAD_RATE");
    }
  });

  it("refuses nothing to read, and no engine at all", async () => {
    const none = windows({}, []);
    await expect(none.service.speak("bonjour")).rejects.toThrow("SPEECH_NO_ENGINE");
    const r = windows();
    await expect(r.service.speak("   ")).rejects.toThrow("SPEECH_EMPTY");
    expect(r.calls).toHaveLength(0);
  });

  it("reports the engine's own words when it fails", async () => {
    const r = windows({ code: 1, stderr: "SelectVoice: voice not found" });
    await expect(r.service.speak("bonjour", { voice: "Fantome" })).rejects.toThrow(/voice not found/);
  });
});

describe("speech — stopping", () => {
  it("ends what is being said, and knows when there was nothing", async () => {
    const r = windows({ hang: true });
    const speaking = r.service.speak("une phrase assez longue");
    await tick();
    expect(r.service.busy()).toBe(true);

    expect(await r.service.stop()).toBe(true);
    expect(r.killed).toEqual([0]);
    await speaking;
    expect(r.service.busy()).toBe(false);

    expect(await r.service.stop()).toBe(false);
  });

  it("stops the previous answer before starting the next one", async () => {
    const r = windows({ hang: true });
    const first = r.service.speak("premiere");
    await tick();
    const second = r.service.speak("deuxieme");
    await tick();
    // Two voices at once is never what was asked for: the first one was ended.
    expect(r.calls).toHaveLength(2);
    expect(r.killed).toEqual([0]);
    await r.service.stop();
    await Promise.all([first, second]);
    expect(r.service.busy()).toBe(false);
  });
});
