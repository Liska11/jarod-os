// Lot 4 (30/10) : les outils du quotidien repris de brahma-ai-evo (actions clipboard_processor, spotify_controller/computer_settings,
// screen_processor, window_context + sensorium, protocols) — réécrits en TypeScript sur les scripts PowerShell de scripts-everyday.ts.
// Windows seulement, comme les autres outils système. Ce qui AGIT est `dangerous` (accord à chaque appel, sauf règle) ; ce qui lit est audité.
import type { ToolDef } from "../registry.js";
import { asList, powershellExe, type PsRunner, realPsRunner } from "./ps.js";
import * as A from "./scripts-act.js";
import { parseSystemInfo } from "./parse.js";
import * as E from "./scripts-everyday.js";
import * as S from "./scripts.js";
import type { SystemToolDeps } from "./tools.js";
import type { UndoStack } from "./undo.js";

export interface EverydayDeps extends SystemToolDeps {
  undo?: UndoStack;
}

/** Les codes de touches virtuelles multimédia de Windows. */
export const MEDIA_KEYS = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2, volume_up: 0xaf, volume_down: 0xae, mute: 0xad } as const;
type MediaAction = keyof typeof MEDIA_KEYS;

export const CLIPBOARD_MAX = 20_000;

/** Les modes « protocole » (idée de brahma `core/protocols.py`) : plusieurs réglages en une commande, chacun annulable. */
export const PROTOCOLS = {
  nuit: { label: "mode nuit", dark: true, volume: 25, brightness: 30 },
  jour: { label: "mode jour", dark: false, volume: 50, brightness: 80 },
  concentration: { label: "mode concentration", dark: undefined, volume: 0, brightness: undefined },
  presentation: { label: "mode présentation", dark: false, volume: 60, brightness: 100 },
} as const;
type ProtocolName = keyof typeof PROTOCOLS;

const json = (v: unknown) => JSON.stringify(v);

/** Les seuils d'alerte du « Hardware Monitoring » de Mark-LVI, avec des valeurs prudentes. */
export const HARDWARE_LIMITS = { memoryPercent: 90, diskFreePercent: 10, diskFreeGb: 5, batteryPercent: 20 } as const;

/** Les états de batterie (parse.ts) où l'ordinateur est sur secteur : jamais de « batterie faible » dans ces cas. « discharging » n'en fait PAS partie. */
const POWERED_STATES: ReadonlySet<string> = new Set(["on AC power", "charged", "charging", "partially charged"]);

export interface HardwareAlert {
  what: "memory" | "disk" | "battery";
  message: string;
}

/** Compare un relevé `system_info` (déjà analysé) aux seuils : une liste d'alertes en français, vide quand tout va bien. Pure. */
export function hardwareAlerts(info: Record<string, unknown>, limits: typeof HARDWARE_LIMITS = HARDWARE_LIMITS): HardwareAlert[] {
  const out: HardwareAlert[] = [];
  const total = Number(info.memory_total_bytes) || 0;
  const used = Number(info.memory_used_bytes) || 0;
  if (total > 0) {
    const pct = Math.round((used / total) * 100);
    if (pct >= limits.memoryPercent) out.push({ what: "memory", message: `Mémoire presque pleine : ${pct} % utilisés (${Math.round(used / 1e9)} sur ${Math.round(total / 1e9)} Go).` });
  }
  for (const d of (info.disks as { mount: string; total_bytes: number; free_bytes: number }[] | undefined) ?? []) {
    const freePct = d.total_bytes > 0 ? (d.free_bytes / d.total_bytes) * 100 : 100;
    if (freePct < limits.diskFreePercent || d.free_bytes / 1e9 < limits.diskFreeGb)
      out.push({ what: "disk", message: `Disque ${d.mount} presque plein : ${(d.free_bytes / 1e9).toFixed(1)} Go libres (${Math.round(freePct)} %).` });
  }
  const b = info.battery as { percent: number; state: string } | null | undefined;
  if (b && b.percent <= limits.batteryPercent && !POWERED_STATES.has(b.state)) out.push({ what: "battery", message: `Batterie faible : ${b.percent} % et ne charge pas.` });
  return out;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], key: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new Error(`${key} doit être l'un de : ${allowed.join(", ")}`);
  return v as T;
}

export function everydayTools(deps: EverydayDeps = {}): ToolDef[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return [];
  const env = deps.env ?? process.env;
  let ps: PsRunner | undefined = deps.ps;
  const runner = (): PsRunner => (ps ??= realPsRunner());
  const hasPs = () => deps.ps !== undefined || powershellExe(env) !== null;
  const base = { source: "builtin" as const, audited: true, available: hasPs };
  const opts = (signal?: AbortSignal) => ({ timeoutMs: 30_000, signal });

  const readAudio = async (signal?: AbortSignal) => {
    const raw = ((await runner().json(A.AUDIO, undefined, opts(signal))) ?? {}) as { output?: string };
    const [lvl, muted] = String(raw.output ?? "").split("|");
    return { volume: lvl ? Number(lvl) : null, muted: muted === "1" };
  };

  const clipboard: ToolDef = {
    ...base,
    name: "clipboard",
    description:
      "Le presse-papiers de Windows. action=read : rend le texte copié (pour l'expliquer, le corriger, le traduire, le résumer) ; action=write : y place un texte (text), pour que l'utilisateur le colle. Texte seulement.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["read", "write"] }, text: { type: "string" } }, required: ["action"] },
    // Écrire remplace ce que l'utilisateur avait copié : un accord est demandé (dangerous) ; lire est audité.
    dangerous: true,
    precheck(args) {
      const action = oneOf(args.action, ["read", "write"] as const, "action");
      if (action === "write" && typeof args.text !== "string") throw new Error("text est requis pour write");
      return action === "read" ? "Lire le texte du presse-papiers" : `Copier dans le presse-papiers : « ${String(args.text).slice(0, 80)}${String(args.text).length > 80 ? "…" : ""} »`;
    },
    async run(args, ctx) {
      const action = oneOf(args.action, ["read", "write"] as const, "action");
      if (action === "read") {
        const r = ((await runner().json(E.CLIPBOARD_GET, undefined, opts(ctx.signal))) ?? {}) as { text?: string };
        const text = String(r.text ?? "");
        return json({ text: text.slice(0, CLIPBOARD_MAX), truncated: text.length > CLIPBOARD_MAX, empty: text.length === 0 });
      }
      const text = String(args.text ?? "").slice(0, CLIPBOARD_MAX);
      const before = deps.undo ? String((((await runner().json(E.CLIPBOARD_GET, undefined, opts(ctx.signal))) ?? {}) as { text?: string }).text ?? "") : null;
      await runner().json(E.CLIPBOARD_SET, { text }, opts(ctx.signal));
      if (before !== null)
        deps.undo?.push("remplacer le presse-papiers", async () => {
          await runner().json(E.CLIPBOARD_SET, { text: before }, { timeoutMs: 30_000 });
          return "Le texte copié d'avant est revenu dans le presse-papiers.";
        });
      return json({ written: text.length });
    },
    async verify(args) {
      if (args.action !== "write") return { status: "verified", evidence: "lecture" };
      const now = String((((await runner().json(E.CLIPBOARD_GET, undefined, { timeoutMs: 30_000 })) ?? {}) as { text?: string }).text ?? "");
      const want = String(args.text ?? "").slice(0, CLIPBOARD_MAX);
      // Windows rend les fins de ligne en CRLF : on compare sans elles.
      const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();
      return norm(now) === norm(want) ? { status: "verified", evidence: "relu dans le presse-papiers" } : { status: "failed", evidence: "le presse-papiers ne contient pas le texte demandé" };
    },
  };

  const media: ToolDef = {
    ...base,
    name: "media_control",
    dangerous: true,
    description:
      "Touches multimédia de l'ordinateur, reçues par le lecteur en cours (Spotify, YouTube dans le navigateur, VLC…) : play_pause, next, previous, stop, volume_up, volume_down, mute. Pour régler le volume à une valeur précise, system_control set_volume.",
    parameters: { type: "object", properties: { action: { type: "string", enum: Object.keys(MEDIA_KEYS) } }, required: ["action"] },
    precheck(args) {
      const a = oneOf(args.action, Object.keys(MEDIA_KEYS) as MediaAction[], "action");
      return `Touche multimédia : ${a.replace("_", " ")}`;
    },
    async run(args, ctx) {
      const a = oneOf(args.action, Object.keys(MEDIA_KEYS) as MediaAction[], "action");
      await runner().json(E.MEDIA_KEY, { vk: MEDIA_KEYS[a] }, opts(ctx.signal));
      return json({ pressed: a });
    },
    // Une touche envoyée ne se relit pas : seul le lecteur sait s'il l'a reçue.
    async verify() {
      return { status: "unverifiable", evidence: "une touche multimédia ne se relit pas ; le lecteur actif l'a peut-être ignorée" };
    },
  };

  const activeWindow: ToolDef = {
    ...base,
    name: "active_window",
    dangerous: false,
    description:
      "Ce que l'utilisateur a devant lui : titre de la fenêtre au premier plan, son programme, et depuis combien de secondes clavier et souris sont inactifs. Pour comprendre « ça », « cette page », « ce document » sans demander. Lecture seule.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      return json((await runner().json(E.ACTIVE_WINDOW, undefined, opts(ctx.signal))) ?? {});
    },
  };

  const screenRead: ToolDef = {
    ...base,
    name: "screen_read",
    dangerous: false,
    description:
      "Lit le TEXTE affiché à l'écran (target=screen : tout l'écran ; target=window : la fenêtre au premier plan) avec la reconnaissance de texte de Windows, sur cette machine : rien n'est envoyé. Pour « que dit ce message d'erreur ? », « résume ce que j'ai à l'écran ». Les images sans texte ne sont pas décrites. Lecture seule, auditée.",
    parameters: { type: "object", properties: { target: { type: "string", enum: ["screen", "window"] } } },
    async run(args, ctx) {
      const target = args.target === "window" ? "window" : "screen";
      const r = ((await runner().json(E.SCREEN_OCR, { target }, { timeoutMs: 60_000, signal: ctx.signal })) ?? {}) as { lines?: unknown; language?: string; width?: number; height?: number };
      const lines = asList(r.lines).map(String);
      const text = lines.join("\n");
      return json({ target, language: r.language ?? null, size: `${r.width ?? "?"}x${r.height ?? "?"}`, lines: lines.length, text: text.slice(0, 30_000), empty: text.trim() === "" });
    },
  };

  const protocol: ToolDef = {
    ...base,
    name: "protocol",
    dangerous: true,
    description:
      "Applique un mode en une fois (chaque réglage reste annulable avec undo_last_action) : nuit (mode sombre, volume 25 %, luminosité 30 %), jour (mode clair, volume 50 %, luminosité 80 %), concentration (son coupé), presentation (mode clair, volume 60 %, luminosité 100 %). La luminosité n'est réglée que sur un écran qui le permet (portable).",
    parameters: { type: "object", properties: { name: { type: "string", enum: Object.keys(PROTOCOLS) } }, required: ["name"] },
    precheck(args) {
      const p = PROTOCOLS[oneOf(args.name, Object.keys(PROTOCOLS) as ProtocolName[], "name")];
      return `Passer en ${p.label}`;
    },
    async run(args, ctx) {
      const name = oneOf(args.name, Object.keys(PROTOCOLS) as ProtocolName[], "name");
      const p = PROTOCOLS[name];
      const done: string[] = [];
      const reverse: (() => Promise<unknown>)[] = [];
      if (p.dark !== undefined) {
        const was = Number((((await runner().json(A.APPEARANCE, undefined, opts(ctx.signal))) ?? {}) as { apps_light?: unknown }).apps_light) === 0;
        if (was !== p.dark) {
          await runner().json(A.SET_DARK_MODE, { enabled: p.dark }, opts(ctx.signal));
          reverse.push(() => runner().json(A.SET_DARK_MODE, { enabled: was }, { timeoutMs: 30_000 }));
        }
        done.push(p.dark ? "mode sombre" : "mode clair");
      }
      if (p.volume !== undefined) {
        const before = await readAudio(ctx.signal);
        const set = p.volume === 0 ? { muted: true } : { percent: p.volume, muted: false };
        await runner().json(A.AUDIO, set, opts(ctx.signal));
        if (before.volume !== null) reverse.push(() => runner().json(A.AUDIO, { percent: before.volume, muted: before.muted }, { timeoutMs: 30_000 }));
        done.push(p.volume === 0 ? "son coupé" : `volume ${p.volume} %`);
      }
      if (p.brightness !== undefined) {
        const before = ((await runner().json(E.BRIGHTNESS, undefined, opts(ctx.signal))) ?? {}) as { supported?: boolean; percent?: number };
        if (before.supported) {
          await runner().json(E.BRIGHTNESS, { percent: p.brightness }, opts(ctx.signal));
          if (typeof before.percent === "number") reverse.push(() => runner().json(E.BRIGHTNESS, { percent: before.percent }, { timeoutMs: 30_000 }));
          done.push(`luminosité ${p.brightness} %`);
        } else {
          done.push("luminosité non réglable sur cet écran");
        }
      }
      if (reverse.length)
        deps.undo?.push(p.label, async () => {
          for (const r of [...reverse].reverse()) await r();
          return "Réglages d'avant rétablis.";
        });
      return json({ protocol: name, applied: done });
    },
  };

  const hardware: ToolDef = {
    ...base,
    name: "hardware_check",
    dangerous: false,
    description:
      "Vérifie la santé de l'ordinateur contre des seuils (mémoire ≥ 90 %, disque < 10 % ou < 5 Go libres, batterie ≤ 20 % hors charge) et rend les alertes en français, ou « tout va bien ». À mettre dans une automatisation planifiée pour être prévenu sans surveiller.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const data = ((await runner().json(S.SYSTEM_INFO, undefined, { timeoutMs: 30_000, signal: ctx.signal })) ?? {}) as Record<string, unknown>;
      const alerts = hardwareAlerts(parseSystemInfo(data));
      return json({ ok: alerts.length === 0, alerts: alerts.map((a) => a.message), summary: alerts.length ? `${alerts.length} alerte(s)` : "Tout va bien : mémoire, disques et batterie sont dans les limites." });
    },
  };

  return [clipboard, media, activeWindow, screenRead, protocol, hardware];
}
