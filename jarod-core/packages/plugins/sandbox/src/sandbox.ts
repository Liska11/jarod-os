/**
 * Bacs à sable jetables : profil → création → exécution → collecte → destruction.
 *
 * Ce service n'ouvre AUCUNE porte d'exécution à lui seul : toute commande passe par le garde du shell
 * (`ShellGuardService.plan` avec `writeScope: "workspace"`), c'est-à-dire par un mécanisme que le noyau tient
 * (AppContainer via `herald-sandbox` sous Windows, bwrap/firejail sous Linux) ou par un refus. Pas de
 * mécanisme vérifié : la commande n'est pas lancée. Exposer ce service à l'agent comme outil est l'affaire de
 * l'enregistrement d'outils, qui passe par `executeGuardedTool`.
 *
 * La destruction ne supprime que ce que le service a créé : un chemin qui sort de la racine gérée, ou qui est un
 * lien, est refusé.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { firstToken, type ShellGuardDeps, ShellGuardService } from "@jarod/plugin-permissions";
import { runShell } from "@jarod/plugin-tools";

export interface SandboxProfile {
  name: string;
  description: string;
  /** Délai maximal d'une commande, en millisecondes. */
  timeoutMs: number;
}

export const DEFAULT_PROFILES: SandboxProfile[] = [
  { name: "default", description: "Écriture dans le dossier du bac seulement, 2 minutes par commande.", timeoutMs: 120_000 },
  { name: "short", description: "Écriture dans le dossier du bac seulement, 20 secondes par commande.", timeoutMs: 20_000 },
];

export type SandboxState = "ready" | "destroyed";

export interface SandboxInfo {
  id: string;
  profile: string;
  dir: string;
  createdAt: number;
  state: SandboxState;
}

export interface CollectedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface Collected {
  files: CollectedFile[];
  added: string[];
  modified: string[];
  removed: string[];
}

export type ExecResult =
  | { kind: "refused"; reason: string }
  | { kind: "ran"; code: number | null; output: string; mechanism: string };

/** Un événement d'audit : jamais le texte de la commande (il peut contenir une valeur sensible), seulement son empreinte. */
export interface SandboxEvent {
  at: number;
  id: string;
  action: "create" | "exec" | "refused" | "collect" | "destroy";
  detail: Record<string, string | number | boolean | null>;
}

export class SandboxError extends Error {}

export type SandboxRunner = typeof runShell;

export interface SandboxDeps {
  /** Racine gérée : tous les bacs sont des dossiers directs de ce dossier. */
  root: string;
  profiles?: SandboxProfile[];
  /** Réglages injectables du garde (plateforme, sonde…) : les tests n'ont pas besoin de la machine. */
  guard?: Pick<ShellGuardDeps, "platform" | "env" | "probe">;
  runner?: SandboxRunner;
  onEvent?: (e: SandboxEvent) => void;
}

const ID = /^[0-9a-f]{16}$/;
const IGNORED_TOP = ".tmp";

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function manifest(dir: string): Map<string, CollectedFile> {
  const out = new Map<string, CollectedFile>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join("/");
      if (rel === IGNORED_TOP) continue;
      // Un lien n'est jamais suivi : ce qu'il désigne n'est pas dans le bac.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = readFileSync(full);
        out.set(rel, { path: rel, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  };
  walk(dir);
  return out;
}

export class SandboxService {
  private readonly boxes = new Map<string, SandboxInfo>();
  private readonly baselines = new Map<string, Map<string, CollectedFile>>();
  private readonly profiles: Map<string, SandboxProfile>;

  constructor(private readonly d: SandboxDeps) {
    this.profiles = new Map((d.profiles ?? DEFAULT_PROFILES).map((p) => [p.name, p]));
  }

  listProfiles(): SandboxProfile[] {
    return [...this.profiles.values()];
  }

  list(): SandboxInfo[] {
    return [...this.boxes.values()];
  }

  private emit(id: string, action: SandboxEvent["action"], detail: SandboxEvent["detail"] = {}): void {
    this.d.onEvent?.({ at: Date.now(), id, action, detail });
  }

  private get(id: string): SandboxInfo {
    const box = ID.test(id) ? this.boxes.get(id) : undefined;
    if (!box) throw new SandboxError(`bac inconnu : ${id}`);
    if (box.state !== "ready") throw new SandboxError(`le bac ${id} est détruit`);
    return box;
  }

  create(profile = "default"): SandboxInfo {
    const p = this.profiles.get(profile);
    if (!p) throw new SandboxError(`profil inconnu : ${profile}`);
    const root = resolve(this.d.root);
    mkdirSync(root, { recursive: true });
    if (isLink(root)) throw new SandboxError("la racine des bacs est un lien : refusée");
    const id = randomBytes(8).toString("hex");
    const dir = join(realpathSync.native(root), id);
    mkdirSync(dir);
    const info: SandboxInfo = { id, profile: p.name, dir, createdAt: Date.now(), state: "ready" };
    this.boxes.set(id, info);
    this.baselines.set(id, manifest(dir));
    this.emit(id, "create", { profile: p.name });
    return info;
  }

  async exec(id: string, line: string): Promise<ExecResult> {
    const box = this.get(id);
    const profile = this.profiles.get(box.profile)!;
    const guard = new ShellGuardService({
      workspace: box.dir,
      policy: { writeScope: "workspace" },
      ...(this.d.guard ?? {}),
    });
    const plan = await guard.plan(line, { cwd: box.dir });
    const program = firstToken(line);
    const digest = createHash("sha256").update(line).digest("hex").slice(0, 12);
    if (plan.kind === "refuse") {
      this.emit(id, "refused", { program, line: digest });
      return { kind: "refused", reason: plan.reason };
    }
    const run = this.d.runner ?? runShell;
    const result = await run(line, box.dir, undefined, profile.timeoutMs, plan);
    this.emit(id, "exec", { program, line: digest, mechanism: plan.mechanism, code: result.code });
    return { kind: "ran", code: result.code, output: result.output, mechanism: plan.mechanism };
  }

  /** Ce que le bac contient, et ce qui a changé depuis la création (ou la dernière collecte). */
  collect(id: string): Collected {
    const box = this.get(id);
    const before = this.baselines.get(id) ?? new Map<string, CollectedFile>();
    const now = manifest(box.dir);
    const added = [...now.keys()].filter((k) => !before.has(k));
    const removed = [...before.keys()].filter((k) => !now.has(k));
    const modified = [...now.keys()].filter((k) => before.has(k) && before.get(k)!.sha256 !== now.get(k)!.sha256);
    this.baselines.set(id, now);
    this.emit(id, "collect", { files: now.size, added: added.length, modified: modified.length, removed: removed.length });
    return { files: [...now.values()], added, modified, removed };
  }

  destroy(id: string): void {
    const box = this.get(id);
    const root = realpathSync.native(resolve(this.d.root));
    const real = realpathSync.native(box.dir);
    const rel = relative(root, real);
    if (isLink(box.dir) || !rel || rel !== id) {
      throw new SandboxError("le dossier du bac n'est plus ce que le service a créé : suppression refusée");
    }
    rmSync(real, { recursive: true, force: true });
    box.state = "destroyed";
    this.baselines.delete(id);
    this.emit(id, "destroy");
  }
}
