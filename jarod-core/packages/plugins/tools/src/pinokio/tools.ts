// Outils Pinokio (ADR-022) : chercher, installer, lancer, surveiller et arrêter des apps d'IA (image, voix, vidéo, LLM…) avec le
// moteur Pinokio que Jarod-OS embarque. Même déroulé que le skill officiel de Pinokio (`pterm`) : chercher parmi les apps installées,
// puis, avec l'accord de l'utilisateur, dans le registre public ; installer ; lancer le script par défaut du lanceur jusqu'à ce que
// l'app soit prête (`ready_url`) ; lire ses journaux en cas d'échec ; la laisser tourner ensuite.
//
// Politique : les lectures (`pinokio_search`, `pinokio_status`, `pinokio_logs`) sont sans accord mais auditées. Installer, lancer et
// arrêter exécutent les scripts d'un dépôt git (des commandes shell, des téléchargements de plusieurs Go) : `dangerous`, un accord à
// chaque appel, dont la demande dit l'app et ce qui va se passer. Un lancement continue en arrière-plan dans le moteur ; l'outil rend
// la main après `wait_seconds` et `pinokio_status` dit la suite.
import { isAbsolute, resolve } from "node:path";
import type { ToolDef } from "../registry.js";
import { askShell, type Packet, PinokioClient, type PinokioDeps, REGISTRY_URL, streamText, tail } from "./client.js";

export interface PinokioToolDeps extends PinokioDeps {
  platform?: NodeJS.Platform;
  /** Montre une page de l'ordinateur dans une fenêtre Jarod-OS (commande `pinokio.show` du shell). Remplaçable dans les tests. */
  show?: (url: string) => Promise<void>;
}

interface AppStatus {
  app_id?: string;
  title?: string;
  description?: string;
  path?: string;
  running?: boolean;
  ready?: boolean;
  ready_url?: string | null;
  state?: string;
  running_scripts?: string[];
  default_target?: unknown;
  error?: string;
}

/** Un lancement en cours dans le moteur, suivi par le cœur : la suite de scripts (install → start) jusqu'à l'app prête. */
interface Run {
  app: string;
  state: "running" | "done" | "failed";
  step: string;
  log: string;
  url?: string;
  error?: string;
  startedAt: number;
}

const json = (value: unknown): string => JSON.stringify(value);
const text = (args: Record<string, unknown>, key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim() : "");

function int(args: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} doit être un nombre`);
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** Un identifiant d'app Pinokio : le nom de son dossier sous `<home>/api` (« comfy.git », « facefusion-pinokio.git »). */
const APP_ID = /^[A-Za-z0-9._-]{1,120}$/;

function appId(args: Record<string, unknown>): string {
  const id = text(args, "app_id");
  if (!APP_ID.test(id) || id === "." || id === "..") throw new Error("app_id doit être le nom du dossier de l'app (pinokio_search le donne)");
  return id;
}

/** Une adresse de dépôt à installer : https seulement (le registre de Pinokio ne donne que des dépôts GitHub/Hugging Face). */
function repoUri(args: Record<string, unknown>): string {
  const uri = text(args, "uri");
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("uri doit être l'adresse https d'un dépôt git (pinokio_search scope=registry la donne)");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("uri doit être une adresse https sans identifiants");
  return url.toString();
}

export function pinokioTools(deps: PinokioToolDeps = {}): ToolDef[] {
  const client = new PinokioClient(deps);
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const show =
    deps.show ??
    (async (url: string) => {
      const reply = await askShell("pinokio.show", env, 30_000, { url });
      if (reply.ok === false) throw new Error(String(reply.error ?? reply.summary ?? "la fenêtre n'a pas pu s'ouvrir"));
    });
  const runs = new Map<string, Run>();
  const available = () => client.available;
  const read = { source: "builtin" as const, audited: true, available };
  const act = { source: "builtin" as const, dangerous: true, available };

  const status = async (id: string, probe = false, signal?: AbortSignal): Promise<AppStatus | null> => {
    const { status: code, body } = await client.get<AppStatus>(`/apps/status/${encodeURIComponent(id)}`, { probe: probe ? 1 : 0 }, signal);
    if (code === 404) return null;
    if (code >= 400) throw new Error(`le moteur a répondu ${code} : ${body?.error ?? ""}`);
    return body;
  };

  const brief = (s: AppStatus) => ({
    app_id: s.app_id,
    title: s.title,
    state: s.state,
    running: s.running,
    ready: s.ready,
    ready_url: s.ready_url ?? null,
    running_scripts: s.running_scripts ?? [],
  });

  /** Le script que le menu du lanceur propose maintenant (installer, démarrer, ouvrir l'interface…), comme `pterm run`. */
  const defaultTarget = async (appPath: string, defaults: string[] | undefined, signal?: AbortSignal): Promise<{ uri: string; input?: unknown } | null> => {
    let found: { uri: string; input?: unknown } | null = null;
    // `source: pterm` : le moteur traite la demande comme celle de son propre outil en ligne de commande (pas d'interface à ouvrir).
    await client.session({ uri: appPath, mode: "open", default: defaults, source: "pterm", client: { source: "pterm" } }, (packet) => {
      const data = packet.data as { uri?: unknown; input?: unknown } | undefined;
      if (!data) return false;
      found = typeof data.uri === "string" && data.uri ? { uri: data.uri, input: data.input } : null;
      return true;
    }, 60_000, signal);
    // pterm arrête ensuite la demande « open » (elle ne doit rien laisser tourner).
    await client.session({ method: "kernel.api.stop", params: { uri: appPath } }, () => true, 2_000).catch(() => undefined);
    return found;
  };

  /** Fait tourner les scripts par défaut l'un après l'autre (install puis start…) jusqu'à ce que le menu propose une adresse. */
  const drive = async (run: Run, appPath: string, defaults: string[] | undefined) => {
    let previous = "";
    try {
      for (let round = 0; round < 8; round++) {
        const target = await defaultTarget(appPath, defaults);
        if (!target) break;
        if (!isAbsolute(target.uri)) {
          if (/^https?:\/\//i.test(target.uri)) run.url = target.uri;
          break;
        }
        // Le même script deux fois de suite : il ne fait pas avancer le menu (une app déjà démarrée, un script interactif).
        if (target.uri === previous) break;
        previous = target.uri;
        run.step = target.uri.slice(appPath.length).replace(/^[\\/]+/, "") || target.uri;
        run.log += `\n── ${run.step} ──\n`;
        let failed = "";
        // Une app qui tourne en tâche de fond (un serveur web) ne rend pas toujours de résultat : prête, on cesse d'attendre son script,
        // qui continue dans le moteur (fermer notre WebSocket ne l'arrête pas).
        const watch = new AbortController();
        let ready = false;
        void (async () => {
          while (!watch.signal.aborted) {
            await new Promise((r) => setTimeout(r, 5_000));
            if (watch.signal.aborted) return;
            const now = await status(run.app).catch(() => null);
            if (now?.ready && now.ready_url) {
              run.url = now.ready_url;
              ready = true;
              watch.abort();
            }
          }
        })();
        await client.session(
          { uri: target.uri, ...(target.input ? { input: target.input } : {}), source: "pterm", client: { cols: 160, rows: 40, source: "pterm" } },
          (packet: Packet) => {
            if (packet.type === "stream") {
              run.log = tail(run.log + streamText(packet), 20_000);
              return false;
            }
            if (packet.type === "error") {
              failed = typeof packet.data === "string" ? packet.data : json(packet.data);
              return true;
            }
            return packet.type === "result" || packet.type === "stop" || packet.type === "disconnect";
          },
          // Une installation télécharge Python, torch, des modèles : jusqu'à une heure par script.
          3_600_000,
          watch.signal,
        );
        watch.abort();
        if (failed) throw new Error(failed);
        if (ready) break;
      }
      const final = await status(run.app, true).catch(() => null);
      run.url = final?.ready_url ?? run.url;
      run.state = "done";
    } catch (error) {
      run.state = "failed";
      run.error = error instanceof Error ? error.message : String(error);
    }
  };

  const search: ToolDef = {
    ...read,
    name: "pinokio_search",
    description:
      "Cherche une app d'IA Pinokio (génération d'images, voix, vidéo, transcription, LLM local…). scope=installed (par défaut) : parmi les apps déjà installées, avec leur état (running/ready). scope=registry : dans le registre public de Pinokio (apps vérifiées installables) ; ne l'utiliser que si aucune app installée ne convient, après l'accord de l'utilisateur. La requête : 2 à 4 mots-clés de capacité (« tts speech », « image upscale ») ou le nom de l'app, pas une phrase.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Mots-clés ou nom d'app." },
        scope: { type: "string", enum: ["installed", "registry"] },
        limit: { type: "integer", description: "8 par défaut, 25 au plus." },
      },
      required: ["query"],
    },
    async run(args, ctx) {
      const query = text(args, "query");
      if (!query) throw new Error("query est requis");
      const limit = int(args, "limit", 8, 1, 25);
      if (args.scope === "registry") {
        const os = platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux";
        const { status: code, body } = await client.getUrl<Record<string, unknown>>(`${REGISTRY_URL}/v1/search`, { q: query, platform: os, limit }, ctx.signal);
        if (code >= 400) throw new Error(`le registre Pinokio a répondu ${code}`);
        return json({ source: "registry", hint: "pinokio_install avec l'uri du dépôt installe l'app choisie.", ...body });
      }
      const terms = query.split(/\s+/).filter(Boolean).length;
      const first = await client.get<{ apps?: unknown[] }>("/apps/search", { q: query, mode: "balanced", min_match: terms >= 3 ? 2 : 1, limit }, ctx.signal);
      let apps = first.body?.apps ?? [];
      if (apps.length === 0) apps = (await client.get<{ apps?: unknown[] }>("/apps/search", { q: query, mode: "broad", limit }, ctx.signal)).body?.apps ?? [];
      return json({ source: "installed", count: apps.length, apps, ...(apps.length === 0 ? { hint: "Aucune app installée ne correspond : proposer de chercher dans le registre (scope=registry)." } : {}) });
    },
  };

  const appStatus: ToolDef = {
    ...read,
    name: "pinokio_status",
    description:
      "État d'une app Pinokio installée : offline / starting / online, prête ou non, son adresse (ready_url) quand elle tourne, ses scripts en cours, et la progression d'un lancement demandé par pinokio_run (étape, fin du journal). probe=true vérifie que l'adresse répond vraiment.",
    parameters: {
      type: "object",
      properties: { app_id: { type: "string" }, probe: { type: "boolean" } },
      required: ["app_id"],
    },
    async run(args, ctx) {
      const id = appId(args);
      const s = await status(id, args.probe === true, ctx.signal);
      if (!s) throw new Error(`aucune app « ${id} » dans Pinokio (pinokio_search la trouve)`);
      const run = runs.get(id);
      return json({ ...brief(s), ...(run ? { launch: { state: run.state, step: run.step, url: run.url ?? null, error: run.error ?? null, seconds: Math.round((Date.now() - run.startedAt) / 1000), log_tail: tail(run.log, 2_500) } } : {}) });
    },
  };

  const logs: ToolDef = {
    ...read,
    name: "pinokio_logs",
    description: "Les dernières lignes du journal d'une app Pinokio (le script en cours, ou celui demandé), pour diagnostiquer un échec d'installation ou de lancement.",
    parameters: {
      type: "object",
      properties: {
        app_id: { type: "string" },
        script: { type: "string", description: "Un script du lanceur (install.js, start.js…) ; par défaut le dernier lancé." },
        tail: { type: "integer", description: "Nombre de lignes, 200 par défaut, 1000 au plus." },
      },
      required: ["app_id"],
    },
    async run(args, ctx) {
      const id = appId(args);
      const { status: code, body } = await client.get<Record<string, unknown>>(`/apps/logs/${encodeURIComponent(id)}`, { tail: int(args, "tail", 200, 1, 1000), script: text(args, "script") || undefined }, ctx.signal);
      if (code >= 400) throw new Error(`pas de journal : ${String((body as { error?: unknown })?.error ?? code)}`);
      return json(body);
    },
  };

  const install: ToolDef = {
    ...act,
    name: "pinokio_install",
    description:
      "Télécharge le lanceur d'une app Pinokio (un dépôt git, par son uri https donnée par pinokio_search scope=registry) dans le dossier de Pinokio. Ne fait que le téléchargement du lanceur ; pinokio_run installe ensuite l'app elle-même. name : un autre nom de dossier (pour une deuxième copie).",
    parameters: {
      type: "object",
      properties: { uri: { type: "string" }, name: { type: "string" }, branch: { type: "string" } },
      required: ["uri"],
    },
    precheck(args) {
      const uri = repoUri(args);
      return `Télécharger le lanceur Pinokio ${uri} (un dépôt git dont les scripts pourront ensuite installer et lancer l'app).`;
    },
    async run(args, ctx) {
      const uri = repoUri(args);
      const name = text(args, "name");
      if (name && !APP_ID.test(name)) throw new Error("name : lettres, chiffres, point, tiret, souligné");
      const branch = text(args, "branch");
      let log = "";
      let result: Record<string, unknown> | null = null;
      let failure = "";
      const how = await client.session(
        { method: "app.download", params: { uri, ...(name ? { name } : {}), ...(branch ? { branch } : {}) } },
        (packet) => {
          if (packet.type === "stream") {
            log = tail(log + streamText(packet), 6_000);
            return false;
          }
          if (packet.type === "result") {
            result = (packet.data as Record<string, unknown>) ?? {};
            return true;
          }
          if (packet.type === "error") {
            failure = typeof packet.data === "string" ? packet.data : json(packet.data);
            return true;
          }
          return false;
        },
        900_000,
        ctx.signal,
      );
      if (failure) throw new Error(`échec du téléchargement : ${failure}\n${tail(log, 1_500)}`);
      const done = result as Record<string, unknown> | null;
      if (!done || done.ok === false) throw new Error(`échec du téléchargement : ${String(done?.error ?? how)}${done?.path ? ` (${String(done.path)})` : ""}\n${tail(log, 1_500)}`);
      return json({ ok: true, ...done, hint: "pinokio_run avec l'app_id (le nom du dossier) installe puis lance l'app.", log_tail: tail(log, 1_500) });
    },
  };

  const run: ToolDef = {
    ...act,
    name: "pinokio_run",
    description:
      "Lance une app Pinokio installée : fait tourner le script que son menu propose (l'installation la première fois, qui peut télécharger plusieurs Go, puis le démarrage) jusqu'à ce qu'elle soit prête, et rend son adresse (ready_url). Le lancement continue en arrière-plan après wait_seconds ; pinokio_status donne la suite. Une app déjà prête n'est pas relancée. defaults : sélecteurs de script quand le menu n'en désigne pas (ex. [\"start.js\", \"install.js\"]).",
    parameters: {
      type: "object",
      properties: {
        app_id: { type: "string" },
        wait_seconds: { type: "integer", description: "Combien attendre avant de rendre la main (90 par défaut, 600 au plus)." },
        defaults: { type: "array", items: { type: "string" } },
      },
      required: ["app_id"],
    },
    async precheck(args) {
      const id = appId(args);
      return `Lancer l'app Pinokio « ${id} » : ses scripts s'exécutent sur cet ordinateur (installation de ses dépendances au premier lancement, puis démarrage).`;
    },
    async run(args, ctx) {
      const id = appId(args);
      const waitMs = int(args, "wait_seconds", 90, 0, 600) * 1000;
      const defaults = Array.isArray(args.defaults) ? (args.defaults as unknown[]).filter((d): d is string => typeof d === "string" && d.length < 200).slice(0, 6) : undefined;
      const s = await status(id, true, ctx.signal);
      if (!s?.path) throw new Error(`aucune app « ${id} » dans Pinokio (pinokio_search la trouve, pinokio_install l'ajoute)`);
      if (s.ready && s.ready_url) return json({ ...brief(s), already: true });
      let current = runs.get(id);
      if (current?.state !== "running") {
        current = { app: id, state: "running", step: "", log: "", startedAt: Date.now() };
        runs.set(id, current);
        void drive(current, resolve(s.path), defaults);
      }
      const until = Date.now() + waitMs;
      while (current.state === "running" && Date.now() < until && !ctx.signal?.aborted) await new Promise((r) => setTimeout(r, 1_000));
      const now = await status(id, current.state !== "running", ctx.signal).catch(() => s);
      return json({
        ...brief(now ?? s),
        launch: { state: current.state, step: current.step, url: current.url ?? now?.ready_url ?? null, error: current.error ?? null, log_tail: tail(current.log, 2_500) },
        ...(current.state === "running" ? { hint: "Toujours en cours : pinokio_status dans un moment." } : {}),
      });
    },
  };

  const stop: ToolDef = {
    ...act,
    name: "pinokio_stop",
    description: "Arrête une app Pinokio qui tourne (tous ses scripts en cours) et libère la mémoire qu'elle occupe (GPU compris).",
    parameters: { type: "object", properties: { app_id: { type: "string" } }, required: ["app_id"] },
    precheck(args) {
      return `Arrêter l'app Pinokio « ${appId(args)} » et tous ses scripts en cours.`;
    },
    async run(args, ctx) {
      const id = appId(args);
      const s = await status(id, false, ctx.signal);
      if (!s?.path) throw new Error(`aucune app « ${id} » dans Pinokio`);
      const scripts = s.running_scripts ?? [];
      for (const script of scripts) {
        await client.session({ method: "kernel.api.stop", params: { uri: resolve(s.path, script) } }, () => true, 5_000, ctx.signal);
      }
      const after = await status(id, false, ctx.signal).catch(() => null);
      return json({ stopped: scripts, ...(after ? brief(after) : {}) });
    },
  };

  const open: ToolDef = {
    ...read,
    name: "pinokio_open",
    description: "Montre à l'utilisateur l'interface d'une app Pinokio qui tourne (son ready_url, une adresse de cet ordinateur) dans une fenêtre Jarod-OS. Seulement quand l'utilisateur veut la voir ou s'en servir lui-même, pas pour l'automatiser.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(args) {
      const url = text(args, "url");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("url invalide");
      }
      const host = parsed.hostname.toLowerCase();
      if (!/^https?:$/.test(parsed.protocol) || !(host === "localhost" || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host) || host === "[::1]")) {
        throw new Error("pinokio_open montre des pages de cet ordinateur seulement (localhost, 127.0.0.1, *.localhost)");
      }
      await show(parsed.toString());
      return json({ ok: true, shown: parsed.toString() });
    },
  };

  return [search, appStatus, logs, install, run, stop, open];
}
