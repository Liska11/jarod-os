// `jarod headless start|status|stop` (SPECS-P5-CLI.md §3) : une instance `jarod serve` en arrière-plan, sans fenêtre. L'arrêt est COOPÉRATIF seulement
// (fichier d'état `supervisor.json`, comme `jarod serve` l'attend) avec un délai de 10 s (décision Q3) ; passé ce délai, l'échec est rapporté et le
// processus est LAISSÉ EN VIE : ce code ne tue jamais rien.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describeMode, isProcessAlive, readRuntimeLock, readSupervisorStatus, requestStop } from "@jarod/plugin-agent";
import { profileDirOf } from "./health.js";

export interface HeadlessLaunch {
  execPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface HeadlessOptions {
  dataRoot: string;
  profile?: string;
  version: string;
  /** Commande qui lance le démon (tests) ; par défaut ce même programme avec `serve`. */
  launch?: HeadlessLaunch;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollMs?: number;
}

export const LOG_FILE = "headless.log";
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

/** Ce même programme, relancé en `serve` : mêmes options d'exécution (le chargeur tsx en développement), même profil. */
function defaultLaunch(profile?: string): HeadlessLaunch {
  return {
    execPath: process.execPath,
    args: [...process.execArgv, process.argv[1] ?? "", "serve", ...(profile ? ["--profile", profile] : [])],
  };
}

export async function headlessStart(o: HeadlessOptions): Promise<number> {
  const poll = o.pollMs ?? 200;
  const status = readSupervisorStatus(o.dataRoot);
  if (status.state && !status.stale) {
    console.error(
      `Une instance est déjà en marche (${status.state.mode}, pid ${status.state.pid}${status.stopping ? ", en cours d'arrêt" : ""}). Arrêtez-la d'abord : jarod headless stop.`,
    );
    return 1;
  }
  const dir = profileDirOf(o.dataRoot, o.profile);
  const lock = dir ? readRuntimeLock(dir) : null;
  if (lock && isProcessAlive(lock.pid)) {
    console.error(`Ce profil est déjà servi par un autre processus (${describeMode(lock.mode)}, pid ${lock.pid}). Rien n'a été lancé.`);
    return 1;
  }
  // Un fichier d'état laissé par un processus disparu est nettoyé par `requestStop` (qui ne signale rien à personne dans ce cas).
  if (status.state && status.stale) requestStop(o.dataRoot);

  const launch = o.launch ?? defaultLaunch(o.profile);
  const logPath = join(o.dataRoot, LOG_FILE);
  const fd = openSync(logPath, "a");
  let exited: number | null | undefined;
  let spawnError: Error | undefined;
  const child = spawn(launch.execPath, launch.args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, ...launch.env },
  });
  closeSync(fd);
  child.once("exit", (code) => {
    exited = code;
  });
  child.once("error", (e) => {
    spawnError = e;
  });
  child.unref();

  const timeout = o.startTimeoutMs ?? START_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) {
      console.error(`Lancement impossible : ${spawnError.message}`);
      return 1;
    }
    const s = readSupervisorStatus(o.dataRoot);
    // Aucune instance n'existait avant le lancement (refusé plus haut) : tout état « en marche » est celui du démon lancé. Son pid est celui du fichier
    // d'état, pas forcément celui du processus lancé (un chargeur comme tsx peut s'intercaler).
    if (s.running && s.state) {
      console.log(`Instance en arrière-plan démarrée (pid ${s.state.pid}). Journal : ${logPath}\nArrêt : jarod headless stop`);
      return 0;
    }
    if (exited !== undefined) {
      console.error(`Le démon s'est arrêté au démarrage (code ${String(exited)}). Voir le journal : ${logPath}`);
      return 1;
    }
    await sleep(poll);
  }
  console.error(
    `L'instance n'a pas annoncé son démarrage en ${Math.round(timeout / 1000)} s (pid ${child.pid ?? "?"}, laissée en l'état — rien n'est tué). Voir le journal : ${logPath}`,
  );
  return 1;
}

export function headlessStatus(o: Pick<HeadlessOptions, "dataRoot">): number {
  const s = readSupervisorStatus(o.dataRoot);
  if (!s.state) {
    console.log("Aucune instance en arrière-plan.");
    return 1;
  }
  if (s.stale) {
    console.log(`Aucune instance en marche (fichier d'état périmé : pid ${s.state.pid} disparu).`);
    return 1;
  }
  const since = new Date(s.state.startedAt).toLocaleString();
  console.log(
    `${s.stopping ? "En cours d'arrêt" : "En marche"} : ${s.state.mode}, pid ${s.state.pid}, profil ${s.state.profile}, depuis ${since}, version ${s.state.version}.`,
  );
  return s.running ? 0 : 1;
}

export async function headlessStop(o: Pick<HeadlessOptions, "dataRoot" | "stopTimeoutMs" | "pollMs">): Promise<number> {
  const s = readSupervisorStatus(o.dataRoot);
  if (!s.state || s.stale) {
    if (s.state) requestStop(o.dataRoot); // nettoie l'état périmé
    console.error("Aucune instance en arrière-plan à arrêter.");
    return 1;
  }
  const pid = s.state.pid;
  requestStop(o.dataRoot);
  const timeout = o.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      console.log(`Instance arrêtée (pid ${pid}).`);
      return 0;
    }
    await sleep(o.pollMs ?? 100);
  }
  if (!isProcessAlive(pid)) {
    console.log(`Instance arrêtée (pid ${pid}).`);
    return 0;
  }
  console.error(
    `L'instance (pid ${pid}) n'a pas répondu à la demande d'arrêt en ${Math.round(timeout / 1000)} s. Elle est laissée en vie : rien n'a été tué. Réessayez, ou arrêtez le processus vous-même.`,
  );
  return 1;
}

export async function headlessCommand(sub: string | undefined, o: HeadlessOptions): Promise<number> {
  if (sub === "start") return headlessStart(o);
  if (sub === "status") return headlessStatus(o);
  if (sub === "stop") return headlessStop(o);
  console.error("Usage : jarod headless start|status|stop");
  return 2;
}
