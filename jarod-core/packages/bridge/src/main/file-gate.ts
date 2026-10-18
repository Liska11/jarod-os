/**
 * Q12 — garde d'accès aux fichiers et médias du renderer (décision utilisateur 2026-09-28, BESOINS Q12).
 *
 * Chez SANK-UI (`register.ts:1770-1836,2984-3100`) le renderer passe un CHEMIN LIBRE aux canaux de fichiers, sans
 * aucun garde. Ici tout chemin venu du renderer est jugé dans le MAIN, sur son chemin RÉEL (`realpath` natif :
 * jonctions, liens symboliques, noms courts 8.3 et points finaux résolus — même règle que `resolveInWorkspace`
 * de plugin-tools) :
 * - (a) racines = dossiers de travail (réglage `workspace` + dossier lié de chaque conversation) + `JAROD_WORKDIR`
 *   (liste `;`, lue au démarrage) + dossiers choisis dans la boîte NATIVE `select-folder` pendant ce lancement +
 *   dossiers propres à Jarod (pièces jointes collées, médias matérialisés). Une racine ne s'ajoute que par
 *   l'utilisateur — jamais par un chemin du renderer ni une sortie de l'agent ; chaque ajout est journalisé ;
 * - (b) aucun dossier de travail = aucun accès (hors dossiers propres à Jarod) ;
 * - racines interdites (le refus l'emporte, même sous une racine autorisée) et noms interdits partout ;
 * - une racine ne peut être ni une racine de lecteur, ni le dossier personnel, ni un ancêtre d'une racine interdite ;
 * - chemins UNC, de périphérique, flux alternatifs, relatifs au lecteur ou relatifs : refusés.
 * Journal : `<userData>/logs/file-gate.jsonl` — refus, lectures autorisées (chemin, taille, canal), écritures,
 * ouvertures, ajouts et refus de racines.
 */
import { appendFileSync, existsSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Refus de la garde : le canal répond sa forme SANK-UI d'échec (`null` / `false`), jamais un contenu. */
export class GateDenied extends Error {
  constructor(readonly reason: string) {
    super(`[oneai] accès refusé par la garde fichiers : ${reason}`);
  }
}

export type RootSource = "workspace" | "session" | "env" | "select-folder" | "staging" | "media";

export interface FileGateDeps {
  /** Dossiers de données de Jarod (racine des profils, `userData`) : interdits, sauf le dossier des pièces collées. */
  protectedDirs(): string[];
  /** `<profil>/attachments/staging` : seul dossier où `stage-attachment` écrit. */
  stagingRoot(): string;
  /** `<temp>/jarod-media` : médias `data:` matérialisés pour « Ouvrir ». */
  mediaRoot(): string;
  /** Dossiers de travail : réglage `workspace` et dossiers liés aux conversations. */
  workFolders(): { path: string; source: "workspace" | "session" }[];
  /** Fichier journal (`<userData>/logs/file-gate.jsonl`). */
  logFile(): string;
  /** `JAROD_WORKDIR` lu au démarrage (défaut : `process.env`). */
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

export interface GateLogEntry {
  op: "read" | "list" | "exists" | "deny" | "write" | "open" | "reveal" | "terminal" | "root-added" | "root-refused" | "delete" | "default-workspace-set";
  channel?: string;
  path?: string;
  size?: number;
  reason?: string;
  source?: string;
}

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Noms interdits partout (chaque composant du chemin réel, casse ignorée). */
const FORBIDDEN_NAME = /^(\.env|\.env\..*|.*\.key|.*\.pem|.*\.pfx|.*\.p12|id_rsa.*|id_ed25519.*|.*\.kdbx|.*\.dpapi|auth\.json|credentials.*|backup-hermes|backup-db)$/i;

export function isForbiddenName(name: string): boolean {
  return FORBIDDEN_NAME.test(name);
}

export class FileGate {
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  /** `JAROD_WORKDIR`, lu une fois (au démarrage). */
  private readonly envRoots: string[];
  /** Dossiers choisis dans la boîte native pendant ce lancement (chemins réels). */
  private readonly picked = new Set<string>();
  /** Racines déjà journalisées (ajout ou refus), pour n'écrire qu'une ligne par racine. */
  private readonly announced = new Set<string>();

  constructor(private readonly d: FileGateDeps) {
    this.platform = d.platform ?? process.platform;
    this.home = d.home ?? homedir();
    this.env = d.env ?? process.env;
    this.envRoots = (this.env.JAROD_WORKDIR ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // ---- chemins ----------------------------------------------------------------------------------------------

  private key(p: string): string {
    return this.platform === "win32" ? p.toLowerCase() : p;
  }

  /** `child` est `parent` ou en dessous (casse ignorée sous Windows). */
  within(parent: string, child: string): boolean {
    const rel = relative(this.key(parent), this.key(child));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  /**
   * Forme du chemin, avant tout accès disque : texte absolu, sans octet nul ; sous Windows ni UNC (`\\serveur`), ni
   * périphérique (`\\?\`, `\\.\`), ni flux alternatif (`fichier:flux`), ni relatif au lecteur (`C:x`).
   */
  syntax(p: unknown): string {
    if (typeof p !== "string" || !p.trim()) throw new GateDenied("chemin absent");
    if (p.includes("\0")) throw new GateDenied("octet nul dans le chemin");
    if (this.platform === "win32") {
      if (/^[\\/]{2}/.test(p)) throw new GateDenied("chemin UNC ou de périphérique");
      if (!/^[A-Za-z]:[\\/]/.test(p)) throw new GateDenied("chemin absolu attendu (lecteur:\\…)");
      if (p.slice(2).includes(":")) throw new GateDenied("flux alternatif (« : » hors lecteur)");
    } else if (!isAbsolute(p)) {
      throw new GateDenied("chemin absolu attendu");
    }
    return resolve(p);
  }

  /** Chemin réel d'un chemin EXISTANT (jonctions, liens, 8.3 résolus) ; introuvable = refus. */
  real(p: string): string {
    try {
      return realpathSync.native(p);
    } catch {
      throw new GateDenied("introuvable");
    }
  }

  private tryReal(p: string): string {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  }

  /** Racines interdites : le refus l'emporte, même sous une racine autorisée. */
  forbiddenRoots(): string[] {
    const h = this.home;
    const out = [
      ".ssh",
      ".gnupg",
      ".aws",
      ".azure",
      ".kube",
      ".docker",
      join(".config", "gh"),
      ".git-credentials",
      ".npmrc",
    ].map((x) => join(h, x));
    if (this.platform === "win32") {
      const local = this.env.LOCALAPPDATA ?? join(h, "AppData", "Local");
      const roaming = this.env.APPDATA ?? join(h, "AppData", "Roaming");
      out.push(
        join(local, "hermes"),
        join(local, "Google", "Chrome", "User Data"),
        join(local, "Microsoft", "Edge", "User Data"),
        join(roaming, "Mozilla", "Firefox", "Profiles"),
        join(roaming, "Microsoft", "Credentials"),
        join(roaming, "Microsoft", "Protect"),
        join(local, "Microsoft", "Credentials"),
        this.env.SystemRoot ?? this.env.windir ?? "C:\\Windows",
        this.env.ProgramFiles ?? "C:\\Program Files",
        this.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      );
      if (this.env.ProgramW6432) out.push(this.env.ProgramW6432);
    }
    out.push(...this.d.protectedDirs());
    return [...new Set(out.map((p) => this.tryReal(p)))];
  }

  /** Raison du refus d'un chemin réel (racine ou nom interdit), ou null. */
  forbiddenReason(real: string): string | null {
    const parts = real.split(/[\\/]+/).filter(Boolean);
    const bad = parts.find((c, i) => !(i === 0 && /^[A-Za-z]:$/.test(c)) && isForbiddenName(c));
    if (bad) return `nom protégé (« ${bad} »)`;
    const staging = this.tryReal(this.d.stagingRoot());
    const own = new Set(this.d.protectedDirs().map((p) => this.key(this.tryReal(p))));
    for (const f of this.forbiddenRoots()) {
      if (!this.within(f, real)) continue;
      // Le dossier des pièces collées vit sous les données de Jarod : seule exception à LEUR interdiction.
      if (own.has(this.key(f)) && this.within(staging, real)) continue;
      return `dossier protégé (${f})`;
    }
    return null;
  }

  /** Ce qui empêche un dossier d'être une racine : racine de lecteur, dossier personnel, ancêtre d'une racine interdite. */
  rootProblem(real: string): string | null {
    if (/^[A-Za-z]:\\?$/.test(real) || real === "/" || dirname(real) === real) return "racine de lecteur";
    if (this.key(resolve(real)) === this.key(this.tryReal(this.home))) return "dossier personnel";
    const inside = this.forbiddenReason(real);
    if (inside) return inside;
    const guarded = this.forbiddenRoots().find((f) => this.within(real, f));
    if (guarded) return `contient un dossier protégé (${guarded})`;
    return null;
  }

  // ---- racines ----------------------------------------------------------------------------------------------

  /** Racines en vigueur (chemins réels), chacune validée ; un ajout ou un refus est journalisé une fois. */
  roots(): { path: string; source: RootSource }[] {
    const candidates: { path: string; source: RootSource }[] = [
      ...this.d.workFolders(),
      ...this.envRoots.map((path) => ({ path, source: "env" as const })),
      ...[...this.picked].map((path) => ({ path, source: "select-folder" as const })),
    ];
    const out: { path: string; source: RootSource }[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      let real: string;
      try {
        real = this.real(this.syntax(c.path));
      } catch (e) {
        this.announce(c.path, { op: "root-refused", path: c.path, source: c.source, reason: (e as GateDenied).reason ?? String(e) });
        continue;
      }
      const problem = this.rootProblem(real);
      if (problem) {
        this.announce(real, { op: "root-refused", path: real, source: c.source, reason: problem });
        continue;
      }
      if (seen.has(this.key(real))) continue;
      seen.add(this.key(real));
      this.announce(real, { op: "root-added", path: real, source: c.source });
      out.push({ path: real, source: c.source });
    }
    // Dossiers propres à Jarod (écrits par le main seulement).
    for (const [p, source] of [
      [this.d.stagingRoot(), "staging"],
      [this.d.mediaRoot(), "media"],
    ] as const) {
      if (existsSync(p)) out.push({ path: this.tryReal(p), source });
    }
    return out;
  }

  private announce(path: string, entry: GateLogEntry): void {
    const k = `${entry.op}|${this.key(path)}`;
    if (this.announced.has(k)) return;
    this.announced.add(k);
    this.log(entry);
  }

  /**
   * `select-folder` : dossier choisi par l'utilisateur dans la boîte NATIVE → racine pour ce lancement (il le
   * reste s'il devient dossier de travail). Refusé (null) s'il ne peut pas être une racine.
   */
  pick(path: string): { ok: true; path: string } | { ok: false; reason: string } {
    try {
      const real = this.real(this.syntax(path));
      const problem = this.rootProblem(real);
      if (problem) {
        this.log({ op: "root-refused", channel: "select-folder", path: real, source: "select-folder", reason: problem });
        return { ok: false, reason: problem };
      }
      this.picked.add(real);
      this.announced.add(`root-added|${this.key(real)}`);
      this.log({ op: "root-added", channel: "select-folder", path: real, source: "select-folder" });
      return { ok: true, path: real };
    } catch (e) {
      const reason = e instanceof GateDenied ? e.reason : String(e);
      this.log({ op: "root-refused", channel: "select-folder", path: String(path), source: "select-folder", reason });
      return { ok: false, reason };
    }
  }

  /**
   * Dossier lié à une conversation (`set-session-context-folder`, `send-message`) : choisi dans la boîte native
   * pendant ce lancement, ou déjà sous une racine de travail — jamais un chemin libre du renderer. Rend le chemin réel.
   */
  bindable(channel: string, path: unknown): string {
    try {
      const real = this.real(this.syntax(path));
      if (!statSync(real).isDirectory()) throw new GateDenied("pas un dossier");
      const problem = this.rootProblem(real);
      if (problem) throw new GateDenied(problem);
      const known = this.picked.has(real) || this.roots().some((r) => r.source !== "staging" && r.source !== "media" && this.within(r.path, real));
      if (!known) throw new GateDenied("dossier non choisi par l'utilisateur (boîte « Choisir un dossier ») ni sous un dossier de travail");
      return real;
    } catch (e) {
      if (e instanceof GateDenied) this.log({ op: "deny", channel, path: String(path), reason: e.reason });
      throw e;
    }
  }

  /**
   * SPECS-P5-WORKSPACE.md §2.2 — dossier de travail PAR DÉFAUT (réglage persistant `workspace`). Plus strict que `bindable` : le dossier
   * doit avoir été choisi par l'utilisateur dans la boîte NATIVE pendant ce lancement ; « déjà sous un dossier de travail » ne suffit
   * pas (un réglage dure plus longtemps qu'un dossier de conversation). Exception : redonner la valeur DÉJÀ enregistrée (`current`)
   * est accepté. Rend le chemin réel ; toute autre issue est un `GateDenied` journalisé.
   */
  pickedOnly(channel: string, path: unknown, current: string | null): string {
    try {
      const real = this.real(this.syntax(path));
      if (!statSync(real).isDirectory()) throw new GateDenied("pas un dossier");
      const problem = this.rootProblem(real);
      if (problem) throw new GateDenied(problem);
      const stored = current ? this.tryReal(current) : null;
      const same = stored !== null && this.key(stored) === this.key(real);
      if (!this.picked.has(real) && !same) throw new GateDenied("dossier non choisi par l'utilisateur dans la boîte native pendant ce lancement");
      return real;
    } catch (e) {
      const denied = e instanceof GateDenied ? e : new GateDenied(e instanceof Error ? e.message : String(e));
      this.log({ op: "deny", channel, path: typeof path === "string" ? path : String(path), reason: denied.reason });
      throw denied;
    }
  }

  // ---- accès ------------------------------------------------------------------------------------------------

  /**
   * Chemin venu du renderer → chemin réel autorisé (sous une racine, hors interdits, du bon type), sinon
   * `GateDenied` (journalisé).
   */
  authorize(channel: string, path: unknown, kind: "file" | "dir"): string {
    try {
      const real = this.real(this.syntax(path));
      const reason = this.forbiddenReason(real);
      if (reason) throw new GateDenied(reason);
      if (!this.roots().some((r) => this.within(r.path, real))) throw new GateDenied("hors des dossiers de travail");
      const st = statSync(real);
      if (kind === "file" && !st.isFile()) throw new GateDenied("pas un fichier");
      if (kind === "dir" && !st.isDirectory()) throw new GateDenied("pas un dossier");
      return real;
    } catch (e) {
      const reason = e instanceof GateDenied ? e.reason : String(e);
      this.log({ op: "deny", channel, path: typeof path === "string" ? path : String(path), reason });
      throw e instanceof GateDenied ? e : new GateDenied(reason);
    }
  }

  /**
   * Chemin choisi par l'utilisateur dans une boîte NATIVE (enregistrer sous, importer) : c'est son choix, pas
   * besoin d'être sous une racine — mais jamais un chemin interdit. `existing: false` = destination à créer
   * (jugée sur le dossier réel qui la contient + son nom).
   */
  userChosen(channel: string, path: string, existing: boolean): string {
    try {
      const p = this.syntax(path);
      const real = existing ? this.real(p) : join(this.real(dirname(p)), basename(p));
      const reason = this.forbiddenReason(real);
      if (reason) throw new GateDenied(reason);
      return real;
    } catch (e) {
      const reason = e instanceof GateDenied ? e.reason : String(e);
      this.log({ op: "deny", channel, path, reason });
      throw e instanceof GateDenied ? e : new GateDenied(reason);
    }
  }

  // ---- journal ----------------------------------------------------------------------------------------------

  log(entry: GateLogEntry): void {
    try {
      const file = this.d.logFile();
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl"));
      appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
    } catch {
      /* journal indisponible : l'accès reste jugé, jamais accordé à cause d'un journal */
    }
  }
}

/** Segment de nom sûr (SANK-UI `attachment-staging.ts:20-31`, `media.ts:41-48`) : ni séparateur ni contrôle. */
export function sanitizeSegment(value: unknown, fallback: string, max = 200): string {
  const cleaned = String(value ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intended, strips control characters from untrusted text
    .replace(/[\x00-\x1F<>:"/\\|?*]/g, "")
    .replace(/\s+/g, "_")
    .replace(/\.{2,}/g, ".")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.slice(0, max);
}

