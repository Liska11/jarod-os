// Portage de packages/cli/src/serve.ts (rév. 2e180305). Écarts : `openCore` est asynchrone et
// démarre le kernel (un verrou déjà pris fait donc échouer l'ouverture, plus seulement `init()`) ;
// `core.on("gateway")` → événement kernel `gateway:status`. Pas encore portés (et donc non servis) :
// serveur d'API OpenAI, accès distant (`syncApiServer`, `syncRemote`) — `describeServices` annonce ce que le démon FAIT,
// jamais la seule valeur d'un réglage : un déclencheur entrant ou un accès distant que `serve` ne démarre pas ne s'affiche pas « actif ».
// Le moteur local (`engine.autoStart`) est branché (`startLocalEngine`, partagé avec le bureau : `@jarod/plugin-llm`) : trois gardes, et l'annonce dit l'état du moteur, pas le réglage.
import type { GatewayStatus } from "@jarod/contracts";
import { type AutoStartEngine, engineAutoStartBlock, startLocalEngine } from "@jarod/plugin-llm";
import {
  clearSupervisorState,
  RuntimeLockError,
  readSupervisorStatus,
  stopRequested,
  writeSupervisorState,
} from "@jarod/plugin-agent";
import { type CliContext, type CliCore as JarodCore, defaultDataRoot, openCore } from "./context.js";

/** Ce que `serve` demande au moteur local (`EngineService` le satisfait). */
export type ServeEngine = AutoStartEngine;

export { engineAutoStartBlock, startLocalEngine };

export interface ServeOptions {
  profile?: string;
  env?: NodeJS.ProcessEnv;
  version: string;
  /** How often the stop-request file is polled (tests shorten it). */
  pollMs?: number;
  /** Resolves when the caller wants the daemon to stop (tests); signals and the stop file also do. */
  until?: Promise<void>;
  log?: (line: string) => void;
  /** Le moteur à démarrer (tests) ; par défaut celui du kernel. */
  engine?: (core: JarodCore) => ServeEngine | undefined;
  /** Le dossier temporaire du système (tests) : un profil qui s'y trouve ne démarre pas le moteur. */
  tmpRoot?: string;
}

/** La ligne des déclencheurs entrants : l'état RÉEL du service, pas une constante. */
export async function webhooksLine(core: JarodCore): Promise<string> {
  const webhooks = core.webhooks;
  if (!webhooks) return "non démarrés (service non disponible)";
  const status = webhooks.status();
  if (status.running) {
    return `actif (127.0.0.1:${status.port}, ${status.hooks.length} déclencheur(s))`;
  }
  const settingEnabled = core.settings.get("webhooks")?.enabled ?? false;
  if (settingEnabled) return "non démarrés : réglage activé mais service non lancé (gate vivante non passée ou port occupé)";
  return "non démarrés : réglage éteint";
}

/** La ligne de l'accès distant : l'état RÉEL, et le réglage seulement pour dire qu'il est ignoré. */
export function remoteLine(settingEnabled: boolean): string {
  if (settingEnabled) return "non démarré (reporté P4) — le réglage est activé mais ignoré";
  return "non démarré (reporté P4)";
}

/** What the daemon runs, said once at startup so a journal shows what this instance is for. */
async function describeServices(core: JarodCore): Promise<string[]> {
  const s = core.settings.getAll();
  const on = (b: boolean) => (b ? "actif" : "désactivé");
  const schedules = core.scheduler.list().filter((x) => x.enabled).length;
  const webhooksStatus = await webhooksLine(core);
  return [
    `Telegram : ${on(s.telegram.enabled)} · Discord : ${on(s.discord.enabled)} · Slack : ${on(s.slack.enabled)}`,
    `Tâches planifiées actives : ${schedules} · Déclencheurs entrants : ${webhooksStatus} · Accès distant : ${remoteLine(Boolean(s.remote?.enabled))}`,
    s.autoApproveTools
      ? "Outils sensibles : approuvés automatiquement (autoApproveTools)."
      : "Outils sensibles : refusés sans écran pour les approuver (réglage autoApproveTools pour les autoriser).",
  ];
}

/**
 * `jarod serve`: the core without Electron — messaging bots, scheduled tasks, webhooks, remote
 * access, curator — in the foreground, for a server, a container or a system service (systemd,
 * NSSM, launchd). Stopped by Ctrl-C, SIGTERM, or `jarod headless stop` (the same supervisor file as
 * the desktop's background instance). The profile's runtime lock keeps the desktop app and this
 * daemon from serving the same profile twice.
 */
export async function serve(opts: ServeOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.error(line));
  const root = defaultDataRoot(env);
  const existing = readSupervisorStatus(root);
  if (existing.state && existing.running) {
    log(
      `Une instance tourne déjà (${existing.state.mode}, pid ${existing.state.pid}) : jarod headless stop pour l'arrêter.`,
    );
    return 1;
  }
  if (existing.state && existing.stale) clearSupervisorState(root, existing.state.pid);

  let opened: CliContext;
  try {
    opened = await openCore({
      ...(opts.profile ? { profile: opts.profile } : {}),
      env,
      runtimeMode: "serve",
      init: true,
    });
  } catch (e) {
    log(e instanceof RuntimeLockError ? e.message : `Démarrage impossible : ${(e as Error).message}`);
    return 1;
  }
  const { core, profile, dataDir } = opened;
  try {
    await core.init();
  } catch (e) {
    await core.dispose().catch(() => {});
    log(e instanceof RuntimeLockError ? e.message : `Démarrage impossible : ${(e as Error).message}`);
    return 1;
  }
  writeSupervisorState(root, {
    pid: process.pid,
    mode: "serve",
    startedAt: Date.now(),
    version: opts.version,
    profile,
    dataDir,
    stopRequestedAt: null,
  });
  log(`Jarod-One ${opts.version} servi (pid ${process.pid}, profil ${profile})`);
  log(`Données : ${dataDir}`);
  // L'attente d'arrêt est armée AVANT le démarrage du moteur (qui peut durer jusqu'à son délai de disponibilité) : un arrêt demandé entre-temps
  // est pris en compte dès que le démarrage se termine.
  const stopped = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (stopRequested(root, process.pid)) done("arrêt demandé");
    }, opts.pollMs ?? 2_000);
    const onSignal = () => done("signal reçu");
    function done(why: string) {
      clearInterval(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      log(`${why} : fermeture propre…`);
      resolve();
    }
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    void opts.until?.then(() => done("fin demandée"));
  });
  for (const line of await describeServices(core)) log(line);
  core.app.on("gateway:status", (st: GatewayStatus) => log(`Passerelle : ${JSON.stringify(st)}`));
  core.notifications.on("added", (n) => log(`[${n.kind}] ${n.title}${n.body ? ` — ${n.body.slice(0, 200)}` : ""}`));
  log(await startLocalEngine(opts.engine ? opts.engine(core) : core.engine, engineAutoStartBlock(root, env, opts.tmpRoot), log, "serve"));

  await stopped;

  await core.dispose();
  clearSupervisorState(root, process.pid);
  log("Arrêté.");
  return 0;
}
