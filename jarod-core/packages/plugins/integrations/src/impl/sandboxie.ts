/**
 * G15 — Sandboxie-Plus (installé par l'utilisateur le 2026-10-21, 1.18.8, pilote SbieDrv + service SbieSvc) : lancer un PROGRAMME Windows dans un
 * bac à sable dont Jarod possède la configuration. Distinct de `jarod-sandbox` (AppContainer, commandes) et de MXC : ici, des applications et des
 * installateurs, avec un système de fichiers copié à l'écriture que l'on peut inspecter puis vider.
 *
 * Mesuré sur cette machine (banc réel) :
 *  - une écriture dans le profil depuis le bac atterrit dans `C:\Sandbox\<utilisateur>\<bac>\user\current\…`, jamais dans le vrai profil ;
 *  - `ClosedFilePath=InternetAccessDevices` coupe le réseau du bac, bouclage compris (témoin local : 0 requête, HTTP 000) ;
 *  - une modification de configuration n'est vue qu'après `Start.exe /reload` (asynchrone : un lancement immédiat voit l'ancienne) ;
 *  - `Start.exe /wait` rend le code de retour du programme ; `delete_sandbox_silent` vide le bac ; `SbieIni set <bac> * ""` retire sa section ;
 *  - l'interface de Sandboxie-Plus réécrit la section d'un bac à sa première utilisation (modèles, et un blocage réseau AVEC une exception pour
 *    curl) : Jarod ne suppose rien, il écrit ses propres clés, recharge, puis RELIT `Sandboxie.ini` et refuse si le réseau n'est pas ce qu'il a demandé.
 * Rien ici n'exige l'élévation : la configuration passe par le service SbieSvc.
 */
import { execFile } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { childEnv } from "@jarod/kernel/child-env";
import { AdapterRefused, AdapterUnavailable } from "./common.js";

const DEFAULT_DIR = "C:\\Program Files\\Sandboxie-Plus";
/** Le bac de l'agent. Le banc utilise le sien (`JarodTest`), retiré à la fin. */
export const JAROD_BOX = "Jarod";
const BOX_RE = /^[A-Za-z0-9_]{1,32}$/;

/** Où est Sandboxie : JAROD_SANDBOXIE_DIR, sinon son dossier d'installation par défaut ; null s'il n'est pas installé. */
export function sandboxieDir(env: Record<string, string | undefined> = process.env): string | null {
  const dir = env.JAROD_SANDBOXIE_DIR || DEFAULT_DIR;
  return existsSync(join(dir, "Start.exe")) && existsSync(join(dir, "SbieIni.exe")) ? dir : null;
}

/** Le chemin RÉEL qu'une entrée du bac remplace : `drive\C\x` → `C:\x`, `user\current\x` → `<profil>\x`. */
export function realPathOf(boxRel: string, profile: string): string | null {
  const parts = boxRel.split(/[\\/]/).filter(Boolean);
  if (parts[0]?.toLowerCase() === "drive" && parts[1]) return `${parts[1].toUpperCase()}:\\${parts.slice(2).join("\\")}`;
  if (parts[0]?.toLowerCase() === "user" && parts[1]?.toLowerCase() === "current") return join(profile, ...parts.slice(2));
  return null;
}

/** Lit la section d'un bac dans `Sandboxie.ini` (UTF-16 ou UTF-8) : ses lignes `clé=valeur`. */
export function readBoxSection(iniText: string, box: string): string[] {
  const lines = iniText.replace(/^\uFEFF/, "").split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  for (const l of lines) {
    const t = l.trim();
    if (/^\[.*\]$/.test(t)) inside = t.slice(1, -1).toLowerCase() === box.toLowerCase();
    else if (inside && t && !t.startsWith("#")) out.push(t);
  }
  return out;
}

/** Ce que la section dit du réseau : coupé (et sans exception), ou non. */
export function networkClosed(section: readonly string[]): boolean {
  const closed = section.some((l) => /^ClosedFilePath=InternetAccessDevices$/i.test(l));
  const exception = section.some((l) => /^ClosedFilePath=!/i.test(l) || /^ProcessGroup=<InternetAccess>/i.test(l));
  return closed && !exception;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * L'environnement de Start.exe, que le programme du bac reçoit : celui d'un enfant NON FIABLE (famille « mcp » : système seulement), jamais
 * `process.env` — un programme lancé dans le bac n'a ni à lire les jetons de contrôle de Jarod, ni les secrets de l'utilisateur.
 */
export const sandboxedEnv = (): NodeJS.ProcessEnv => childEnv("mcp");

function run(file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env: sandboxedEnv(), windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(e?.killed) });
    });
  });
}

export interface BoxChange {
  /** Dans le bac, relatif à sa racine. */
  inBox: string;
  /** Le chemin réel que cette entrée remplace pour les programmes du bac (le vrai fichier n'a pas été touché). */
  replaces: string | null;
  bytes: number;
}

export class SandboxieBox {
  readonly root: string;

  constructor(
    private readonly o: {
      dir: string;
      box: string;
      /** `C:\Sandbox\<utilisateur>` par défaut (FileRootPath de Sandboxie). */
      sandboxRoot?: string;
      iniPath?: string;
      profile?: string;
      settleMs?: number;
    },
  ) {
    if (!BOX_RE.test(o.box)) throw new AdapterRefused("G15", `nom de bac invalide : ${o.box}`);
    this.root = join(o.sandboxRoot ?? join("C:\\Sandbox", process.env.USERNAME ?? "user"), o.box);
  }

  private exe(name: string): string {
    return join(this.o.dir, name);
  }

  private async ini(args: string[]): Promise<void> {
    const r = await run(this.exe("SbieIni.exe"), args, 15_000);
    if (r.code !== 0) throw new AdapterUnavailable("G15", `SbieIni ${args[0]} a échoué (code ${r.code})`);
  }

  /** La section du bac telle que le pilote la lira. */
  section(): string[] {
    const path = this.o.iniPath ?? join(process.env.WINDIR ?? "C:\\Windows", "Sandboxie.ini");
    if (!existsSync(path)) return [];
    const buf = readFileSync(path);
    const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8");
    return readBoxSection(text, this.o.box);
  }

  /**
   * Écrit la configuration du bac (activé ; réseau coupé ou non), recharge, puis RELIT : le réseau doit être exactement ce qui est demandé,
   * sinon refus (l'interface de Sandboxie a pu ajouter une exception). Les autres clés (modèles de compatibilité) sont laissées.
   */
  async configure(o: { network: boolean }): Promise<void> {
    await this.ini(["set", this.o.box, "Enabled", "y"]);
    for (const l of this.section()) {
      const m = /^(ClosedFilePath|ProcessGroup)=(.*)$/i.exec(l);
      if (m && (/InternetAccess/i.test(m[2]!) || m[1]!.toLowerCase() === "processgroup")) await this.ini(["delete", this.o.box, m[1]!, m[2]!]);
    }
    if (!o.network) await this.ini(["set", this.o.box, "ClosedFilePath", "InternetAccessDevices"]);
    await run(this.exe("Start.exe"), ["/reload"], 15_000);
    await new Promise((r) => setTimeout(r, this.o.settleMs ?? 1500));
    const closed = networkClosed(this.section());
    if (closed === o.network) throw new AdapterUnavailable("G15", `la configuration relue du bac ne correspond pas (réseau ${closed ? "coupé" : "ouvert"} au lieu de ${o.network ? "ouvert" : "coupé"}) : rien n'est lancé`);
  }

  /** Lance un programme dans le bac et attend sa fin ; rend son code de retour (celui du programme, passé par Start.exe). */
  async run(program: string, args: readonly string[], o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ code: number | null; timedOut: boolean }> {
    const r = await run(this.exe("Start.exe"), [`/box:${this.o.box}`, "/wait", program, ...args], o.timeoutMs ?? 120_000, o.signal);
    if (r.timedOut) await this.terminate();
    return { code: r.code, timedOut: r.timedOut };
  }

  /** Arrête tout ce qui tourne dans le bac (et seulement dans le bac). */
  async terminate(): Promise<void> {
    await run(this.exe("Start.exe"), [`/box:${this.o.box}`, "/terminate"], 30_000);
  }

  /** Ce que les programmes du bac ont écrit (copié à l'écriture), au plus `max` fichiers. */
  changes(max = 200): BoxChange[] {
    const out: BoxChange[] = [];
    const profile = this.o.profile ?? process.env.USERPROFILE ?? "";
    const walk = (d: string) => {
      if (out.length >= max) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          const rel = relative(this.root, full);
          // Fichiers internes de Sandboxie (registre du bac, journaux) : pas des changements du programme.
          if (/^(RegHive|RegHive\.LOG\d*|RegHive\.blf|RegHive\..*\.regtrans-ms)$/i.test(e.name) || /^DONT-USE\.TXT$/i.test(e.name)) continue;
          out.push({ inBox: rel, replaces: realPathOf(rel, profile), bytes: statSync(full).size });
        }
      }
    };
    if (existsSync(this.root)) walk(this.root);
    return out;
  }

  /** Vide le bac (son contenu seulement ; le vrai disque n'a jamais été touché). */
  async discard(): Promise<void> {
    await this.terminate();
    await run(this.exe("Start.exe"), [`/box:${this.o.box}`, "delete_sandbox_silent"], 60_000);
  }

  /** Retire la section du bac de la configuration (bancs). */
  async remove(): Promise<void> {
    await this.ini(["set", this.o.box, "*", ""]);
    await run(this.exe("Start.exe"), ["/reload"], 15_000);
  }
}

// ── Outils de l'agent ─────────────────────────────────────────────────────────────────────────────

/** Caractères refusés dans un programme ou un argument : ils changeraient le sens de la ligne de commande du fichier .cmd qui le lance. */
const UNSAFE = /["%&|<>^\r\n]/;
const MAX_OUT = 20_000;

/** La forme d'un `ToolDef` de plugin-tools (sans en dépendre). */
export interface SandboxToolDef {
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
  precheck?(args: Record<string, unknown>): Promise<string | void> | string | void;
  run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null; signal?: AbortSignal }): Promise<string>;
}

export interface SandboxToolsDeps {
  /** Le dossier de Sandboxie, relu à chaque appel (installé ou non). */
  dir: () => string | null;
  box?: string;
  /** Internet est-il permis à Jarod (interrupteur de la barre du haut) ? */
  internet: () => boolean;
  /** Où écrire le petit fichier .cmd qui lance le programme (lisible depuis le bac). */
  scratch: string;
  sandboxRoot?: string;
  settleMs?: number;
}

const describeChanges = (changes: BoxChange[]): string =>
  changes.length ? changes.map((c) => `${c.replaces ?? c.inBox} (${c.bytes} o)`).join("\n") : "aucune écriture";

export function sandboxTools(d: SandboxToolsDeps): SandboxToolDef[] {
  const box = d.box ?? JAROD_BOX;
  const make = (): SandboxieBox => {
    const dir = d.dir();
    if (!dir) throw new AdapterUnavailable("G15", "Sandboxie-Plus n'est pas installé");
    return new SandboxieBox({ dir, box, ...(d.sandboxRoot ? { sandboxRoot: d.sandboxRoot } : {}), ...(d.settleMs !== undefined ? { settleMs: d.settleMs } : {}) });
  };
  const available = () => process.platform === "win32" && d.dir() !== null;

  const runTool: SandboxToolDef = {
    name: "sandbox_run",
    description: `Lance un programme Windows dans le bac à sable Sandboxie « ${box} » et attend sa fin : ce qu'il écrit (fichiers, registre) reste dans le bac, jamais sur le vrai disque. Réseau COUPÉ par défaut (bouclage compris) ; network=true l'ouvre — opération réservée, refusée sans règle de l'utilisateur. Rend le code de retour, la sortie (capture=true) et la liste de ce que le programme a écrit. Ensuite : sandbox_changes pour revoir, sandbox_discard pour vider le bac. Pour une application ou un installateur à essayer sans risque ; pour une commande, préférer run_shell.`,
    parameters: {
      type: "object",
      properties: {
        program: { type: "string", description: "Chemin ou nom d'un programme (ex. C:\\Téléchargements\\setup.exe, notepad.exe)." },
        args: { type: "array", items: { type: "string" }, maxItems: 30 },
        network: { type: "boolean", description: "Ouvrir le réseau au bac (opération réservée)." },
        capture: { type: "boolean", description: "Capturer la sortie du programme (défaut : oui)." },
        timeoutSec: { type: "integer", minimum: 1, maximum: 1800 },
      },
      required: ["program"],
    },
    dangerous: true,
    audited: true,
    source: "builtin",
    available,
    targetOf: (args) => (typeof args.program === "string" ? args.program : undefined),
    operationOf: (args) => (args.network === true ? "run.network" : "run"),
    restrictedOperations: { "run.network": "le programme du bac pourrait joindre Internet et le réseau local, y compris les services de cette machine" },
    precheck(args) {
      const program = typeof args.program === "string" ? args.program.trim() : "";
      if (!program) throw new AdapterRefused("G15", "program est requis");
      const list = Array.isArray(args.args) ? args.args : [];
      if (list.some((a) => typeof a !== "string")) throw new AdapterRefused("G15", "args : liste de textes");
      for (const v of [program, ...(list as string[])]) if (UNSAFE.test(v)) throw new AdapterRefused("G15", `caractère refusé dans « ${v} » (" % & | < > ^ ou retour à la ligne)`);
      if (args.network === true && !d.internet()) throw new AdapterRefused("G15", "Internet est coupé pour Jarod : le bac ne peut pas l'avoir");
      return `Lancer dans le bac à sable « ${box} » : ${program}${list.length ? ` ${(list as string[]).join(" ")}` : ""} (réseau ${args.network === true ? "OUVERT" : "coupé"})`;
    },
    async run(args, ctx) {
      const b = make();
      const program = String(args.program).trim();
      const list = (Array.isArray(args.args) ? args.args : []) as string[];
      const timeoutMs = Math.min(Math.max(Number(args.timeoutSec ?? 300), 1), 1800) * 1000;
      const capture = args.capture !== false;
      await b.configure({ network: args.network === true });
      const before = new Set(b.changes(5000).map((c) => c.inBox));
      mkdirSync(d.scratch, { recursive: true });
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const outName = `jarod-sbx-${id}.out`;
      const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
      const line = `${[program, ...list].map(q).join(" ")}${capture ? ` > "%TEMP%\\${outName}" 2>&1` : ""}`;
      const wrapper = join(d.scratch, `jarod-sbx-${id}.cmd`);
      writeFileSync(wrapper, `@${line}\r\n@exit /b %errorlevel%\r\n`);
      try {
        const r = await b.run("cmd.exe", ["/c", wrapper], { timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        const all = b.changes(5000);
        const changes = all.filter((c) => !before.has(c.inBox) && !c.inBox.toLowerCase().endsWith(outName));
        let out = "";
        const captured = capture ? all.find((c) => c.inBox.toLowerCase().endsWith(outName)) : undefined;
        if (captured) out = readFileSync(join(b.root, captured.inBox), "utf8");
        return [
          r.timedOut ? `Délai dépassé (${timeoutMs / 1000} s) : tout ce qui tournait dans le bac a été arrêté.` : `Code de retour : ${r.code}.`,
          `Réseau du bac : ${args.network === true ? "ouvert" : "coupé"}.`,
          capture ? `Sortie :\n${out.length > MAX_OUT ? `${out.slice(0, MAX_OUT)}…` : out || "(vide)"}` : "",
          `Écrit dans le bac (le vrai disque n'a pas été touché) :\n${describeChanges(changes.slice(0, 200))}`,
        ]
          .filter(Boolean)
          .join("\n");
      } finally {
        rmSync(wrapper, { force: true });
      }
    },
  };

  const changesTool: SandboxToolDef = {
    name: "sandbox_changes",
    description: `Liste ce que les programmes du bac à sable « ${box} » ont écrit (fichiers copiés à l'écriture), avec le chemin réel que chacun remplace pour eux. Lecture seule.`,
    parameters: { type: "object", properties: {} },
    dangerous: false,
    audited: true,
    source: "builtin",
    available,
    async run() {
      const c = make().changes();
      return c.length ? `${c.length} fichier(s) dans le bac :\n${describeChanges(c)}` : "Le bac est vide.";
    },
  };

  const discardTool: SandboxToolDef = {
    name: "sandbox_discard",
    description: `Vide le bac à sable « ${box} » : arrête ce qui y tourne et supprime tout ce que ses programmes ont écrit. Le vrai disque n'est pas touché.`,
    parameters: { type: "object", properties: {} },
    dangerous: true,
    audited: true,
    source: "builtin",
    available,
    precheck: () => `Vider le bac à sable « ${box} » (ce que ses programmes ont écrit est supprimé ; le vrai disque n'est pas touché)`,
    async run() {
      const b = make();
      const n = b.changes(5000).length;
      await b.discard();
      const left = b.changes().length;
      if (left) throw new AdapterUnavailable("G15", `${left} fichier(s) encore dans le bac après le vidage`);
      return `Bac vidé : ${n} fichier(s) supprimé(s) du bac.`;
    },
  };

  return [runTool, changesTool, discardTool];
}
