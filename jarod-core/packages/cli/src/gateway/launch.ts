// Jarod-OS : le lanceur. Démarre la passerelle de Jarod sur un profil, puis l'application Jarod-OS (le shell dérivé de Herald OS) branchée dessus, et arrête la passerelle quand la fenêtre se ferme.
//   tsx src/gateway/launch.ts [--workspace D:\JAROD-OS] [--data <dossier>] [--real-profile] [--herald <Jarod-OS.exe>]
//
// Par défaut, Jarod-OS a SON profil (`<data>\profile`) : il ne touche pas aux données de l'application Jarod. `--real-profile` ouvre à la place le profil réel
// de Jarod (ses fournisseurs, sa mémoire, ses planifications) : le verrou du profil empêche alors de lancer les deux en même temps. Herald a ses propres
// dossiers (`<data>\herald-home`, `<data>\herald-userdata`) : il ne partage rien avec une installation de Herald ou de Hermes existante.
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ProfileManager } from "@jarod/plugin-persona";

export interface LaunchOptions {
  workspace: string;
  /** Là où Jarod-OS range ses données (profil, dossiers de Herald, journal). */
  dataDir: string;
  /** Ouvre le profil réel de Jarod au lieu du profil de Jarod-OS. */
  realProfile: boolean;
  /** L'application Jarod-OS et ses arguments de tête (un script de test, par exemple). */
  herald: string;
  heraldArgs: string[];
  env: NodeJS.ProcessEnv;
  /** La commande qui lance la passerelle (`node` + les options de tsx + `main.ts`). Remplaçable. */
  gatewayCommand?: { file: string; args: string[] };
  /** Délai pour que la passerelle annonce qu'elle est prête. */
  readyTimeoutMs?: number;
  log?: (line: string) => void;
}

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKSPACE = "D:\\JAROD-OS";
export const DEFAULT_HERALD = "C:\\Users\\San\\herald-os\\apps\\desktop\\release\\win-unpacked\\Jarod-OS.exe";

/**
 * La commande qui lance la passerelle (`main.ts`). Sous `tsx`, ses options (chargeur TypeScript) sont dans `process.execArgv` et se transmettent telles
 * quelles ; sinon (un test, un autre lanceur) on retrouve la ligne de commande de `tsx` installé avec le dépôt.
 */
export function defaultGatewayCommand(): { file: string; args: string[] } {
  const main = join(here, "main.ts");
  if (process.execArgv.some((a) => /tsx/i.test(a))) return { file: process.execPath, args: [...process.execArgv, main] };
  const cli = createRequire(import.meta.url).resolve("tsx/cli");
  return { file: process.execPath, args: [cli, main] };
}

/** Les arguments de la ligne de commande → les options. Lève avec un message pour l'utilisateur. */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): LaunchOptions {
  const take = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const many = (flag: string): string[] => argv.flatMap((a, i) => (a === flag && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
  const localAppData = env.LOCALAPPDATA || join(env.USERPROFILE || ".", "AppData", "Local");
  const workspace = take("--workspace") ?? env.JAROD_WORKSPACE ?? DEFAULT_WORKSPACE;
  const dataDir = take("--data") ?? env.JAROD_OS_DATA ?? join(localAppData, "Jarod-OS");
  const herald = take("--herald") ?? env.HERALD_OS_EXE ?? DEFAULT_HERALD;
  for (const [what, p] of [["--workspace", workspace], ["--data", dataDir], ["--herald", herald]] as const) {
    if (!isAbsolute(p)) throw new Error(`${what} : un chemin absolu est attendu (reçu « ${p} »)`);
  }
  return { workspace, dataDir, realProfile: argv.includes("--real-profile"), herald, heraldArgs: many("--herald-arg"), env };
}

/** L'adresse et le jeton que la passerelle écrit dans son fichier (le jeton n'est jamais imprimé). */
export function readGatewayFile(file: string): { url: string; token: string } {
  const data = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown; token?: unknown };
  if (typeof data.url !== "string" || typeof data.token !== "string" || !data.url || !data.token) throw new Error(`Fichier de la passerelle illisible : ${file}`);
  return { url: data.url, token: data.token };
}

/** Attend la ligne `JAROD_GATEWAY_FILE <chemin>` sur la sortie de la passerelle ; échoue si elle s'arrête ou tarde. */
export function waitForGateway(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolveFile, reject) => {
    let buffer = "";
    let ready = false;
    const timer = setTimeout(() => done(new Error(`La passerelle n'a pas annoncé qu'elle était prête en ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    const done = (err: Error | null, file?: string) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      if (err) reject(err);
      else resolveFile(file!);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const m = /^JAROD_GATEWAY_FILE (.+)$/m.exec(buffer);
      if (m && !ready) {
        ready = true;
        done(null, m[1]!.trim());
      }
    };
    const onExit = (code: number | null) => done(new Error(`La passerelle s'est arrêtée au démarrage (code ${String(code)})`));
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

/** Demande l'arrêt de la passerelle en fermant son entrée, puis, passé le délai, la termine. */
export function stopGateway(child: ChildProcess, graceMs = 8000): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveStop();
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Déjà terminée.
      }
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.stdin?.end();
  });
}

/** Lance tout et rend le code de sortie de Herald. */
export async function launch(opts: LaunchOptions): Promise<number> {
  const log = opts.log ?? ((l: string) => console.error(`[jarod-os] ${l}`));
  if (!existsSync(opts.workspace) || !statSync(opts.workspace).isDirectory()) throw new Error(`Dossier de travail introuvable : ${opts.workspace}`);
  if (!existsSync(opts.herald)) throw new Error(`Application Jarod-OS introuvable : ${opts.herald} (--herald <chemin> ou HERALD_OS_EXE)`);

  const heraldHome = join(opts.dataDir, "herald-home");
  const heraldUserData = join(opts.dataDir, "herald-userdata");
  for (const d of [opts.dataDir, heraldHome, heraldUserData]) mkdirSync(d, { recursive: true });

  // Le profil : celui de Jarod-OS (créé au premier lancement), ou le profil réel de Jarod.
  const gatewayEnv: NodeJS.ProcessEnv = { ...opts.env };
  const extra = ["--init", "--exit-on-stdin-close", "--workspace", opts.workspace];
  if (opts.realProfile) {
    delete gatewayEnv.JAROD_HOME;
    extra.push("--real-profile");
    log("profil RÉEL de Jarod (fournisseurs, mémoire, planifications) ; ne pas lancer l'application Jarod en même temps");
  } else {
    const root = join(opts.dataDir, "profile");
    // Le gestionnaire de profils crée un profil par défaut à l'ouverture : le premier lancement se reconnaît à un dossier encore vide.
    const first = !existsSync(root) || readdirSync(root).length === 0;
    mkdirSync(root, { recursive: true });
    const profiles = new ProfileManager(root);
    if (profiles.list().length === 0) {
      profiles.create("default");
      profiles.setActive("default");
    }
    if (first) log(`premier lancement : profil créé dans ${root}`);
    gatewayEnv.JAROD_HOME = root;
    log(`profil de Jarod-OS : ${root}`);
  }

  const command = opts.gatewayCommand ?? defaultGatewayCommand();
  const logFile = createWriteStream(join(opts.dataDir, "gateway.log"), { flags: "a" });
  const gateway = spawn(command.file, [...command.args, ...extra], { cwd: resolve(here, ".."), env: gatewayEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  gateway.stderr?.pipe(logFile);
  log("démarrage de la passerelle…");

  let heraldChild: ChildProcess | null = null;
  const shutdown = async () => {
    heraldChild?.kill();
    await stopGateway(gateway);
    logFile.end();
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown());

  let info: { url: string; token: string };
  try {
    info = readGatewayFile(await waitForGateway(gateway, opts.readyTimeoutMs ?? 90_000));
  } catch (e) {
    await stopGateway(gateway, 1000);
    logFile.end();
    throw e;
  }
  log(`passerelle prête sur ${info.url} ; dossier de travail ${opts.workspace}`);

  const heraldEnv: NodeJS.ProcessEnv = {
    ...opts.env,
    HERALD_OS_BACKEND_URL: info.url,
    HERALD_OS_BACKEND_TOKEN: info.token,
    HERMES_HOME: heraldHome,
  };
  delete heraldEnv.ELECTRON_RUN_AS_NODE;
  const code = await new Promise<number>((resolveCode) => {
    heraldChild = spawn(opts.herald, [...opts.heraldArgs, `--user-data-dir=${heraldUserData}`], { env: heraldEnv, stdio: "ignore" });
    heraldChild.once("error", (e) => {
      log(`Herald n'a pas démarré : ${e.message}`);
      resolveCode(1);
    });
    heraldChild.once("exit", (c) => resolveCode(c ?? 0));
  });
  log("fenêtre fermée, arrêt de la passerelle…");
  await shutdown();
  return code;
}

// Lancé directement (`tsx src/gateway/launch.ts`) : exécute. Importé (tests) : ne fait rien.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch(parseArgs(process.argv.slice(2), process.env)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`[jarod-os] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
