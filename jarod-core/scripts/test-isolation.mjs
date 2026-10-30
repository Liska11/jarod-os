// Garde d'isolation des tests (30/10) : pendant une suite, RIEN ne touche le vrai profil, les vrais dossiers ni les vrais ports de l'utilisateur.
//
// Chargé par `test-report.mjs` dans chaque processus vitest (NODE_OPTIONS=--import), il :
//  1. redirige le « domicile » (USERPROFILE, HOME, APPDATA, LOCALAPPDATA) vers un dossier temporaire : `os.homedir()` et tout chemin dérivé tombent dans le bac à sable ;
//  2. REFUSE (exception + ligne dans le journal) tout accès fichier aux dossiers réels de Jarod-OS (profil, données, installation, ~/.hermes) ;
//  3. REFUSE d'écouter sur un port fixe (seul le port 0 = port aléatoire est permis) ;
//  4. REFUSE de se connecter aux ports réels de Jarod-OS en boucle locale (moteur 8080, vision 8792, passerelle, voix…) : une suite ne parle qu'à ses propres faux serveurs.
// Le journal (JAROD_GUARD_LOG) est relu par le lanceur : toute violation fait échouer la mesure, même si le test avait avalé l'exception.
// Inactif hors vitest, donc sans effet sur pnpm ni sur le lanceur.
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** Les ports de Jarod-OS (moteurs, vision, voix, passerelle, WhatsApp, embeddings…) : un test n'a jamais à les joindre. */
export const LIVE_PORTS = [8000, 8080, 8081, 8642, 8790, 8791, 8792, 8910, 8920, 8930, 9000, 9119, 8090, 30000];

/** Vrai si `path` est dans l'un des dossiers `roots` (insensible à la casse, `/` ou `\`). */
export function pathIsProtected(path, roots) {
  const norm = (p) => resolve(String(p)).replaceAll("/", sep).toLowerCase();
  const target = norm(path);
  return roots.some((r) => {
    const root = norm(r).replace(/[\\/]+$/, "");
    return target === root || target.startsWith(root + sep);
  });
}

const EPHEMERAL_MIN = 49152;

export function portIsLive(port) {
  return LIVE_PORTS.includes(Number(port));
}

const FS_PATH_ARGS = {
  // [fonction] : combien d'arguments de tête sont des chemins
  readFile: 1, readFileSync: 1, readdir: 1, readdirSync: 1, open: 1, openSync: 1, createReadStream: 1, createWriteStream: 1,
  writeFile: 1, writeFileSync: 1, appendFile: 1, appendFileSync: 1, mkdir: 1, mkdirSync: 1, rm: 1, rmSync: 1, rmdir: 1, rmdirSync: 1,
  unlink: 1, unlinkSync: 1, rename: 2, renameSync: 2, copyFile: 2, copyFileSync: 2, cp: 2, cpSync: 2, stat: 1, statSync: 1, lstat: 1, lstatSync: 1,
  access: 1, accessSync: 1, exists: 1, existsSync: 1, truncate: 1, truncateSync: 1, opendir: 1, opendirSync: 1,
};

/** Les simples sondes d'existence (PATH, `existsSync`) : journalisées à part (« sonde »), jamais refusées ; lire, lister, ouvrir ou écrire reste refusé. */
const PROBES = new Set(["stat", "statSync", "lstat", "lstatSync", "access", "accessSync", "exists", "existsSync"]);

/** Installe la garde. `roots` : dossiers réels interdits ; `log` : fichier du journal ; `sandbox` : nouveau « domicile ». */
export function install({ roots, log, sandbox }) {
  const record = (kind0, detail) => {
    // les tentatives VOLONTAIRES du test de la garde (globalThis.__jarodGuardCanary) sont du « canari » : elles prouvent le refus sans compter comme violation
    const kind = (globalThis.__jarodGuardCanary || process.env.JAROD_GUARD_CANARY === "1") && kind0 !== "armée" && kind0 !== "sonde" ? "canari" : kind0;
    // les images du projet seulement (pas celles de node ni de la garde) : c'est le test ou le code appelant qu'on cherche
    const stack = new Error().stack
      ?.split("\n")
      .map((l) => l.trim())
      .filter((l) => /Jarod-OS[\\/]/.test(l) && !/test-isolation/.test(l))
      .slice(0, 4)
      .map((l) => l.replace(/^.*Jarod-OS[\\/]/, "").replace(/\)$/, ""))
      .join(" | ");
    try {
      // le fichier de test en cours (vitest le tient dans son état de worker) : l'appel réseau vient souvent d'une pile asynchrone sans image du projet
      const w = globalThis.__vitest_worker__;
      const file = w?.filepath ? String(w.filepath).replace(/^.*Jarod-OS[\\/]/, "") : undefined;
      if (log) appendFileSync(log, `${JSON.stringify({ kind, detail, pid: process.pid, file, stack })}\n`);
    } catch {
      // le journal est un témoin : sa perte ne doit pas changer le comportement du test
    }
  };
  const refuse = (kind, detail) => {
    record(kind, detail);
    const e = new Error(`isolation des tests : ${kind} refusé (${detail})`);
    e.code = "EJAROD_TEST_ISOLATION";
    throw e;
  };

  // Seul le PREMIER processus (vitest) redirige le domicile ; un processus fils qu'un test lance avec son propre JAROD_HOME garde le sien (il hérite du reste).
  const owner = !process.env.JAROD_GUARD_OWNER;
  if (owner) process.env.JAROD_GUARD_OWNER = String(process.pid);
  if (sandbox && owner) {
    for (const k of ["USERPROFILE", "HOME"]) process.env[k] = sandbox.home;
    process.env.APPDATA = sandbox.appdata;
    process.env.LOCALAPPDATA = sandbox.local;
    for (const k of ["JAROD_HOME", "JAROD_OS_CONFIG_DIR", "JAROD_DATA_DIR", "HERMES_HOME", "JAROD_GATEWAY_TOKEN", "JAROD_NETWORK_POLICY"]) delete process.env[k];
  }

  // Un WORKER ne transmet pas la garde aux processus que ses tests lancent : certains (le moteur reladraw) tournent sous `--permission` et ne peuvent pas lire ce
  // fichier. Le processus vitest principal, lui, la transmet à ses workers.
  const mainVitest = /vitest[\\/]vitest\.m?js$|[\\/]\.bin[\\/]vitest/i.test(process.argv[1] ?? "");
  if (!mainVitest) {
    const rest = (process.env.NODE_OPTIONS ?? "").replace(/--import\s+\S*test-isolation\.mjs/g, "").trim();
    if (rest) process.env.NODE_OPTIONS = rest;
    else delete process.env.NODE_OPTIONS;
  }

  const fs = require("node:fs");
  const wrap = (obj, name, nPaths, label) => {
    const original = obj[name];
    if (typeof original !== "function") return;
    obj[name] = function guarded(...args) {
      for (let i = 0; i < nPaths; i++) {
        const a = args[i];
        const p = typeof a === "string" ? a : a instanceof URL ? (a.protocol === "file:" ? require("node:url").fileURLToPath(a) : null) : Buffer.isBuffer(a) ? a.toString() : null;
        if (p && pathIsProtected(p, roots)) {
          if (PROBES.has(name)) record("sonde", p);
          else refuse(`fichier (${label}.${name})`, p);
        }
      }
      return original.apply(this, args);
    };
  };
  for (const [name, n] of Object.entries(FS_PATH_ARGS)) {
    wrap(fs, name, n, "fs");
    wrap(fs.promises, name, n, "fs.promises");
  }

  const net = require("node:net");
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function guardedListen(...args) {
    const first = args[0];
    const port = typeof first === "object" && first !== null ? first.port : typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first)) ? Number(first) : undefined;
    // Port 0 = le système en choisit un. Un port ≥ 49152 (plage éphémère) hors ports réels est un port « libre trouvé puis passé » (helpers de test) : permis.
    if (port !== undefined && port !== 0 && (port < EPHEMERAL_MIN || portIsLive(port))) refuse("écoute sur un port fixe", String(port));
    return listen.apply(this, args);
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    // `net.connect()` normalise d'abord : l'argument est alors un tableau [options, rappel]
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const opts = typeof first === "object" && first !== null ? first : typeof first === "number" ? { port: first, host: args[1] } : {};
    const host = String(opts.host ?? "localhost");
    if (opts.port !== undefined && portIsLive(opts.port) && /^(localhost|127\.|::1|\[::1\]|0\.0\.0\.0)/i.test(host)) refuse("connexion à un port réel de Jarod-OS", `${host}:${opts.port}`);
    return connect.apply(this, args);
  };

  // Sous-processus (PowerShell, navigateur, node…) : (1) une ligne de commande qui NOMME un dossier réel de Jarod-OS est refusée ; (2) un fils node reçoit la garde
  // (NODE_OPTIONS --import), sauf sous `--permission` (qui ne peut pas la lire). Un programme natif qui écrit ailleurs que dans ce qu'il reçoit en argument (un script
  // PowerShell qui calcule son chemin) N'EST PAS arrêté : limite dite dans SECURITY.md.
  const cp = require("node:child_process");
  const rootsNorm = roots.map((r) => String(r).replaceAll("/", "\\").toLowerCase().replace(/\\+$/, ""));
  const named = (parts) => {
    const text = parts.map(String).join(" ").replaceAll("/", "\\").toLowerCase();
    return rootsNorm.find((r) => text.includes(r));
  };
  const selfImport = `--import ${pathToFileURL(fileURLToPath(import.meta.url)).href}`;
  const isNode = (file) => /^node(\.exe)?$/i.test(basename(String(file))) || resolve(String(file)) === resolve(process.execPath);
  const withGuardEnv = (opts) => {
    const base = opts && typeof opts === "object" ? opts : {};
    const env = { ...(base.env ?? process.env) };
    if (!/test-isolation\.mjs/.test(env.NODE_OPTIONS ?? "")) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} ${selfImport}`.trim();
    return { ...base, env };
  };
  const optIndex = (args, from) => (args[from] && typeof args[from] === "object" && !Array.isArray(args[from]) ? from : args[from + 1] && typeof args[from + 1] === "object" && !Array.isArray(args[from + 1]) && typeof args[from + 1] !== "function" ? from + 1 : -1);
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
    const original = cp[name];
    cp[name] = function guardedProcess(...args) {
      const list = Array.isArray(args[1]) ? args[1] : [];
      const hit = named([args[0], ...list]);
      if (hit) refuse(`sous-processus (${name})`, `${basename(String(args[0]))} nomme ${hit}`);
      const node = name === "fork" || isNode(args[0]);
      const permission = list.some((a) => String(a).startsWith("--permission")) || (args.find((a) => a && typeof a === "object" && Array.isArray(a.execArgv))?.execArgv ?? []).some((a) => String(a).startsWith("--permission"));
      if (node && !permission) {
        const i = optIndex(args, name === "fork" ? 1 : 1) >= 0 ? optIndex(args, 1) : -1;
        const at = i >= 0 ? i : Array.isArray(args[1]) ? 2 : 1;
        if (typeof args[at] === "function") args.splice(at, 0, withGuardEnv({}));
        else args[at] = withGuardEnv(args[at]);
      }
      return original.apply(this, args);
    };
  }
  for (const name of ["exec", "execSync"]) {
    const original = cp[name];
    cp[name] = function guardedShell(...args) {
      const hit = named([args[0]]);
      if (hit) refuse(`sous-processus (${name})`, `commande nomme ${hit}`);
      return original.apply(this, args);
    };
  }

  require("node:module").syncBuiltinESMExports();
  globalThis.__jarodTestGuard = { roots, sandbox: sandbox?.home ?? null };
  record("armée", sandbox?.home ?? "");
}

const inVitest = /vitest/i.test(process.argv[1] ?? "") || process.env.VITEST_WORKER_ID !== undefined || process.env.VITEST_POOL_ID !== undefined;
if (process.env.JAROD_GUARD_ACTIVE === "1" && (inVitest || process.env.JAROD_GUARD_OWNER) && !globalThis.__jarodTestGuard) {
  install({
    roots: JSON.parse(process.env.JAROD_GUARD_ROOTS ?? "[]"),
    log: process.env.JAROD_GUARD_LOG,
    sandbox: process.env.JAROD_GUARD_SANDBOX ? JSON.parse(process.env.JAROD_GUARD_SANDBOX) : undefined,
  });
}
