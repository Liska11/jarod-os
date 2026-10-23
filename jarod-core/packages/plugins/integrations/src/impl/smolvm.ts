/**
 * G10 — smolvm 1.30.1 (micro-VM Linux sur la plateforme d'hyperviseur Windows) : une MACHINE LINUX que Jarod possède (« jarod »), pour lancer des
 * commandes Linux isolées du système Windows. Distinct de Sandboxie (applications Windows) et de jarod-sandbox (AppContainer).
 *
 * Mesuré sur cette machine (2026-10-21) :
 *  - noyau Linux 6.18.55, Alpine 3.24.2 ; démarrage d'une machine persistante en 0,35 s, une commande en ~5 s ;
 *  - l'image est téléchargée DEPUIS la VM (réseau requis) ; une VM éphémère la retélécharge à chaque fois — d'où une machine persistante :
 *    créée avec le réseau pour le téléchargement (`linux_prepare`), puis `update --no-net` ; ensuite tout tourne SANS réseau ;
 *  - réseau coupé (`--no-net`) : aucune sortie ; dossier partagé en lecture seule : écriture refusée (« Read-only file system ») ;
 *  - code de retour d'`exec` transmis ; par défaut 4 vCPU et 8 Gio (≈ 6 Go côté hôte) : Jarod demande 2 vCPU et 1 Gio (≈ 1,1 Go) et ARRÊTE la
 *    machine après chaque commande ;
 *  - `machine start` laisse un processus de VM qui hérite des sorties : on ne lit jamais ses tubes (sinon on attend sa fin) ;
 *  - sur cette version de Windows (10.0.26300), une socket AF_UNIX ne se connecte pas sous `AppData\Local` (WSAEINVAL, mesuré hors smolvm) :
 *    le dossier de données de smolvm (`%LOCALAPPDATA%\smolvm`, dossier connu, non redirigeable) est une JONCTION vers un dossier qui le permet.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AdapterRefused, AdapterUnavailable } from "./common.js";

/** La machine de l'agent. Le banc utilise la sienne, supprimée à la fin. */
export const JAROD_MACHINE = "jarod";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** Une référence d'image OCI (registre, nom, étiquette ou empreinte) : pas d'espace, pas de chemin local. */
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/]*(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;

/** Où est smolvm : JAROD_SMOLVM, sinon JAROD_ENGINES_DIR\smolvm\smolvm.exe. */
export function smolvmBinary(env: Record<string, string | undefined> = process.env): string | null {
  const c = [env.JAROD_SMOLVM, env.JAROD_ENGINES_DIR && join(env.JAROD_ENGINES_DIR, "smolvm", "smolvm.exe")].filter((x): x is string => Boolean(x));
  return c.find((p) => existsSync(p)) ?? null;
}

interface Out {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Une commande smolvm qui rend la main (create, update, exec, stop, delete, ls) ; ses sorties sont lues. */
function run(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<Out> {
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(e?.killed) });
    });
  });
}

/** `machine start` : la VM qu'il lance hérite de ses sorties — elles ne sont PAS lues (sinon on attendrait l'arrêt de la VM). */
function start(bin: string, name: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["machine", "start", "--name", name], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

const tail = (o: Out) => `${o.stderr}\n${o.stdout}`.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 400);

export interface MachineState {
  exists: boolean;
  running: boolean;
}

export class SmolMachine {
  /** Le partage en place (hôte:invité[:ro|rw]) : retiré avant d'en poser un autre. */
  private volume: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly o: {
      bin: string;
      name: string;
      mem?: number;
      cpus?: number;
    },
  ) {
    if (!NAME_RE.test(o.name)) throw new AdapterRefused("G10", `nom de machine invalide : ${o.name}`);
  }

  /** Une opération à la fois sur la machine (deux commandes simultanées se disputeraient ses disques). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async state(): Promise<MachineState> {
    const r = await run(this.o.bin, ["machine", "ls"], 30_000);
    const line = r.stdout.split(/\r?\n/).find((l) => l.trim().split(/\s+/)[0] === this.o.name);
    return { exists: Boolean(line), running: Boolean(line && /\brunning\b/.test(line)) };
  }

  private async must(args: string[], what: string, timeoutMs = 120_000): Promise<Out> {
    const r = await run(this.o.bin, args, timeoutMs);
    if (r.code !== 0) throw new AdapterUnavailable("G10", `${what} a échoué : ${tail(r)}`);
    return r;
  }

  async stop(): Promise<void> {
    if ((await this.state()).running) await this.must(["machine", "stop", "--name", this.o.name], "l'arrêt de la machine");
  }

  private async startMachine(): Promise<void> {
    const code = await start(this.o.bin, this.o.name, 180_000);
    if (code !== 0 || !(await this.state()).running) {
      throw new AdapterUnavailable(
        "G10",
        "la machine Linux n'a pas démarré (sous AppData, une socket AF_UNIX ne se connecte pas sur cette version de Windows : %LOCALAPPDATA%\\smolvm doit être une jonction vers un dossier qui le permet — voir engines.lock/README.md)",
      );
    }
  }

  /**
   * Crée (ou recrée) la machine depuis une image : avec le réseau le temps du téléchargement, puis réseau coupé. Une machine existante d'une
   * autre image est supprimée d'abord (son état est perdu : c'est dit à la demande d'accord).
   */
  async prepare(image: string, signal?: AbortSignal): Promise<void> {
    if (!IMAGE_RE.test(image)) throw new AdapterRefused("G10", `image invalide : ${image}`);
    const s = await this.state();
    if (s.exists) {
      await this.stop();
      await this.must(["machine", "delete", "--name", this.o.name, "--force"], "la suppression de l'ancienne machine");
    }
    await this.must(["machine", "create", "--net", "--image", image, "--name", this.o.name, "--mem", String(this.o.mem ?? 1024), "--cpus", String(this.o.cpus ?? 2)], "la création de la machine");
    if (signal?.aborted) throw new AdapterRefused("G10", "préparation annulée");
    // Le téléchargement de l'image a lieu au premier démarrage, dans la VM.
    await this.startMachine();
    await this.stop();
    await this.must(["machine", "update", "--name", this.o.name, "--no-net"], "la coupure du réseau");
    this.volume = null;
  }

  /** Lance une commande dans la machine : réseau et partage posés pour CET appel, machine arrêtée ensuite. */
  async exec(
    command: string,
    o: { network: boolean; share: { host: string; mode: "ro" | "rw" } | null; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ code: number | null; output: string; timedOut: boolean }> {
    const s = await this.state();
    if (!s.exists) throw new AdapterUnavailable("G10", "aucune machine Linux : la préparer d'abord (linux_prepare)");
    if (s.running) await this.stop();
    const update = ["machine", "update", "--name", this.o.name, o.network ? "--net" : "--no-net"];
    if (this.volume) update.push("--remove-volume", this.volume.replace(/:(ro|rw)$/, ""));
    const volume = o.share ? `${o.share.host}:/work:${o.share.mode}` : null;
    if (volume) update.push("-v", volume);
    await this.must(update, "la configuration de la machine");
    this.volume = volume;
    await this.startMachine();
    try {
      const seconds = Math.max(1, Math.round(o.timeoutMs / 1000));
      const r = await run(
        this.o.bin,
        ["machine", "exec", "--name", this.o.name, "--timeout", `${seconds}s`, ...(volume ? ["-w", "/work"] : []), "--", "sh", "-c", command],
        o.timeoutMs + 30_000,
        o.signal,
      );
      return { code: r.code, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim(), timedOut: r.timedOut };
    } finally {
      // Arrêtée après chaque commande : ~1 Go rendu à l'hôte, et rien ne tourne quand Jarod ne s'en sert pas.
      await this.stop().catch(() => undefined);
    }
  }

  /** Supprime la machine (son disque avec) ; l'image reste dans le cache de smolvm. */
  async reset(): Promise<boolean> {
    const s = await this.state();
    if (!s.exists) return false;
    await this.stop();
    await this.must(["machine", "delete", "--name", this.o.name, "--force"], "la suppression de la machine");
    this.volume = null;
    return true;
  }
}

// ── Outils de l'agent ─────────────────────────────────────────────────────────────────────────────

/** La forme d'un `ToolDef` de plugin-tools (sans en dépendre). */
export interface LinuxToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  dangerous: boolean;
  audited: true;
  source: "builtin";
  available(): boolean;
  targetOf?(args: Record<string, unknown>): string | undefined;
  operationOf?(args: Record<string, unknown>): string | undefined;
  restrictedOperations?: Readonly<Record<string, string>>;
  precheck?(args: Record<string, unknown>, ctx: { workspace: string | null }): Promise<string | void> | string | void;
  run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null; signal?: AbortSignal }): Promise<string>;
}

export interface LinuxToolsDeps {
  bin: () => string | null;
  name?: string;
  internet: () => boolean;
}

const MAX_OUT = 20_000;
const MODES = ["none", "ro", "rw"] as const;

/** L'opération de règle d'un appel : réseau et écriture dans le dossier de travail sont réservés (voir `restrictedOperations`). */
export function linuxOperation(args: Record<string, unknown>): string {
  const parts = [args.network === true ? "network" : "", args.workspace === "rw" ? "workspace-rw" : args.workspace === "ro" ? "workspace-ro" : ""].filter(Boolean);
  return parts.length ? `run.${parts.join("+")}` : "run";
}

export function linuxTools(d: LinuxToolsDeps): LinuxToolDef[] {
  const name = d.name ?? JAROD_MACHINE;
  let machine: SmolMachine | null = null;
  const m = (): SmolMachine => {
    const bin = d.bin();
    if (!bin) throw new AdapterUnavailable("G10", "smolvm introuvable (JAROD_SMOLVM ou JAROD_ENGINES_DIR\\smolvm)");
    machine ??= new SmolMachine({ bin, name });
    return machine;
  };
  const available = () => process.platform === "win32" && d.bin() !== null;
  const reserved = "le programme de la machine Linux pourrait joindre Internet et le réseau local";
  const rw = "le programme de la machine Linux pourrait modifier ou effacer les fichiers du dossier de travail";

  const prepare: LinuxToolDef = {
    name: "linux_prepare",
    description:
      "Prépare la machine Linux de Jarod (micro-VM smolvm) depuis une image (défaut : alpine) : télécharge l'image (réseau, le temps du téléchargement seulement), puis coupe le réseau de la machine. Une machine existante est remplacée (son état est perdu). À faire une fois avant linux_run.",
    parameters: { type: "object", properties: { image: { type: "string", description: "Image OCI : alpine, debian:bookworm-slim, python:3.12-alpine…" } } },
    dangerous: true,
    audited: true,
    source: "builtin",
    available,
    targetOf: (args) => (typeof args.image === "string" && args.image ? args.image : "alpine"),
    precheck(args) {
      const image = typeof args.image === "string" && args.image.trim() ? args.image.trim() : "alpine";
      if (!IMAGE_RE.test(image)) throw new AdapterRefused("G10", `image invalide : ${image}`);
      if (!d.internet()) throw new AdapterRefused("G10", "Internet est coupé pour Jarod : impossible de télécharger l'image");
      return `Préparer la machine Linux de Jarod depuis l'image ${image} (téléchargement par Internet ; une machine existante est remplacée)`;
    },
    async run(args, ctx) {
      const image = typeof args.image === "string" && args.image.trim() ? args.image.trim() : "alpine";
      const t = Date.now();
      await m().exclusive(() => m().prepare(image, ctx.signal));
      return `Machine Linux prête (${image}) en ${Math.round((Date.now() - t) / 1000)} s ; réseau coupé. Lancer des commandes avec linux_run.`;
    },
  };

  const runTool: LinuxToolDef = {
    name: "linux_run",
    description:
      "Lance une commande shell (sh -c) dans la machine Linux de Jarod (micro-VM isolée de Windows, root dans la VM, état conservé entre les appels). Réseau COUPÉ par défaut ; network=true l'ouvre (opération réservée). workspace : none (défaut), ro (dossier de travail en lecture seule sous /work) ou rw (lecture-écriture : opération réservée). Rend le code de retour et la sortie. La machine est arrêtée après chaque commande.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        workspace: { type: "string", enum: [...MODES] },
        network: { type: "boolean" },
        timeoutSec: { type: "integer", minimum: 1, maximum: 3600 },
      },
      required: ["command"],
    },
    dangerous: true,
    audited: true,
    source: "builtin",
    available,
    targetOf: (args) => (typeof args.command === "string" ? args.command : undefined),
    operationOf: linuxOperation,
    restrictedOperations: { "run.network": reserved, "run.workspace-rw": rw, "run.network+workspace-rw": `${reserved}, et modifier le dossier de travail`, "run.network+workspace-ro": `${reserved}, avec le dossier de travail en lecture` },
    precheck(args, ctx) {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) throw new AdapterRefused("G10", "command est requis");
      if (command.length > 8000) throw new AdapterRefused("G10", "commande trop longue (8000 caractères au plus)");
      const mode = (args.workspace ?? "none") as string;
      if (!(MODES as readonly string[]).includes(mode)) throw new AdapterRefused("G10", "workspace : none, ro ou rw");
      if (mode !== "none" && !ctx.workspace) throw new AdapterRefused("G10", "aucun dossier de travail à partager");
      if (args.network === true && !d.internet()) throw new AdapterRefused("G10", "Internet est coupé pour Jarod : la machine Linux ne peut pas l'avoir");
      return `Dans la machine Linux (réseau ${args.network === true ? "OUVERT" : "coupé"}, dossier de travail ${mode === "rw" ? "en ÉCRITURE" : mode === "ro" ? "en lecture" : "non partagé"}) : ${command.slice(0, 300)}`;
    },
    async run(args, ctx) {
      const mode = (args.workspace ?? "none") as (typeof MODES)[number];
      const timeoutMs = Math.min(Math.max(Number(args.timeoutSec ?? 300), 1), 3600) * 1000;
      const r = await m().exclusive(() =>
        m().exec(String(args.command), {
          network: args.network === true,
          share: mode === "none" || !ctx.workspace ? null : { host: ctx.workspace, mode },
          timeoutMs,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }),
      );
      const out = r.output.length > MAX_OUT ? `${r.output.slice(0, MAX_OUT)}…` : r.output;
      return [r.timedOut ? `Délai dépassé (${timeoutMs / 1000} s) : la commande a été arrêtée.` : `Code de retour : ${r.code}.`, `Sortie :\n${out || "(vide)"}`].join("\n");
    },
  };

  const resetTool: LinuxToolDef = {
    name: "linux_reset",
    description: "Supprime la machine Linux de Jarod et son disque (tout ce qui y a été installé ou écrit). L'image reste en cache ; linux_prepare en refait une.",
    parameters: { type: "object", properties: {} },
    dangerous: true,
    audited: true,
    source: "builtin",
    available,
    precheck: () => "Supprimer la machine Linux de Jarod et tout ce qu'elle contient",
    async run() {
      return (await m().exclusive(() => m().reset())) ? "Machine Linux supprimée." : "Aucune machine Linux à supprimer.";
    },
  };

  return [prepare, runTool, resetTool];
}
