// Portage de packages/core/src/services/android.ts (rév. 2e180305).
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { redactText } from "@jarod/kernel/redact";
import type { EventStoreService } from "@jarod/plugin-storage";
import { findOnPath } from "@jarod/kernel/find-on-path";

/** Package names, as the device takes them. */
const PKG_RE = /^[a-zA-Z0-9._]+$/;
/**
 * Refused on purpose. `adb shell` hands the string to the phone's own shell, so a `;` would run a
 * second command there — invisible to the approval that was just given for the first one. One
 * command per approval, or the approval means nothing.
 */
const SHELL_FORBIDDEN = /[;&|`$<>\n\r]/;

export interface AndroidDevice {
  serial: string;
  state: string;
  model: string;
  product: string;
}

/** What a command returns: the journal entry, plus what it printed. The output is not journaled. */
export interface AndroidResult extends AndroidCommand {
  out: string;
}

export interface AndroidCommand {
  at: number;
  serial: string;
  /** Already redacted: a command can carry a token, and a journal is read by others. */
  command: string;
  code: number;
  ms: number;
  ok: boolean;
  error?: string;
}

/**
 * `ready` : un adb est résolu et le fichier existe ; `unconfigured` : rien de choisi et rien sur le PATH ; `missing` : un chemin est résolu mais le fichier
 * n'existe plus. Hors de `ready`, rien n'est JAMAIS lancé (SPECS-P5-UI-PARITE.md § 21).
 */
export type AndroidState = "ready" | "unconfigured" | "missing";

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export interface AndroidDeps {
  events?: EventStoreService;
  /** The configured path, or "" to look on PATH. */
  adbPath?: () => string;
  /** L'existence du fichier adb, relue à chaque appel (injectable pour les tests). */
  exists?: (path: string) => boolean;
  timeoutMs?: () => number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injected so tests read the command line without an Android device attached. */
  run?: (args: string[], timeoutMs: number) => Promise<{ out: string; err: string; code: number }>;
}

/**
 * One Android device at a time, through the adb this computer already has. Nothing is invented when
 * adb is missing: the service says so, and every command that does run is written down — refusals
 * included, in the device's own stream, under the form it will be read in.
 */
export class AndroidService {
  private cached: string | null | undefined;

  constructor(private readonly d: AndroidDeps = {}) {}

  /** The adb in use, or null. Detected once: a machine does not grow platform tools. */
  adb(): string | null {
    if (this.cached === undefined) {
      const configured = (this.d.adbPath?.() ?? "").trim();
      this.cached = configured
        ? configured
        : findOnPath("adb", this.d.env ?? process.env, this.d.platform ?? process.platform);
    }
    return this.cached;
  }

  /** Relu à chaque appel : un adb supprimé se voit tout de suite (l'existence n'est pas mise en cache). */
  state(): AndroidState {
    const adb = this.adb();
    if (!adb) return "unconfigured";
    return (this.d.exists ?? isFile)(adb) ? "ready" : "missing";
  }

  available(): boolean {
    return this.state() === "ready";
  }

  /** Oublie l'adb détecté : le prochain appel relit le réglage (`adbPath`) — l'écran des réglages le change en cours de route. */
  reset(): void {
    this.cached = undefined;
  }

  /** What the device list says. Empty when adb is missing — the caller asks `available()` first. */
  async devices(): Promise<AndroidDevice[]> {
    if (!this.available()) return [];
    const { out, code } = await this.execute(["devices", "-l"], this.timeout());
    if (code !== 0) return [];
    return parseDevices(out);
  }

  /**
   * Runs one command on one device. Refused — and written down as refused — when it carries shell
   * chaining, when it is empty, or when adb is missing.
   */
  async shell(command: string, serial?: string): Promise<AndroidResult> {
    const text = String(command ?? "").trim();
    const target = serial ?? "";
    if (!text) return this.refuse(target, text, "commande vide", 0);
    if (!this.available()) return this.refuse(target, text, "ADB_ABSENT: adb est introuvable sur cet ordinateur", 0);
    if (SHELL_FORBIDDEN.test(text)) {
      return this.refuse(target, text, "ANDROID_CHAINED: une commande à la fois (pas de ; && | ` $ < >)", 0);
    }

    const started = Date.now();
    this.record(target, "command.started", { command: redactText(text), serial: target });
    const args = target ? ["-s", target, "shell", text] : ["shell", text];
    const { out, err, code } = await this.execute(args, this.timeout());
    const entry: AndroidResult = {
      at: started,
      serial: target,
      command: redactText(text),
      code,
      ms: Date.now() - started,
      ok: code === 0,
      ...(code === 0 ? {} : { error: redactText(err.trim()).slice(0, 400) || `code ${code}` }),
      // The output is for the caller, not for the journal: a `dumpsys` is megabytes, and a journal
      // nobody can read is a journal nobody reads.
      out,
    };
    this.record(target, "command.finished", {
      command: entry.command,
      serial: target,
      code: entry.code,
      ms: entry.ms,
      ok: entry.ok,
    });
    return entry;
  }

  /** Reads one package's version, by name only: a package name cannot be a command. */
  async packageVersion(pkg: string, serial?: string): Promise<string> {
    const name = String(pkg ?? "").trim();
    if (!PKG_RE.test(name)) throw new Error(`ANDROID_BAD_PACKAGE: « ${name} » n'est pas un nom de paquet`);
    // No pipe: chaining is refused on purpose, so the reading happens on this side.
    const result = await this.shell(`dumpsys package ${name}`, serial);
    if (!result.ok) return "";
    return result.out.match(/versionName=(\S+)/)?.[1] ?? "";
  }

  /** The device's journal, newest first. */
  journal(limit = 50, serial?: string): AndroidCommand[] {
    const events = this.d.events?.list(serial ? { stream: `android:${serial}` } : {}) ?? [];
    return (
      events
        // A refused command was asked for: leaving it out would hide exactly what the journal is for.
        .filter((e) => e.type === "command.finished" || e.type === "command.refused")
        .slice(-Math.max(1, limit))
        .reverse()
        .map((e) => {
          const data = e.data as {
            command?: string;
            serial?: string;
            code?: number;
            ms?: number;
            ok?: boolean;
            error?: string;
          };
          return {
            at: e.at,
            serial: data.serial ?? "",
            command: data.command ?? "",
            code: data.code ?? 0,
            ms: data.ms ?? 0,
            ok: data.ok === true,
            ...(data.error ? { error: data.error } : {}),
          };
        })
    );
  }

  private timeout(): number {
    const configured = Number(this.d.timeoutMs?.() ?? 15_000);
    return Number.isFinite(configured) && configured >= 1000 && configured <= 120_000 ? configured : 15_000;
  }

  private refuse(serial: string, command: string, error: string, code: number): AndroidResult {
    const entry: AndroidResult = {
      at: Date.now(),
      serial,
      command: redactText(command),
      code,
      ms: 0,
      ok: false,
      error,
      out: "",
    };
    // A refused command is a command that was asked for: it belongs in the journal too.
    this.record(serial, "command.refused", { command: entry.command, serial, error });
    return entry;
  }

  private record(serial: string, type: string, data: Record<string, unknown>): void {
    this.d.events?.append(`android:${serial || "any"}`, type, data);
  }

  private execute(args: string[], timeoutMs: number): Promise<{ out: string; err: string; code: number }> {
    if (this.d.run) return this.d.run(args, timeoutMs);
    const adb = this.adb();
    if (!adb || !this.available()) return Promise.resolve({ out: "", err: "adb introuvable", code: 127 });
    return new Promise((done) => {
      execFile(
        adb,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: this.d.env ?? process.env },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;
          done({ out: String(stdout ?? ""), err: String(stderr ?? ""), code });
        },
      );
    });
  }
}

/** `adb devices -l` output, minus the header and the blank lines. */
export function parseDevices(out: string): AndroidDevice[] {
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial = "", state = "", ...rest] = line.split(/\s+/);
      const field = (key: string) => rest.find((part) => part.startsWith(`${key}:`))?.slice(key.length + 1) ?? "";
      return { serial, state, model: field("model"), product: field("product") };
    })
    .filter((device) => Boolean(device.serial));
}
