// Portage de packages/core/src/services/shell-guard.ts (rév. 2e180305).
/**
 * Le garde du shell : il DÉCIDE (autoriser / refuser / demander l'accord) et il n'exécute sous
 * confinement que si un mécanisme réellement vérifiable existe sur cette machine.
 *
 * ── Ce qui est réellement tenu ici, et par quoi ────────────────────────────────────────────────
 *  - `bwrap` (bubblewrap, Linux) et `firejail` (Linux) : espaces de noms du noyau. La racine est
 *    montée en LECTURE SEULE, puis le dossier autorisé est remonté en lecture-écriture. Le
 *    processus ne peut pas écrire ailleurs : ce n'est pas un filtre sur du texte, c'est le noyau
 *    qui refuse le `write(2)`. Le mécanisme n'est employé que si l'on vient de vérifier qu'il
 *    existe ET qu'il s'exécute ; sinon on refuse de lancer (voir `mechanism()`).
 *
 * ── Ce qui n'est PAS tenu, et qui est donc refusé au lieu d'être promis ─────────────────────────
 *  - `jarod-sandbox` (Windows) : un AppContainer par commande (crate `host-sandbox`, binaire
 *    `jarod-sandbox`). Le SID du conteneur reçoit « modification » sur le dossier de travail et rien
 *    d'autre : c'est le noyau qui refuse tout `write` ailleurs, enfants compris. Le mécanisme n'est
 *    retenu qu'après avoir exécuté `jarod-sandbox selftest`, qui prouve sur CETTE machine qu'une écriture
 *    dedans réussit et qu'une écriture à côté échoue. Sans le binaire, ou si l'épreuve échoue,
 *    `writeScope: "workspace"` est REFUSÉ, avec la raison : la commande n'est jamais lancée sans
 *    protection. Limites : voir host-rust/docs/sandbox.md (`dir`/`del`/`attrib` de cmd ne marchent pas
 *    dedans ; seuls les dossiers système sont sur le PATH de la commande).
 *  - macOS : `sandbox-exec` existe mais Apple le déprécie, et il n'est pas déclaré ici ; le
 *    confinement y est donc refusé aussi, plutôt que présenté comme acquis.
 *  - La liste des programmes autorisés n'est PAS un confinement : une commande peut en enchaîner une
 *    autre, et une redirection (`>`) n'est pas un binaire. Elle vérifie le binaire réellement résolu
 *    sur le disque (chemin réel, liens suivis), ce qui est une politique — pas une prison. Cette
 *    limite est écrite ici pour que personne ne s'y trompe.
 *
 * ── Comportement par défaut ────────────────────────────────────────────────────────────────────
 *  `DEFAULT_SHELL_POLICY` ne demande aucun confinement et ne restreint aucun programme : sans
 *  réglage explicite, `run_shell` lance exactement ce qu'il lançait avant. Un défaut qui refuserait
 *  tout ne protégerait personne : il casserait l'usage légitime, et il serait désactivé.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ToolCall } from "@jarod/contracts";
import { containerPath, DEFAULT_DOCKER, type DockerOptions, DockerSandbox, execArgs } from "./docker-sandbox.js";
import { type WriteScope, type ShellPolicy, DEFAULT_SHELL_POLICY } from "@jarod/contracts";
export { DEFAULT_SHELL_POLICY };
export type { WriteScope, ShellPolicy };

// ---------------------------------------------------------------------------------------------
// Politique
// ---------------------------------------------------------------------------------------------

// WriteScope : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

// ShellPolicy : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

// DEFAULT_SHELL_POLICY : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

/** Les mécanismes que le garde sait construire. Ni macOS ni Windows n'en ont : c'est un refus. */
export type MechanismId = "bwrap" | "firejail" | "sandbox-exec" | "jarod-sandbox" | "mxc" | "docker";

export interface ShellMechanismStatus {
  available: boolean;
  id: MechanismId | null;
  path: string | null;
  /** La phrase à montrer : pourquoi c'est disponible, ou pourquoi ça ne l'est pas. */
  detail: string;
}

export interface ShellRefusal {
  kind: "refuse";
  /** Le programme visé, quand le refus porte sur lui. */
  program: string | null;
  reason: string;
}

export interface ShellLaunchPlan {
  kind: "plan";
  /** `shell` : la ligne de commande telle quelle (comportement historique). `exec` : un binaire et
   * ses arguments, sans shell intermédiaire — c'est la forme que prend un vrai confinement. */
  mode: "shell" | "exec";
  bin: string;
  args: string[];
  cwd: string;
  mechanism: MechanismId | "none";
  /** Les chemins RÉELS où l'écriture est permise (vides quand `writeScope` vaut `off`). */
  writableRoots: string[];
  /** Ce qui limite la commande, dit en clair, pour la trace et pour l'utilisateur. */
  detail: string;
}

export type ShellPlanResult = ShellLaunchPlan | ShellRefusal;

/** La porte d'approbation EXISTANTE du cœur (celle des outils `dangerous`) : rien de nouveau. */
export type ShellApprover = (sessionId: string, call: ToolCall, toolDescription: string) => Promise<boolean>;

/** Ce que `/shell-guard` affiche : la politique en vigueur, telle qu'elle sera appliquée. */
export interface ShellGuardView {
  platform: string;
  writeScope: WriteScope;
  environment: "local" | "docker";
  mechanism: ShellMechanismStatus;
  /** Les chemins réels où l'écriture est permise. */
  writableRoots: string[];
  allowedPrograms: string[];
  deniedPrograms: string[];
  askPrograms: string[];
}

// ---------------------------------------------------------------------------------------------
// Chemins : mêmes règles que `resolveInWorkspace` (chemin RÉEL, liens et jonctions suivis).
// Recopiées ici pour que le service ne dépende pas de l'outil et n'introduise pas de cycle.
// ---------------------------------------------------------------------------------------------

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/** Le chemin réel de `p`, ou celui de son plus proche parent existant suivi du reste. */
function realPathOf(p: string): string {
  let existing = p;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return p;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
    existing = parent;
  }
  try {
    return join(realpathSync.native(existing), ...rest);
  } catch {
    return p;
  }
}

/**
 * Le premier mot de la ligne, guillemets respectés : c'est le programme, et rien d'autre.
 * Un préfixe d'environnement POSIX (`VAR=valeur cmd`) est sauté, sinon `VAR=1 node x` serait pris
 * pour le programme `VAR=1` — et une politique qui se trompe de programme refuse au hasard.
 */
export function firstToken(command: string): string {
  const words: string[] = [];
  let current = "";
  let quote = "";
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);
  return words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";
}

/** Le nom comparable d'un programme : minuscules, sans l'extension Windows. */
export function programKey(name: string): string {
  return basename(name)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

/**
 * Le binaire sur le PATH, extensions Windows comprises.
 *
 * Recopié ici volontairement : le garde est importé par les outils, eux-mêmes importés par le
 * module LSP — importer `findOnPath` depuis là créerait un cycle d'import pour quinze lignes.
 */
function onPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  const exts =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())]
      : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Mécanismes : ce qui tient vraiment la promesse, et ce qui prouve qu'ils sont là
// ---------------------------------------------------------------------------------------------

interface MechanismDef {
  id: MechanismId;
  binary: string;
  /** Les systèmes où ce mécanisme existe. Ailleurs il n'y a rien à proposer : ce sera un refus. */
  platforms: NodeJS.Platform[];
  /** L'argument qui prouve que le binaire s'exécute vraiment, pas seulement qu'il est là. */
  versionArg: string;
  /** Vrai quand la sonde doit AUSSI se terminer par le code 0 (l'épreuve de `jarod-sandbox`). */
  mustExitZero?: boolean;
  /** Une variable d'environnement qui désigne le binaire quand il n'est pas sur le PATH. */
  envPath?: string;
  /** Ancien nom de la variable (avant le renommage), lu seulement si le nouveau n'est pas réglé. */
  legacyEnvPath?: string;
  /** Un mécanisme porté par un script (ex. MXC) : la variable qui désigne le script, et celle qui désigne son moteur.
   * Sans les deux, le mécanisme est absent — jamais deviné. */
  launcherEnv?: string;
  gateEnv?: string;
  /** La ligne de commande qui retient le processus : racine en lecture seule, dossier autorisé en
   * lecture-écriture. C'est le noyau qui l'applique, pas une analyse de texte. */
  build(input: { bin: string; command: string; cwd: string; roots: string[]; launcher?: string }): string[];
}

const MECHANISMS: MechanismDef[] = [
  {
    id: "bwrap",
    binary: "bwrap",
    platforms: ["linux"],
    versionArg: "--version",
    // `--ro-bind / /` puis `--bind <dossier> <dossier>` : la racine redevient inscriptible nulle part
    // sauf dans les dossiers autorisés. Le réseau n'est PAS coupé : le confinement demandé porte sur
    // les écritures, et un `pnpm install` légitime doit continuer de marcher.
    build: ({ bin, command, cwd, roots }) => [
      bin,
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-ipc",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      ...roots.flatMap((r) => ["--bind", r, r]),
      "--chdir",
      cwd,
      "--",
      "/bin/sh",
      "-c",
      command,
    ],
  },
  {
    id: "firejail",
    binary: "firejail",
    platforms: ["linux"],
    versionArg: "--version",
    // Même idée, autres options : tout est en lecture seule, puis les dossiers autorisés repassent
    // en lecture-écriture.
    build: ({ bin, command, roots }) => [
      bin,
      "--quiet",
      "--noprofile",
      "--private-tmp",
      "--read-only=/",
      ...roots.map((r) => `--read-write=${r}`),
      "--",
      "/bin/sh",
      "-c",
      command,
    ],
  },
  {
    id: "sandbox-exec",
    binary: "sandbox-exec",
    platforms: ["darwin"],
    versionArg: "-h",
    // Seatbelt, le mécanisme du noyau de macOS (celui des applications du Mac App Store) : tout est
    // permis sauf l'écriture, rouverte seulement dans les dossiers autorisés et les temporaires.
    build: ({ bin, command, roots }) => [bin, "-p", seatbeltProfile(roots), "/bin/sh", "-c", command],
  },
  {
    id: "jarod-sandbox",
    binary: "jarod-sandbox",
    platforms: ["win32"],
    versionArg: "selftest",
    mustExitZero: true,
    envPath: "JAROD_SANDBOX_BIN",
    legacyEnvPath: "HERALD_SANDBOX_BIN",
    // Un AppContainer : le dossier de travail est le seul endroit inscriptible. La ligne passe telle quelle
    // à `cmd /D /S /C` ; le délai du garde est l'autorité (le binaire n'a que le plafond de sécurité).
    build: ({ bin, command, cwd, roots }) => [
      bin,
      "exec",
      "--workspace",
      roots[0] ?? cwd,
      "--cwd",
      cwd,
      "--timeout",
      "86400",
      "--",
      command,
    ],
  },
  {
    // A1 (microsoft/mxc) : ProcessContainer de Windows, derrière `sidecars/mxc-run/mxc_run.mjs`. Essayé APRÈS jarod-sandbox : il
    // ne remplace rien, il tient le confinement là où jarod-sandbox est absent. Absent tant que JAROD_MXC_RUNNER et JAROD_MXC_SDK
    // ne sont pas réglés. Écriture dans le dossier de travail seulement, réseau refusé, secrets du coffre non transmis (refus).
    id: "mxc",
    binary: "node",
    platforms: ["win32"],
    versionArg: "selftest",
    mustExitZero: true,
    launcherEnv: "JAROD_MXC_RUNNER",
    gateEnv: "JAROD_MXC_SDK",
    build: ({ bin, command, cwd, roots, launcher }) => [
      bin,
      launcher ?? "",
      "exec",
      "--workspace",
      roots[0] ?? cwd,
      "--cwd",
      cwd,
      "--timeout",
      "600",
      "--",
      command,
    ],
  },
];

/** Le profil Seatbelt : écriture refusée partout, sauf dans `roots` et les temporaires du système. */
export function seatbeltProfile(roots: string[]): string {
  const q = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const allowed = [
    ...roots.map((r) => `(subpath ${q(r)})`),
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
    '(literal "/dev/null")',
    '(literal "/dev/zero")',
    '(regex #"^/dev/tty")',
    '(regex #"^/dev/fd/")',
  ];
  return ["(version 1)", "(allow default)", "(deny file-write*)", `(allow file-write* ${allowed.join(" ")})`].join(
    "\n",
  );
}

export interface ShellProbeInput {
  id: MechanismId;
  binary: string;
  platforms: NodeJS.Platform[];
  versionArg: string;
  mustExitZero?: boolean;
  envPath?: string;
  legacyEnvPath?: string;
  launcherEnv?: string;
  gateEnv?: string;
}

export interface ShellProbeResult {
  ok: boolean;
  path: string | null;
  detail: string;
}

export type ShellProbe = (
  input: ShellProbeInput,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => ShellProbeResult;

/**
 * Le contrôle par défaut : le binaire est sur le PATH, ET il s'exécute vraiment — on le lance une
 * fois avec son argument de version. « Présent » ne veut pas dire « utilisable », et un mécanisme
 * cru présent alors qu'il ne démarre pas serait exactement le mensonge à éviter. Sur un système où
 * le mécanisme n'existe pas (Windows, macOS), rien n'est lancé du tout : la réponse est un refus.
 */
export function probeMechanism(
  input: ShellProbeInput,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellProbeResult {
  if (!input.platforms.includes(platform)) {
    return { ok: false, path: null, detail: `n'existe pas sur ${platform}` };
  }
  const named = input.envPath ? (env[input.envPath] ?? (input.legacyEnvPath ? env[input.legacyEnvPath] : undefined)) : undefined;
  const found = named && existsSync(named) ? named : onPath(input.binary, env, platform);
  if (!found) return { ok: false, path: null, detail: "absent du PATH" };
  const real = realPathOf(found);
  // Un mécanisme porté par un script : les deux variables doivent désigner des fichiers présents, sinon il est absent.
  let probeArgs = [input.versionArg];
  if (input.launcherEnv) {
    const script = env[input.launcherEnv];
    const engine = input.gateEnv ? env[input.gateEnv] : undefined;
    if (!script || !existsSync(script)) return { ok: false, path: null, detail: `non configuré (${input.launcherEnv} ne désigne aucun script)` };
    if (input.gateEnv && (!engine || !existsSync(engine))) return { ok: false, path: null, detail: `non configuré (${input.gateEnv} ne désigne aucun moteur)` };
    probeArgs = [script, input.versionArg];
  }
  // L'épreuve de `jarod-sandbox` démarre de vrais conteneurs : elle a droit à plus que 5 secondes.
  const probed = spawnSync(real, probeArgs, {
    timeout: input.mustExitZero ? 60_000 : 5_000,
    windowsHide: true,
    env,
  });
  if (probed.error) {
    return {
      ok: false,
      path: real,
      detail: `trouvé en ${real} mais ne démarre pas : ${probed.error.message}`,
    };
  }
  if (input.mustExitZero && probed.status !== 0) {
    const said = String(probed.stdout ?? "").trim().slice(0, 300);
    return {
      ok: false,
      path: real,
      detail: `${input.binary} en ${real} a échoué à son épreuve sur cette machine (code ${probed.status}) : ${said || "aucune sortie"}`,
    };
  }
  return { ok: true, path: real, detail: `${input.binary} en ${real}, exécuté à l'instant pour vérifier` };
}

/** Ce qu'il faut dire quand aucun mécanisme n'est disponible : la vérité, par plateforme. */
function unavailableReason(tried: string[], platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return (
      `sur win32, le confinement des écritures demande le binaire jarod-sandbox (AppContainer, crate host-sandbox) ou MXC : ${tried.join(" ; ") || "aucun essai"}. ` +
      "Le premier peut être indiqué par JAROD_SANDBOX_BIN (ou l'ancien HERALD_SANDBOX_BIN), le second par JAROD_MXC_RUNNER et JAROD_MXC_SDK. L'environnement Docker, lui, tient aussi ce confinement : " +
      "chaque commande tourne dans un conteneur qui ne partage que le dossier de travail"
    );
  }
  if (platform === "darwin") {
    return `sur darwin, sandbox-exec (Seatbelt) est introuvable : ${tried.join(" ; ") || "aucun essai"}`;
  }
  return tried.length ? tried.join(" ; ") : `aucun mécanisme connu pour ${platform}`;
}

// ---------------------------------------------------------------------------------------------
// Le service
// ---------------------------------------------------------------------------------------------

export interface ShellGuardDeps {
  /** Le dossier de travail autorisé. Sans lui, aucun confinement n'est possible : on refusera. */
  workspace: string | null;
  /** Le réglage de l'utilisateur ; incomplet, il est complété par le défaut. */
  policy?: Partial<ShellPolicy> | null;
  /** La porte d'approbation du cœur, quand l'appelant en a une. Sans elle, un « accord » refuse. */
  approve?: ShellApprover | null;
  sessionId?: string;
  /** Injectables : les tests décident de la plateforme et du mécanisme, sans dépendre de la machine. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  probe?: ShellProbe;
  /** Le pilote de Docker (injectable : les tests n'ont pas besoin d'un démon). */
  docker?: DockerSandbox;
}

export class ShellGuardService {
  private readonly probed = new Map<MechanismId, ShellProbeResult>();

  constructor(private readonly d: ShellGuardDeps) {}

  get platform(): NodeJS.Platform {
    return this.d.platform ?? process.platform;
  }

  private get env(): NodeJS.ProcessEnv {
    return this.d.env ?? process.env;
  }

  /** La politique effective : le défaut, complété (et jamais remplacé) par le réglage. */
  policy(): ShellPolicy {
    const p = this.d.policy ?? {};
    return {
      writeScope: p.writeScope === "workspace" ? "workspace" : "off",
      writableRoots: p.writableRoots ?? [],
      allowedPrograms: p.allowedPrograms ?? [],
      deniedPrograms: p.deniedPrograms ?? [],
      askPrograms: p.askPrograms ?? [],
      environment: p.environment === "docker" ? "docker" : "local",
      docker: { ...DEFAULT_DOCKER, ...(p.docker ?? {}) },
    };
  }

  /**
   * Ce que la machine sait faire, vérifié maintenant. Le résultat est mémorisé : on ne relance pas
   * un binaire à chaque commande, mais on ne le suppose jamais présent sans l'avoir vu démarrer.
   */
  mechanism(): ShellMechanismStatus {
    const tried: string[] = [];
    for (const def of MECHANISMS) {
      const input: ShellProbeInput = {
        id: def.id,
        binary: def.binary,
        platforms: def.platforms,
        versionArg: def.versionArg,
        mustExitZero: def.mustExitZero,
        envPath: def.envPath,
        legacyEnvPath: def.legacyEnvPath,
        launcherEnv: def.launcherEnv,
        gateEnv: def.gateEnv,
      };
      let result = this.probed.get(def.id);
      if (!result) {
        result = (this.d.probe ?? probeMechanism)(input, this.platform, this.env);
        this.probed.set(def.id, result);
      }
      if (result.ok && result.path) return { available: true, id: def.id, path: result.path, detail: result.detail };
      tried.push(`${def.binary} : ${result.detail}`);
    }
    return { available: false, id: null, path: null, detail: unavailableReason(tried, this.platform) };
  }

  /** Les chemins réels où l'écriture est permise : le dossier de travail, plus ceux de la politique. */
  writableRoots(): { ok: true; roots: string[] } | { ok: false; reason: string } {
    const policy = this.policy();
    const extra = policy.writableRoots;
    if (!extra.length) return { ok: true, roots: [] };
    if (!this.d.workspace) {
      return {
        ok: false,
        reason:
          "des dossiers d'écriture sont réglés alors qu'aucun dossier de travail n'est défini : " +
          "rien ne dit à quoi les rattacher",
      };
    }
    const rootReal = realPathOf(resolve(this.d.workspace));
    const roots: string[] = [];
    for (const entry of extra) {
      const abs = isAbsolute(entry) ? resolve(entry) : resolve(this.d.workspace, entry);
      const real = realPathOf(abs);
      // Vérification sur le chemin RÉEL : une jonction posée dans le dossier de travail et pointant
      // dehors est refusée ici, parce que ce qui compte est l'endroit où l'écriture arrive vraiment.
      if (!inside(rootReal, real)) {
        return {
          ok: false,
          reason: `« ${entry} » sort du dossier de travail (chemin réel : ${real}, autorisé : ${rootReal})`,
        };
      }
      if (!existsSync(real)) {
        return { ok: false, reason: `« ${entry} » n'existe pas (chemin réel : ${real})` };
      }
      roots.push(real);
    }
    return { ok: true, roots };
  }

  /** Le programme que la ligne lancerait vraiment : son chemin réel, ou null s'il est introuvable. */
  resolveProgram(command: string, cwd: string): { name: string; path: string | null } {
    const first = firstToken(command);
    if (!first) return { name: "", path: null };
    const direct = isAbsolute(first) || /^[.][\\/]/.test(first) || /^[.][.][\\/]/.test(first);
    if (direct) {
      const abs = resolve(cwd, first);
      return { name: basename(first), path: existsSync(abs) ? realPathOf(abs) : null };
    }
    const found = onPath(first, this.env, this.platform);
    return { name: basename(first), path: found ? realPathOf(found) : null };
  }

  private inList(list: string[], name: string, path: string | null): boolean {
    const key = programKey(name);
    for (const entry of list) {
      if (programKey(entry) === key) return true;
      // Un chemin absolu dans la politique vaut aussi, vérifié sur le chemin réel.
      if (isAbsolute(entry) && path && realPathOf(entry) === path) return true;
    }
    return false;
  }

  private refuse(reason: string, program: string | null): ShellRefusal {
    return { kind: "refuse", program, reason: `Refusé — ${reason} La commande n'a PAS été lancée.` };
  }

  /**
   * Décide du sort d'une ligne de commande et rend de quoi la lancer.
   *
   * L'ordre compte : on refuse d'abord ce qui est refusable (programme, chemins, mécanisme), et on
   * ne demande l'accord de l'utilisateur que pour ce qui pourrait réellement partir — demander un
   * accord pour une commande qu'on refuserait de toute façon, c'est du bruit.
   */
  async plan(
    command: string,
    opts: { writeScope?: WriteScope; cwd?: string; envKeys?: string[] } = {},
  ): Promise<ShellPlanResult> {
    const line = String(command ?? "").trim();
    if (!line) return this.refuse("la commande est vide.", null);
    const policy = this.policy();
    const scope: WriteScope = opts.writeScope ?? policy.writeScope;
    const cwd = resolve(opts.cwd ?? this.d.workspace ?? process.cwd());

    // 1. Le programme : vérifié sur le binaire réellement résolu, jamais sur le texte de la ligne.
    //    Dans un conteneur, le binaire est celui de l'image : il n'existe pas sur la machine, seul
    //    son nom est comparable.
    const inDocker = policy.environment === "docker";
    const program = inDocker ? { name: basename(firstToken(line)), path: null } : this.resolveProgram(line, cwd);
    if (policy.deniedPrograms.length && this.inList(policy.deniedPrograms, program.name, program.path)) {
      return this.refuse(`le programme « ${program.name} » est refusé par la politique.`, program.name);
    }
    if (policy.allowedPrograms.length) {
      if (!program.name) return this.refuse("aucun programme n'est lisible dans cette ligne.", null);
      if (!program.path && !inDocker) {
        return this.refuse(
          `le programme « ${program.name} » est introuvable sur cette machine : on ne peut donc pas vérifier qu'il est autorisé (autorisés : ${policy.allowedPrograms.join(", ")}).`,
          program.name,
        );
      }
      if (!this.inList(policy.allowedPrograms, program.name, program.path)) {
        return this.refuse(
          `le programme « ${program.name} » (${program.path}) n'est pas dans la liste des programmes autorisés : ${policy.allowedPrograms.join(", ")}.`,
          program.name,
        );
      }
    }

    // 2. Les chemins d'écriture, vérifiés sur le chemin réel (une jonction qui sort est refusée).
    const roots = this.writableRoots();
    if (!roots.ok) return this.refuse(`le confinement demandé est intenable : ${roots.reason}.`, program.name);

    // 3. Le confinement des écritures, s'il est demandé : tenu par le noyau, ou refusé.
    let mechanism: MechanismId | "none" = "none";
    let planRoots: string[] = [];
    let dockerPlan: { bin: string; args: string[]; detail: string } | null = null;
    if (inDocker) {
      if (!this.d.workspace) {
        return this.refuse(
          "l'environnement Docker a besoin d'un dossier de travail à partager avec le conteneur.",
          program.name,
        );
      }
      const rootReal = realPathOf(resolve(this.d.workspace));
      if (!inside(rootReal, realPathOf(cwd))) {
        return this.refuse(
          `le dossier d'exécution (${cwd}) est hors du dossier de travail partagé (${rootReal}).`,
          program.name,
        );
      }
      const docker = this.d.docker ?? new DockerSandbox();
      const options = policy.docker ?? DEFAULT_DOCKER;
      const up = await docker.available();
      if (!up.ok) return this.refuse(`l'environnement Docker est choisi, et ${up.detail}.`, program.name);
      let name: string;
      try {
        name = await docker.ensure(rootReal, options);
      } catch (e) {
        return this.refuse((e as Error).message, program.name);
      }
      mechanism = "docker";
      planRoots = [rootReal];
      dockerPlan = {
        bin: onPath("docker", this.env, this.platform) ?? "docker",
        args: execArgs(name, containerPath(rootReal, cwd), opts.envKeys ?? [], line),
        detail: `dans le conteneur ${name} (${options.image}) : seul ${rootReal} est partagé avec la machine${options.network ? "" : ", sans réseau"}`,
      };
    } else if (scope === "workspace") {
      if (!this.d.workspace) {
        return this.refuse(
          "le confinement des écritures est demandé sans dossier de travail : il n'y a aucun endroit où écrire, donc rien de tenable.",
          program.name,
        );
      }
      const rootReal = realPathOf(resolve(this.d.workspace));
      const cwdReal = realPathOf(cwd);
      if (!inside(rootReal, cwdReal)) {
        return this.refuse(
          `le dossier d'exécution (${cwdReal}) est hors du dossier de travail autorisé (${rootReal}).`,
          program.name,
        );
      }
      const status = this.mechanism();
      if (!status.available || !status.id || !status.path) {
        return this.refuse(
          `le confinement des écritures est demandé ($writeScope = "workspace"), et cette machine ne peut pas le tenir : ${status.detail}.`,
          program.name,
        );
      }
      // MXC lance la commande dans un conteneur dont l'environnement est celui du moteur : les secrets du coffre n'y arrivent pas.
      // Les promettre puis ne pas les fournir ferait échouer la commande sans raison lisible : on refuse, avant de lancer.
      if (status.id === "mxc" && (opts.envKeys ?? []).length) {
        return this.refuse(
          "le confinement MXC ne transmet pas les secrets du coffre à la commande (retirer `secrets`, ou utiliser jarod-sandbox ou Docker).",
          program.name,
        );
      }
      mechanism = status.id;
      planRoots = [rootReal, ...roots.roots];
    }

    // 4. L'accord de l'utilisateur, par la porte EXISTANTE du cœur. Sans porte, on refuse : un
    //    « accord » qui ne peut être demandé n'est pas un accord.
    if (policy.askPrograms.length && this.inList(policy.askPrograms, program.name, program.path)) {
      const approve = this.d.approve;
      if (!approve) {
        return this.refuse(
          `« ${program.name} » exige l'accord de l'utilisateur, et aucun canal d'approbation n'est branché pour cet appel.`,
          program.name,
        );
      }
      const call: ToolCall = {
        id: `shell-guard-${programKey(program.name) || "programme"}`,
        name: "run_shell",
        args: { command: line },
      };
      let granted = false;
      try {
        granted = await approve(
          this.d.sessionId ?? "",
          call,
          `commande shell avec « ${program.name} » (politique du garde du shell)`,
        );
      } catch {
        granted = false;
      }
      if (!granted) {
        return this.refuse(`l'utilisateur n'a pas donné son accord pour « ${program.name} ».`, program.name);
      }
    }

    if (mechanism === "none") {
      return {
        kind: "plan",
        mode: "shell",
        bin: line,
        args: [],
        cwd,
        mechanism: "none",
        writableRoots: [],
        detail: "aucun confinement demandé : la commande est lancée telle quelle, comme avant",
      };
    }
    if (dockerPlan) {
      return {
        kind: "plan",
        mode: "exec",
        bin: dockerPlan.bin,
        args: dockerPlan.args,
        cwd,
        mechanism: "docker",
        writableRoots: planRoots,
        detail: dockerPlan.detail,
      };
    }
    const def = MECHANISMS.find((m) => m.id === mechanism)!;
    const status = this.mechanism();
    const launcher = def.launcherEnv ? this.env[def.launcherEnv] : undefined;
    const args = def.build({ bin: status.path!, command: line, cwd, roots: planRoots, launcher });
    return {
      kind: "plan",
      mode: "exec",
      bin: status.path!,
      args: args.slice(1),
      cwd,
      mechanism,
      writableRoots: planRoots,
      detail: `confiné par ${mechanism} : écriture permise seulement dans ${planRoots.join(", ")}`,
    };
  }

  /** La politique en vigueur, telle qu'elle sera appliquée. */
  view(): ShellGuardView {
    const policy = this.policy();
    const roots = this.writableRoots();
    const declared = this.d.workspace && roots.ok ? [realPathOf(resolve(this.d.workspace)), ...roots.roots] : [];
    return {
      platform: this.platform,
      writeScope: policy.writeScope,
      environment: policy.environment ?? "local",
      mechanism: this.mechanism(),
      writableRoots: policy.writeScope === "workspace" ? declared : [],
      allowedPrograms: policy.allowedPrograms,
      deniedPrograms: policy.deniedPrograms,
      askPrograms: policy.askPrograms,
    };
  }

  /** Le texte de `/shell-guard` : ce qui est permis, où, et ce qui exige un accord. */
  describe(): string {
    const v = this.view();
    const liste = (l: string[], vide: string) => (l.length ? l.join(", ") : vide);
    const writes =
      v.writeScope === "workspace"
        ? liste(v.writableRoots, "(aucun dossier : le confinement serait refusé)")
        : "(aucune restriction : aucun confinement demandé)";
    return [
      `**Garde du shell** — plateforme : ${v.platform}`,
      `- **Environnement** : ${v.environment === "docker" ? "Docker (un conteneur par dossier de travail, qui ne partage que ce dossier)" : "la machine elle-même"}`,
      `- **Confinement des écritures** : ${v.writeScope === "workspace" ? 'demandé (`writeScope = "workspace"`) : tenu ou refusé, jamais promis' : "non demandé (`writeScope = off`)"}`,
      `- **Mécanisme de confinement** : ${v.mechanism.available ? `${v.mechanism.id} (${v.mechanism.path})` : `aucun — ${v.mechanism.detail}`}`,
      `- **Écritures autorisées** : ${writes}`,
      `- **Programmes autorisés** : ${liste(v.allowedPrograms, "tous ceux présents sur la machine")}`,
      `- **Programmes refusés** : ${liste(v.deniedPrograms, "aucun")}`,
      `- **Programmes soumis à un accord** : ${liste(v.askPrograms, "aucun")}`,
      "- **Sans réglage** : comportement inchangé — aucune vérification, aucun refus. Un programme autorisé " +
        "n'est pas un confinement : une commande peut en enchaîner une autre.",
    ].join("\n");
  }
}
