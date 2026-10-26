/**
 * Gestionnaire de dépendances d'exécution (Phase 3).
 *
 * Porté depuis `runtime-deps.cjs` (reconstruction, Phases 1-4) : inventaire **exécuté** (versions et
 * candidats du PATH, résolu et utilisateur), politiques par composant, proposition avec risque et
 * retour arrière, bascule `portable` réellement réversible, et refus d'une bascule système dont la
 * compatibilité n'est pas vérifiée — aucune installation de logiciel par ce module.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export const POLICIES = ["manual", "notify", "auto-safe", "auto-full"] as const;
export type Policy = (typeof POLICIES)[number];
export type ComponentKind = "system" | "portable";

export interface ComponentDef {
  id: string;
  name: string;
  probe: string[];
  alt?: string[];
  winget?: string;
  critical: boolean;
  kind: ComponentKind;
}
export const COMPONENTS: ComponentDef[] = [
  { id: "node", name: "Node.js", probe: ["node", "--version"], winget: "OpenJS.NodeJS.LTS", critical: true, kind: "system" },
  { id: "npm", name: "npm", probe: ["npm", "--version"], critical: false, kind: "system" },
  { id: "pnpm", name: "pnpm", probe: ["pnpm", "--version"], critical: false, kind: "system" },
  { id: "python", name: "Python", probe: ["python", "--version"], winget: "Python.Python.3.12", critical: true, kind: "system" },
  { id: "git", name: "Git", probe: ["git", "--version"], winget: "Git.Git", critical: true, kind: "system" },
  { id: "docker", name: "Docker", probe: ["docker", "--version"], critical: true, kind: "system" },
  { id: "wsl", name: "WSL", probe: ["wsl", "--version"], critical: true, kind: "system" },
  { id: "ollama", name: "Ollama", probe: ["ollama", "--version"], winget: "Ollama.Ollama", critical: false, kind: "system" },
  { id: "llamacpp", name: "llama.cpp", probe: ["llama-server", "--version"], alt: ["llama-cli", "--version"], critical: false, kind: "system" },
  { id: "restic", name: "restic", probe: ["restic", "version"], winget: "restic.restic", critical: false, kind: "system" },
  { id: "nvidia", name: "Pilote NVIDIA", probe: ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"], critical: true, kind: "system" },
];

export interface Candidate {
  path: string;
  resolved: boolean;
  user: boolean;
}
export interface ComponentInventory {
  id: string;
  name: string;
  kind: ComponentKind;
  critical: boolean;
  winget: string | null;
  installed: boolean;
  version: string | null;
  path: string | null;
  candidates: Candidate[];
  command: string;
  error: string | null;
}
export interface Inventory {
  at: string;
  platform: string;
  components: ComponentInventory[];
  pathCandidates: number;
}
export interface ComponentState {
  policy?: Policy;
  current?: string | null;
  available?: string | null;
  compatibility?: "verified" | "unverified" | string;
  pinned?: string | null;
  previous?: { version: string | null; dir: string; treeSha256: string; at: string } | null;
  installedAt?: string;
  installedTreeSha256?: string;
  kind?: ComponentKind;
  history?: { at: string; from: string | null; to: string | null; action?: string; verified?: boolean; treeSha256?: string }[];
}
export interface DepsState {
  schema: number;
  updatedAt: string;
  components: Record<string, ComponentState>;
}
export interface Proposal {
  id: string;
  name: string;
  kind: ComponentKind;
  current: string | null;
  available: string | null;
  updatePossible: boolean;
  risk: "critical" | "safe";
  why: string;
  compatibility: string;
  policy: Policy;
  tests: string[];
  rollback: { possible: boolean; how: string };
  missing: string[];
  recommendation: string;
}

const now = (): string => new Date().toISOString();
/** Sous Windows, un fichier sans extension (script shell Unix) n'est pas exécutable : il ne masque pas npm.cmd. */
const EXT = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""];

/** Résout TOUS les candidats d'une commande dans le PATH (sans rien modifier). */
export function whichAll(command: string, env: NodeJS.ProcessEnv = process.env): Candidate[] {
  const dirs = String(env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean);
  const found: string[] = [];
  for (const dir of dirs) {
    for (const ext of EXT) {
      const candidate = join(dir, command + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        found.push(candidate);
      } catch {
        // chemin absent : ce candidat n'existe pas
      }
    }
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of found) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  const home = String(env.APPDATA ?? env.LOCALAPPDATA ?? env.USERPROFILE ?? "").toLowerCase();
  return unique.map((p, i) => ({ path: p, resolved: i === 0, user: Boolean(home) && p.toLowerCase().startsWith(home) }));
}
function run(cmd: string, args: string[], timeout = 15_000): { ok: boolean; status: number | null; stdout: string; stderr: string; error: string | null } {
  // Depuis Node 20.12, lancer un .cmd/.bat sans shell lève EINVAL : on passe par cmd.exe.
  // Les arguments viennent de la table COMPONENTS (constantes du module), jamais d'une entrée externe.
  const viaShell = /\.(?:cmd|bat)$/i.test(cmd);
  const line = viaShell ? `"${cmd}" ${args.map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, "")}"` : a)).join(" ")}` : null;
  const r = viaShell
    ? spawnSync(line as string, { encoding: "utf8", timeout, windowsHide: true, shell: true })
    : spawnSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true });
  return { ok: r.status === 0, status: r.status, stdout: String(r.stdout ?? "").trim(), stderr: String(r.stderr ?? "").trim(), error: r.error ? String(r.error.message) : null };
}
const VERSION_RE = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;
export function versionOf(text: string): string | null {
  const m = VERSION_RE.exec(String(text ?? ""));
  return m ? m[0] : null;
}

/** Inventaire : réellement exécuté, un composant par entrée. */
export function inventory(opts: { env?: NodeJS.ProcessEnv; components?: ComponentDef[]; timeout?: number } = {}): Inventory {
  const env = opts.env ?? process.env;
  const out: ComponentInventory[] = [];
  for (const c of opts.components ?? COMPONENTS) {
    const candidates = whichAll(c.probe[0]!, env);
    const entry: ComponentInventory = {
      id: c.id,
      name: c.name,
      kind: c.kind,
      critical: Boolean(c.critical),
      winget: c.winget ?? null,
      installed: false,
      version: null,
      path: null,
      candidates,
      command: c.probe.join(" "),
      error: null,
    };
    if (!candidates.length) {
      entry.error = "commande absente du PATH";
      out.push(entry);
      continue;
    }
    // On essaie les candidats dans l'ordre du PATH jusqu'au premier qui répond réellement.
    let used = candidates[0]!;
    let r = run(used.path, c.probe.slice(1), opts.timeout);
    for (const cand of candidates.slice(1)) {
      if (r.ok) break;
      const attempt = run(cand.path, c.probe.slice(1), opts.timeout);
      if (attempt.ok) {
        used = cand;
        r = attempt;
        break;
      }
    }
    entry.path = used.path;
    if (r.ok) {
      entry.installed = true;
      entry.version = versionOf(r.stdout) ?? versionOf(r.stderr);
      if (!entry.version && c.id === "nvidia") entry.version = r.stdout.split("\n")[0]?.trim() ?? null;
    } else if (c.alt) {
      const altCandidates = whichAll(c.alt[0]!, env);
      if (altCandidates.length) {
        const r2 = run(altCandidates[0]!.path, c.alt.slice(1), opts.timeout);
        entry.path = altCandidates[0]!.path;
        entry.candidates = [...candidates, ...altCandidates];
        entry.installed = r2.ok;
        entry.version = r2.ok ? (versionOf(r2.stdout) ?? versionOf(r2.stderr)) : null;
      }
      if (!entry.installed) entry.error = r.error ?? `code ${String(r.status)}`;
    } else {
      entry.error = r.error ?? `code ${String(r.status)}`;
    }
    out.push(entry);
  }
  return { at: now(), platform: process.platform, components: out, pathCandidates: out.reduce((n, c) => n + c.candidates.length, 0) };
}

export function emptyState(): DepsState {
  return { schema: 1, updatedAt: now(), components: {} };
}
export function loadState(file: string): DepsState {
  if (!file || !existsSync(file)) return emptyState();
  const raw = JSON.parse(readFileSync(file, "utf8")) as DepsState;
  if (!raw.components || typeof raw.components !== "object") throw new Error("état des dépendances : « components » manquant");
  return raw;
}
export function saveState(file: string, state: DepsState): void {
  mkdirSync(dirname(file), { recursive: true });
  state.updatedAt = now();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}
export function policyOf(state: DepsState, id: string): { policy: Policy; pinned: string | null; current: string | null; available: string | null; compatibility: string; previous: ComponentState["previous"] } {
  const e = state.components[id];
  return {
    policy: e?.policy ?? "notify",
    pinned: e?.pinned ?? null,
    current: e?.current ?? null,
    available: e?.available ?? null,
    compatibility: e?.compatibility ?? "unverified",
    previous: e?.previous ?? null,
  };
}
export function setPolicy(state: DepsState, id: string, policy: Policy, extra: Partial<ComponentState> = {}): ComponentState {
  if (!POLICIES.includes(policy)) throw new Error(`politique inconnue : ${policy} (attendu ${POLICIES.join(", ")})`);
  const entry = (state.components[id] ??= { history: [] });
  const from = entry.policy ?? "notify";
  entry.policy = policy;
  Object.assign(entry, extra);
  entry.history = [...(entry.history ?? []), { at: now(), from, to: policy }].slice(-30);
  return entry;
}

const RISK = {
  critical: "composant critique : une bascule peut casser le moteur, l'isolation ou le pilote ; test de compatibilité obligatoire",
  safe: "composant non critique : mise à jour après tests non destructifs",
};
export function propose(state: DepsState, id: string, disc: { version?: string | null } = {}): Proposal {
  const c = COMPONENTS.find((x) => x.id === id) ?? null;
  if (!c) throw new Error(`composant inconnu : ${id}`);
  const st = policyOf(state, id);
  const entry = state.components[id] ?? {};
  const current = entry.current ?? disc.version ?? null;
  const available = entry.available ?? null;
  const compatibility = entry.compatibility ?? "unverified";
  const risk = c.critical ? "critical" : "safe";
  const rollback =
    c.kind === "portable"
      ? { possible: true, how: "restaurer le dossier de la version précédente (conservé)" }
      : {
          possible: Boolean(entry.previous?.version && (entry.previous as { reinstallable?: boolean }).reinstallable),
          how: entry.previous?.version ? `réinstaller la version ${entry.previous.version}` : "version précédente non conservée : retour arrière non garanti",
        };
  return {
    id,
    name: c.name,
    kind: c.kind,
    current,
    available,
    updatePossible: Boolean(available && current && available !== current),
    risk,
    why: c.critical ? RISK.critical : RISK.safe,
    compatibility,
    policy: st.policy,
    tests:
      c.kind === "portable"
        ? ["empreinte du dossier installé", "exécution du composant", "retour arrière restauré"]
        : ["version après bascule", "compatibilité modèle/runtime/GPU", "retour arrière disponible"],
    rollback,
    missing: available ? [] : ["version disponible inconnue : la découverte exige winget (réseau) et un accord"],
    recommendation: !available
      ? "ne rien faire sans connaître la version disponible"
      : risk === "critical"
        ? "proposer, ne pas appliquer sans test de compatibilité"
        : "appliquer en `auto-safe` après tests, ou sur accord",
  };
}

export function digestTrees(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : String(e.name);
      if (e.isDirectory()) walk(join(dir, String(e.name)), r);
      else {
        h.update(`${r}\0`);
        h.update(readFileSync(join(dir, String(e.name))));
        h.update("\0");
      }
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/**
 * Bascule d'un composant `portable` : l'ancien dossier est conservé (`<root>.previous`), le nouveau
 * est copié, vérifié, et le retour arrière restaure l'ancien à l'identique.
 * Sans `newDir`, la nouvelle version est cherchée dans `engines/<id>.next` (aucun chemin dans l'UI).
 */
export function applyPortable(
  state: DepsState,
  id: string,
  opts: { newDir?: string; enginesRoot: string; approve?: boolean; verify?: ((dir: string) => { ok: boolean; detail: string }) | null },
): { id: string; applied: boolean; previousDir: string; previousTreeSha256: string; installedTreeSha256: string; copiedTreeSha256: string; verified: { ok: boolean; detail: string } } {
  if (!opts.approve) throw new Error("mise à jour refusée : accord explicite requis");
  const stagedDir = opts.newDir ?? join(opts.enginesRoot, `${id}.next`);
  if (!stagedDir || !existsSync(stagedDir)) throw new Error(`nouvelle version introuvable : ${stagedDir}`);
  const target = join(opts.enginesRoot, id);
  if (!existsSync(target)) throw new Error(`composant absent : ${target} (une première installation n'est pas une mise à jour)`);
  const previous = `${target}.previous`;
  rmSync(previous, { recursive: true, force: true });
  cpSync(target, previous, { recursive: true });
  const previousDigest = digestTrees(previous);
  const staged = `${target}.new`;
  rmSync(staged, { recursive: true, force: true });
  cpSync(stagedDir, staged, { recursive: true });
  const copiedDigest = digestTrees(staged);
  rmSync(target, { recursive: true, force: true });
  renameSync(staged, target);
  const installedDigest = digestTrees(target);
  const verified = opts.verify ? opts.verify(target) : { ok: true, detail: "aucune vérification demandée" };
  const entry = (state.components[id] ??= { history: [] });
  entry.kind = "portable";
  entry.current = entry.current ?? null;
  entry.previous = { version: entry.current, dir: previous, treeSha256: previousDigest, at: now() };
  entry.installedAt = now();
  entry.installedTreeSha256 = installedDigest;
  entry.history = [...(entry.history ?? []), { at: now(), from: entry.current, to: copiedDigest, action: "apply", verified: Boolean(verified.ok) }].slice(-30);
  return { id, applied: true, previousDir: previous, previousTreeSha256: previousDigest, installedTreeSha256: installedDigest, copiedTreeSha256: copiedDigest, verified };
}

export function rollbackPortable(state: DepsState, id: string, opts: { enginesRoot: string; approve?: boolean }): { id: string; rolledBack: boolean; restoredTreeSha256: string } {
  if (!opts.approve) throw new Error("retour arrière refusé : accord explicite requis");
  const entry = state.components[id];
  if (!entry?.previous?.dir || !existsSync(entry.previous.dir)) throw new Error(`${id} : aucune version précédente conservée`);
  const target = join(opts.enginesRoot, id);
  rmSync(target, { recursive: true, force: true });
  cpSync(entry.previous.dir, target, { recursive: true });
  const restored = digestTrees(target);
  if (restored !== entry.previous.treeSha256) {
    throw new Error(`${id} : restauration altérée (${restored.slice(0, 12)} ≠ ${entry.previous.treeSha256.slice(0, 12)})`);
  }
  const from = entry.current;
  entry.current = entry.previous.version ?? null;
  delete entry.previous;
  entry.history = [...(entry.history ?? []), { at: now(), from: from ?? null, to: entry.current, action: "rollback", treeSha256: restored }].slice(-30);
  return { id, rolledBack: true, restoredTreeSha256: restored };
}

/** Bascule d'un composant `system` : jamais exécutée sans accord ET compatibilité vérifiée. */
export function applySystem(state: DepsState, id: string, opts: { approve?: boolean; compatibility?: string | null } = {}): { id: string; executed: boolean; reason: string } {
  const c = COMPONENTS.find((x) => x.id === id);
  if (!c) throw new Error(`composant inconnu : ${id}`);
  const entry = state.components[id] ?? {};
  if (!opts.approve) throw new Error("mise à jour système refusée : accord explicite requis (aucune bascule sans vous)");
  const compat = opts.compatibility ?? entry.compatibility ?? "unverified";
  if (compat !== "verified") throw new Error(`mise à jour système refusée : compatibilité non vérifiée (${compat}) — testez modèle/runtime/GPU avant la bascule`);
  if (!c.winget) throw new Error(`${id} : aucune source de mise à jour connue (winget)`);
  return { id, executed: false, reason: "bascule winget non exécutée : elle exige une commande d'installation hors de ce module (accord humain, installation de logiciel)" };
}
