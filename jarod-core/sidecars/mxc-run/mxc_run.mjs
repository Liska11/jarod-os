// Lanceur MXC pour `run_shell` (A1) : exécute UNE ligne de commande dans un ProcessContainer de Windows.
//
//   node mxc_run.mjs selftest
//   node mxc_run.mjs exec --workspace <dossier> --cwd <dossier> --timeout <secondes> -- <ligne de commande>
//
// Le SDK est désigné par JAROD_MXC_SDK (chemin de dist/v1/index.js). Fail-closed : SDK absent, requête invalide ou conteneur
// qui ne démarre pas => code 125 et la commande n'est JAMAIS lancée hors conteneur. La requête est celle de `toMxcRequest`
// (integrations/src/impl/confinement.ts) : écriture dans la zone seulement, réseau refusé, presse-papiers et injection d'entrée
// refusés. Un test compare les deux constructeurs.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const EXIT_REFUSED = 125;
export const EXIT_TIMEOUT = 124;

const ABS = /^(?:[A-Za-z]:[\\/]|\/)/;
const TRAILING = /[\\/]+$/;

/** Dossiers personnels sensibles refusés en plus, quand ils existent dans le dossier utilisateur. */
const SENSITIVE_HOME = [".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker"];

export function buildRequest(command, { workspace, cwd, timeoutSeconds, readonlyPaths = [], deniedPaths = [] }) {
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) throw new Error("commande vide ou invalide");
  for (const p of [workspace, cwd, ...readonlyPaths, ...deniedPaths]) {
    if (!ABS.test(p) || p.split(/[\\/]/).includes("..")) throw new Error(`chemin non absolu ou contenant « .. » : ${p}`);
  }
  const ws = workspace.replace(TRAILING, "").toLowerCase();
  if ([...readonlyPaths, ...deniedPaths].some((p) => p.replace(TRAILING, "").toLowerCase() === ws)) throw new Error("la zone de travail ne peut pas être aussi en lecture seule ou interdite");
  return {
    command,
    filesystem: { readwritePaths: [workspace], readonlyPaths, deniedPaths },
    network: { egress: { default: "deny" } },
    ui: { disable: false, clipboard: "none", allowInputInjection: false },
    timeoutMs: Math.max(1, Math.min(600, Math.floor(timeoutSeconds || 60))) * 1000,
    workingDirectory: cwd,
  };
}

/** Lecture seule : Windows (interpréteurs, cmd, PowerShell) et le dossier de node. Jamais le dossier personnel entier. */
export function defaultReadonly(env = process.env) {
  const out = new Set();
  if (env.SystemRoot) out.add(env.SystemRoot);
  out.add(dirname(process.execPath));
  for (const extra of (env.JAROD_MXC_READONLY ?? "").split(";").filter(Boolean)) out.add(extra);
  return [...out];
}

export function defaultDenied(home = homedir()) {
  return SENSITIVE_HOME.map((d) => join(home, d));
}

function fail(message) {
  process.stderr.write(`[mxc] ${message}\n`);
  process.exit(EXIT_REFUSED);
}

async function loadSdk() {
  const path = process.env.JAROD_MXC_SDK;
  if (!path || !isAbsolute(path)) fail("JAROD_MXC_SDK n'indique pas le SDK (chemin absolu de dist/v1/index.js) : rien n'est lancé.");
  let sdk;
  try {
    sdk = await import(pathToFileURL(path).href);
  } catch (e) {
    fail(`SDK illisible (${path}) : ${e.message}`);
  }
  const support = sdk.getPlatformSupport?.();
  if (!support?.isSupported || !support.availableMethods?.includes("processcontainer")) fail("ProcessContainer n'est pas disponible sur cette machine.");
  return sdk;
}

async function selftest() {
  const sdk = await loadSdk();
  const root = mkdtempSync(join(tmpdir(), "jarod-mxc-self-"));
  const inside = join(root, "dedans");
  const outside = join(root, "dehors");
  mkdirSync(inside);
  mkdirSync(outside);
  try {
    const cmd = (target) => `cmd /D /S /C "echo x > "${target}""`;
    const ok = await sdk.run(buildRequest(cmd(join(inside, "ok.txt")), { workspace: inside, cwd: inside, timeoutSeconds: 30, readonlyPaths: defaultReadonly() }));
    await sdk.run(buildRequest(cmd(join(outside, "evade.txt")), { workspace: inside, cwd: inside, timeoutSeconds: 30, readonlyPaths: defaultReadonly() }));
    let wrote = false;
    try {
      readFileSync(join(outside, "evade.txt"));
      wrote = true;
    } catch {}
    let wroteInside = false;
    try {
      readFileSync(join(inside, "ok.txt"));
      wroteInside = true;
    } catch {}
    if (ok.exitCode !== 0 || !wroteInside) fail(`épreuve : l'écriture dans la zone a échoué (code ${ok.exitCode}).`);
    if (wrote) fail("épreuve : une écriture hors de la zone a réussi, le conteneur ne tient pas sa promesse.");
    process.stdout.write("mxc ok\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function exec(argv) {
  const sep2 = argv.indexOf("--");
  if (sep2 < 0) fail("ligne de commande attendue après « -- ».");
  const opts = {};
  for (let i = 0; i < sep2; i += 2) opts[argv[i]] = argv[i + 1];
  const command = argv.slice(sep2 + 1).join(" ");
  let req;
  try {
    req = buildRequest(command, {
      workspace: opts["--workspace"] ?? "",
      cwd: opts["--cwd"] ?? opts["--workspace"] ?? "",
      timeoutSeconds: Number(opts["--timeout"]),
      readonlyPaths: defaultReadonly(),
      deniedPaths: defaultDenied(),
    });
  } catch (e) {
    fail(e.message);
  }
  const sdk = await loadSdk();
  let result;
  try {
    result = await sdk.run(req);
  } catch (e) {
    fail(`le conteneur n'a pas démarré : ${e.message}`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.timedOut) {
    process.stderr.write(`[mxc] délai dépassé après ${req.timeoutMs / 1000}s : commande arrêtée\n`);
    process.exit(EXIT_TIMEOUT);
  }
  process.exit(result.exitCode ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb === "selftest") await selftest();
  else if (verb === "exec") await exec(rest);
  else fail("usage : selftest | exec --workspace <dossier> --cwd <dossier> --timeout <s> -- <commande>");
}
