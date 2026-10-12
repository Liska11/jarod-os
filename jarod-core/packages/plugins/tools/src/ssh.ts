// Portage de packages/core/src/services/ssh.ts (rév. 2e180305).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Exécuter une commande sur une machine distante par SSH — le cœur, rien de plus.
 *
 * Ce que ce service fait : il se connecte à un hôte *déclaré*, y lance une commande, rend sa sortie
 * et son code de sortie, et ferme. Ce qu'il ne fait jamais : aucun mot de passe, aucune phrase de
 * passe, aucun secret rangé quelque part. La seule chose qu'on lui donne est le CHEMIN d'une clé
 * privée.
 *
 * Trois propriétés portent tout le reste.
 *
 * En tableau — l'argv est un tableau d'arguments rendu tel quel au binaire `ssh` du système, avec
 * `shell: false` et jamais une chaîne. La commande distante ne peut donc pas s'échapper par une
 * interprétation locale : le seul shell qui la lit est celui de la machine distante.
 *
 * Sans secret — aucune option ne transporte de mot de passe, et les options sont choisies pour
 * rendre ce chemin impossible : `BatchMode=yes` (ssh échoue au lieu d'attendre une saisie),
 * `PreferredAuthentications=publickey` (une seule voie, celle de la clé) et `IdentitiesOnly=yes`
 * (seule la clé déclarée est proposée).
 *
 * Vérifiant — le dossier des hôtes connus est celui de l'utilisateur et la vérification des clés
 * d'hôte reste ACTIVE. Un hôte inconnu échoue : c'est le résultat correct, pas un incident. Les
 * options qui désactiveraient cette vérification sont refusées bruyamment, voir
 * `assertHostKeyVerificationKept`.
 *
 * La couture de transport est injectable (`SshTransport`) : les tests n'ouvrent aucune connexion.
 */

// ── Politique de vérification des clés d'hôte ────────────────────────────────

/** Valeur que ce service impose à `StrictHostKeyChecking` : un hôte inconnu échoue. */
export const SSH_HOST_KEY_POLICY = "yes";

/** Valeurs refusées : elles éteignent la vérification. Il n'y en a aucune de légitime ici. */
const REFUSED_HOST_KEY_VALUES = ["no", "off", "false"];

/** Fichiers d'hôtes connus détournés : la vérification ne serait plus qu'un décor. */
const REFUSED_KNOWN_HOSTS_VALUES = ["/dev/null", "none", "nul", ""];

/**
 * Refuse un argv qui éteindrait la vérification des clés d'hôte. Appelé sur les options, jamais sur
 * la commande distante — une commande qui *parle* de ces options reste une commande légitime.
 */
export function assertHostKeyVerificationKept(args: readonly string[]): void {
  for (const raw of args) {
    const arg = raw.trim();
    const separator = arg.indexOf("=");
    if (separator < 0) continue;
    const key = arg.slice(0, separator).toLowerCase();
    const value = arg
      .slice(separator + 1)
      .trim()
      .toLowerCase();

    if (key === "stricthostkeychecking" && REFUSED_HOST_KEY_VALUES.includes(value)) {
      throw new SshInputError(
        `Option ssh interdite : « ${arg} » désactive la vérification des clés d'hôte. Un hôte inconnu doit échouer.`,
      );
    }
    if (key === "userknownhostsfile" && REFUSED_KNOWN_HOSTS_VALUES.includes(value)) {
      throw new SshInputError(
        `Option ssh interdite : « ${arg} » détourne le fichier des hôtes connus. La vérification resterait sans dossier.`,
      );
    }
  }
}

// ── Cible et refus d'entrée ─────────────────────────────────────────────────

/** Un hôte déclaré. Rien d'autre : pas d'ambiance, pas de secret, pas d'état global. */
export interface SshTarget {
  /** Nom d'hôte ou adresse IP. Ni espace, ni métacaractère de shell, ni « - » en tête. */
  host: string;
  /** Utilisateur distant. Absent, c'est la configuration ssh du système qui tranche. */
  username?: string;
  /** Port TCP. Défaut : 22. */
  port?: number;
  /** CHEMIN d'une clé privée. Obligatoire, et c'est le seul secret admis. */
  keyPath: string;
}

/**
 * Une entrée refusée AVANT toute tentative de connexion. Rien n'est lancé, rien n'est ouvert : ce
 * n'est pas un échec de réseau, c'est une demande qu'on refuse de transformer en commande.
 */
export class SshInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshInputError";
  }
}

// ── Transport ───────────────────────────────────────────────────────────────

/** Ce qui est demandé au binaire local. Des arguments séparés, jamais une ligne de commande. */
export interface SshCommand {
  /** Le binaire lancé : le `ssh` du système. Jamais un shell. */
  file: string;
  /** Un argument par élément. Un tableau, jamais une chaîne assemblée. */
  args: string[];
  /** Délai, en millisecondes, avant que le processus soit tué. */
  timeoutMs: number;
}

/** Ce que le processus local a rendu, y compris la façon dont il est mort. */
export interface SshProcessOutcome {
  stdout: string;
  stderr: string;
  /** Code de sortie du processus ssh, qui est celui de la commande distante. `null` si tué. */
  exitCode: number | null;
  /** Le délai a été dépassé : le processus a été tué au lieu d'être laissé pendre. */
  timedOut: boolean;
  /** La mort du processus est confirmée : il n'est plus là. */
  deathConfirmed: boolean;
  /** Le binaire est introuvable sur la machine. */
  binaryMissing: boolean;
  /** Le lancement a échoué pour une autre raison. Chaîne vide sinon. */
  spawnError: string;
}

/**
 * La couture. Le vrai transport lance le binaire du système ; un test injecte le sien et n'ouvre
 * alors rien du tout.
 */
export type SshTransport = (command: SshCommand) => Promise<SshProcessOutcome>;

/** Le temps laissé entre la demande de mort et la mort forcée d'un processus qui l'ignorerait. */
export const SSH_KILL_GRACE_MS = 500;

/** Le seul code que ssh réserve à ses propres échecs : connexion, hôte, authentification. */
export const SSH_FAILURE_EXIT_CODE = 255;

function outcome(partial: Partial<SshProcessOutcome> = {}): SshProcessOutcome {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    deathConfirmed: false,
    binaryMissing: false,
    spawnError: "",
    ...partial,
  };
}

/**
 * Le transport réel : le binaire `ssh` du système, en argv tableau, sans shell.
 *
 * L'entrée standard est branchée sur le vide : la commande distante ne peut rien lire de la machine
 * locale. Le délai tue le processus — d'abord poliment, puis sans lui demander son avis — et la
 * promesse ne se résout qu'une fois la mort observée, jamais avant.
 */
export function spawnSshCommand(command: SshCommand): Promise<SshProcessOutcome> {
  return new Promise<SshProcessOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command.file, command.args, {
        // `shell: false` et un tableau : aucun shell local n'interprète quoi que ce soit.
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(outcome({ spawnError: error instanceof Error ? error.message : String(error) }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const settle = (partial: Partial<SshProcessOutcome>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(outcome({ stdout, stderr, ...partial }));
    };

    timer = setTimeout(() => {
      timedOut = true;
      // Premier essai : la fin propre. Ignoré ou non, un second passage force la mort.
      try {
        child.kill("SIGTERM");
      } catch {
        // Déjà parti.
      }
      graceTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Déjà parti.
        }
        // Rien n'est venu : on rend la main avec un délai dépassé plutôt que de pendre.
        settle({ exitCode: null, timedOut: true, deathConfirmed: false });
      }, SSH_KILL_GRACE_MS);
    }, command.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        settle({ binaryMissing: true, spawnError: error.message });
        return;
      }
      settle({ spawnError: error.message });
    });
    child.on("close", (code) => {
      settle({ exitCode: code, timedOut, deathConfirmed: true });
    });
  });
}

// ── Résultat ────────────────────────────────────────────────────────────────

/** Pourquoi une exécution n'est pas un succès. `null` quand elle l'est. */
export type SshFailureKind = "timeout" | "binary" | "spawn" | "connection" | "exit" | "signal" | null;

export interface SshResult {
  /** Vrai pour un code de sortie exactement nul, et pour lui seul. */
  ok: boolean;
  /** Code de sortie de la commande distante, tel quel. `null` si le processus a été tué. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** La raison de l'échec, `null` en cas de succès. */
  failure: SshFailureKind;
  /** Message lisible quand `ok` est faux ; chaîne vide sinon. */
  message: string;
  /** Le délai a été dépassé et le processus tué. */
  timedOut: boolean;
  /** Durée réelle, en millisecondes. */
  durationMs: number;
}

/** Un appel dont on exige le succès : l'échec devient une exception qui porte le résultat. */
export class SshFailureError extends Error {
  constructor(
    message: string,
    readonly result: SshResult,
  ) {
    super(message);
    this.name = "SshFailureError";
  }
}

/** Options par appel. Rien qui touche à l'identité : ici, aucune place pour un secret. */
export interface SshExecOptions {
  /** Délai avant mise à mort du processus, en millisecondes. */
  timeoutMs?: number;
}

export interface SshServiceOptions {
  /** Couture de transport. Un test l'injecte : aucune connexion n'est alors ouverte. */
  transport?: SshTransport;
  /** Nom ou chemin du binaire ssh. `ssh` par défaut : celui du système. */
  sshBinary?: string;
  /** Délai par défaut, en millisecondes. */
  timeoutMs?: number;
  /** Horloge, injectable pour les tests. */
  now?: () => number;
  /** Vérification de l'existence du fichier de clé. `existsSync` par défaut. */
  keyExists?: (keyPath: string) => boolean;
}

/** Ce qu'une session retient du service qui l'a ouverte. */
export interface SshSessionContext {
  transport: SshTransport;
  sshBinary: string;
  timeoutMs: number;
  now: () => number;
}

export interface SshArgOptions {
  /** Délai de connexion, en secondes. Défaut : 15. */
  connectTimeoutSeconds?: number;
}

// ── Construction de l'argv ──────────────────────────────────────────────────

const DEFAULT_SSH_PORT = 22;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 15;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Un nom d'hôte : des lettres, des chiffres, des points, des tirets, des soulignés. */
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** Un nom d'utilisateur : jamais d'arobase (il séparerait un autre hôte) ni d'espace. */
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Vérifie la forme de la cible et la rend normalisée. Aucune connexion, aucun accès disque : c'est
 * du refus, pas de l'entrée-sortie.
 */
export function assertSshTargetShape(target: SshTarget): SshTarget {
  const host = (target.host ?? "").trim();
  const username = target.username?.trim();
  const keyPath = (target.keyPath ?? "").trim();

  if (!host)
    throw new SshInputError("Hôte manquant : donnez un nom d'hôte ou une adresse (par exemple « serveur.exemple »).");
  if (host.includes(":")) {
    throw new SshInputError(
      `Hôte invalide : « ${host} » contient « : ». Le port se déclare dans le champ port, pas dans le nom, et un littéral IPv6 n'est pas accepté ici.`,
    );
  }
  if (!HOST_RE.test(host)) {
    throw new SshInputError(
      `Hôte invalide : « ${host} ». Lettres, chiffres, points, tirets et soulignés seulement, et jamais un tiret en tête.`,
    );
  }

  if (username !== undefined && username !== "" && !USER_RE.test(username)) {
    throw new SshInputError(
      `Utilisateur invalide : « ${username} ». Une arobase, un espace ou un métacaractère de shell n'ont rien à faire dans un nom d'utilisateur.`,
    );
  }

  const port = target.port ?? DEFAULT_SSH_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshInputError(`Port invalide : « ${String(target.port)} ». Un entier entre 1 et 65535 est attendu.`);
  }

  if (!keyPath) {
    throw new SshInputError(
      "Chemin de clé manquant : donnez le chemin de la clé privée. Aucun mot de passe, aucune phrase de passe n'est accepté.",
    );
  }
  if (keyPath.includes("\n") || keyPath.includes("\r") || keyPath.includes("\0")) {
    throw new SshInputError("Chemin de clé invalide : il contient un saut de ligne ou un octet nul.");
  }
  if (!isAbsolute(keyPath)) {
    throw new SshInputError(
      `Chemin de clé invalide : « ${keyPath} » n'est pas un chemin absolu. Donnez le chemin complet de la clé privée.`,
    );
  }

  return {
    host,
    ...(username ? { username } : {}),
    port,
    keyPath,
  };
}

/** `utilisateur@hôte`, ou l'hôte seul quand aucun utilisateur n'est déclaré. */
function remoteOf(target: SshTarget): string {
  return target.username ? `${target.username}@${target.host}` : target.host;
}

/**
 * Les options, la clé et la cible — tout sauf la commande distante.
 *
 * L'ordre est stable et testé : c'est cet argv exact qui part au binaire. `-i` porte un CHEMIN, pas
 * une clé ; `-p` porte un entier ; la cible et la commande sont chacune un seul argument.
 */
export function buildSshOptions(target: SshTarget, options: SshArgOptions = {}): string[] {
  const clean = assertSshTargetShape(target);
  const connectTimeout = options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  if (!Number.isInteger(connectTimeout) || connectTimeout < 1) {
    throw new SshInputError(`Délai de connexion invalide : « ${String(options.connectTimeoutSeconds)} ».`);
  }

  const args = [
    "-o",
    "BatchMode=yes", // Jamais d'invite : ssh échoue au lieu d'attendre une saisie.
    "-o",
    `StrictHostKeyChecking=${SSH_HOST_KEY_POLICY}`, // Hôte inconnu ⇒ échec, jamais d'ajout silencieux.
    "-o",
    `ConnectTimeout=${connectTimeout}`,
    "-o",
    "ControlMaster=no", // Rien ne survit à la fermeture : fermer veut dire fermer.
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "IdentitiesOnly=yes", // Seule la clé déclarée est proposée.
    "-o",
    "PreferredAuthentications=publickey", // Aucun chemin par mot de passe n'existe.
    "-i",
    clean.keyPath,
    "-p",
    String(clean.port),
    remoteOf(clean),
  ];

  // Le dossier des hôtes connus n'est PAS touché : on ne pose aucun `UserKnownHostsFile`, donc ssh
  // lit celui de l'utilisateur. C'est vérifié ici plutôt que supposé.
  assertHostKeyVerificationKept(args);
  return args;
}

/** L'argv complet : les options, puis la commande distante en dernier argument. */
export function buildSshArgs(target: SshTarget, command: string, options: SshArgOptions = {}): string[] {
  return [...buildSshOptions(target, options), requireCommand(command)];
}

function requireCommand(command: string): string {
  if (typeof command !== "string" || !command.trim()) {
    throw new SshInputError("Commande distante vide : il n'y a rien à exécuter.");
  }
  if (command.includes("\0")) {
    throw new SshInputError("Commande distante invalide : elle contient un octet nul.");
  }
  return command;
}

// ── Messages ────────────────────────────────────────────────────────────────

/** Enlève le bruit des avertissements pour ne laisser que ce qui compte. */
export function sanitizeSshStderr(stderr: string, target: SshTarget): string {
  const cleaned = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Warning: Permanently added /.test(line))
    .filter((line) => !/identity file .* not accessible/i.test(line))
    .join("\n")
    .trim();

  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(cleaned)) {
    return `Clé d'hôte refusée pour ${remoteOf(target)} : l'hôte est inconnu, ou sa clé a changé. Ajoutez-la explicitement à known_hosts (ssh-keyscan) puis réessayez — ce service ne l'ajoute jamais tout seul.`;
  }
  if (/Permission denied \(publickey\)|no such identity|could not open a connection|publickey/i.test(cleaned)) {
    return `Authentification SSH refusée par ${remoteOf(target)} : la clé privée déclarée n'est pas acceptée.`;
  }
  return cleaned;
}

// ── Session ─────────────────────────────────────────────────────────────────

/**
 * Une session sur un hôte déclaré : se connecter, exécuter, fermer.
 *
 * Chaque exécution est un processus ssh jetable (aucun maître de contrôle qui traînerait), donc
 * `close()` ne laisse rien derrière lui — et après lui, plus rien ne part.
 */
export class SshSession {
  private closed = false;

  constructor(
    readonly target: SshTarget,
    private readonly context: SshSessionContext,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Lance la commande sur l'hôte et rend sa sortie et son code de sortie.
   *
   * Une entrée invalide LÈVE (`SshInputError`) : rien n'est tenté. Un délai dépassé, un binaire
   * absent, un échec ssh ou un code de sortie non nul REVIENNENT avec `ok === false` : ce sont des
   * résultats, pas des exceptions.
   */
  async exec(command: string, options: SshExecOptions = {}): Promise<SshResult> {
    if (this.closed) {
      throw new SshInputError(
        `Session fermée pour ${remoteOf(this.target)} : ouvrez-en une nouvelle avant d'exécuter.`,
      );
    }
    const remote = requireCommand(command);
    const timeoutMs = options.timeoutMs ?? this.context.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new SshInputError(`Délai invalide : « ${String(options.timeoutMs)} ».`);
    }

    const args = buildSshArgs(this.target, remote);
    const startedAt = this.context.now();
    const raw = await this.run({ file: this.context.sshBinary, args, timeoutMs }, timeoutMs);
    return toResult(raw, this.target, this.context.now() - startedAt);
  }

  /**
   * La même chose, mais un échec devient une exception qui porte le résultat. Le code de sortie
   * reste celui de la commande distante : rien n'est aplati.
   */
  async execOrThrow(command: string, options: SshExecOptions = {}): Promise<SshResult> {
    const result = await this.exec(command, options);
    if (!result.ok) throw new SshFailureError(result.message || "Commande distante en échec", result);
    return result;
  }

  /**
   * La couture, et le filet de sécurité du délai : si un transport ne rend jamais la main, c'est
   * nous qui coupons, dans le délai promis plus le temps de grâce.
   */
  private async run(command: SshCommand, timeoutMs: number): Promise<SshProcessOutcome> {
    const attempt = this.context
      .transport(command)
      .catch((error: unknown) => outcome({ spawnError: error instanceof Error ? error.message : String(error) }));
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<SshProcessOutcome>((resolve) => {
      timer = setTimeout(() => resolve(outcome({ timedOut: true })), timeoutMs + SSH_KILL_GRACE_MS);
    });
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Ferme. Rien n'est tué ici : il n'y a rien à tuer, l'exécution est un processus jetable. */
  close(): void {
    this.closed = true;
  }
}

/** Ce qu'un transport a rendu devient un résultat lisible, sans jamais confondre échec et succès. */
function toResult(raw: SshProcessOutcome, target: SshTarget, durationMs: number): SshResult {
  const base = { exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr, timedOut: raw.timedOut, durationMs };

  if (raw.timedOut) {
    return {
      ...base,
      ok: false,
      exitCode: null,
      failure: "timeout",
      message: `Délai dépassé pour ${remoteOf(target)} : le processus ssh a été tué, aucune commande ne reste pendue.`,
    };
  }
  if (raw.binaryMissing) {
    return {
      ...base,
      ok: false,
      exitCode: null,
      failure: "binary",
      message: `Binaire ssh introuvable : installez un client OpenSSH et vérifiez que « ssh » est dans le PATH.`,
    };
  }
  if (raw.spawnError) {
    return {
      ...base,
      ok: false,
      exitCode: null,
      failure: "spawn",
      message: `Le processus ssh n'a pas pu être lancé : ${raw.spawnError}`,
    };
  }
  if (raw.exitCode === 0) {
    // Une sortie d'erreur sur un code nul reste un succès : stderr n'est pas un verdict.
    return { ...base, ok: true, failure: null, message: "" };
  }
  if (raw.exitCode === null) {
    return {
      ...base,
      ok: false,
      failure: "signal",
      message: `Le processus ssh s'est terminé sans code de sortie (tué par un signal) pour ${remoteOf(target)}.`,
    };
  }
  if (raw.exitCode === SSH_FAILURE_EXIT_CODE) {
    const detail = sanitizeSshStderr(raw.stderr, target);
    return {
      ...base,
      ok: false,
      failure: "connection",
      message: detail || `La connexion SSH à ${remoteOf(target)} a échoué (code ${SSH_FAILURE_EXIT_CODE}).`,
    };
  }
  const detail = sanitizeSshStderr(raw.stderr, target);
  return {
    ...base,
    ok: false,
    failure: "exit",
    message: `La commande distante a échoué avec le code ${raw.exitCode} sur ${remoteOf(target)}.${detail ? ` ${detail}` : ""}`,
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Le cœur SSH du noyau : ouvrir une session sur un hôte déclaré, exécuter, fermer.
 *
 * `open` refuse une cible invalide avant toute tentative — c'est la seule chose que ce service
 * promet sur le chemin d'erreur, et elle tient : aucune connexion n'est ouverte pour une demande
 * qu'on refuse.
 */
export class SshService {
  private readonly transport: SshTransport;
  private readonly sshBinary: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly keyExists: (keyPath: string) => boolean;
  private closed = false;

  constructor(options: SshServiceOptions = {}) {
    this.transport = options.transport ?? spawnSshCommand;
    this.sshBinary = options.sshBinary ?? "ssh";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.keyExists = options.keyExists ?? ((keyPath) => existsSync(keyPath));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Ouvre une session. La cible est vérifiée ici, forme puis existence du fichier de clé, avant
   * que quoi que ce soit puisse être lancé.
   */
  open(target: SshTarget): SshSession {
    if (this.closed) {
      throw new SshInputError("Service SSH fermé : ouvrez un nouveau service pour exécuter une commande.");
    }
    const clean = assertSshTargetShape(target);
    if (!this.keyExists(clean.keyPath)) {
      throw new SshInputError(
        `Clé privée introuvable : « ${clean.keyPath} ». Donnez le chemin d'un fichier de clé qui existe ; aucun mot de passe ne remplacera une clé absente.`,
      );
    }
    return new SshSession(clean, {
      transport: this.transport,
      sshBinary: this.sshBinary,
      timeoutMs: this.timeoutMs,
      now: this.now,
    });
  }

  /** Raccourci : ouvrir, exécuter, fermer — la session est fermée même si la commande échoue. */
  async exec(target: SshTarget, command: string, options: SshExecOptions = {}): Promise<SshResult> {
    const session = this.open(target);
    try {
      return await session.exec(command, options);
    } finally {
      session.close();
    }
  }

  /** Ferme le service : plus aucune session ne s'ouvre. */
  close(): void {
    this.closed = true;
  }
}
