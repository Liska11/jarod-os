// Outils système, phase 1 (lecture seule) : `system_info`, `system_processes`, `system_disk_usage`, `system_network`, `system_logs`,
// `system_apps` (installed / running). Portés de Herald OS (plugins/herald-os-bridge, MIT) vers des outils intégrés de Jarod, en TypeScript,
// sans Python (DECISIONS.md:225). Windows seulement : ailleurs la famille n'existe pas (aucun équivalent vérifié ici).
//
// Politique : lecture seule, jamais `dangerous` (aucun accord à chaque appel) mais `audited` (chaque appel laisse une ligne, voir
// registry.ts). Seul `system_disk_usage` prend un chemin, refusé AVANT toute lecture s'il est protégé. Le texte du modèle n'entre jamais
// dans un script PowerShell : il voyage en JSON dans l'environnement (ps.ts).
import { cpus, arch as osArch, homedir, hostname, userInfo } from "node:os";
import { isAbsolute } from "node:path";
import type { ToolContext, ToolDef } from "../registry.js";
import { expandHome, measureTree, protectedRoot, protectedRoots, realPathOrSelf } from "./disk.js";
import { findFiles, KINDS, parseDate, resolveWhen, type Search, WHENS } from "./find.js";
import { buildProcessRows, formatLogLines, LOG_LEVELS, parseBluetooth, parseListeners, parseNetwork, parseRunningApps, parseStartApps, parseSystemInfo, summariseCrash, normaliseExceptionCode } from "./parse.js";
import { asList, powershellExe, type PsRunner, realPsRunner } from "./ps.js";
import * as S from "./scripts.js";

export interface SystemToolDeps {
  /** Remplaçable dans les tests : par défaut le vrai `powershell.exe`. */
  ps?: PsRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  logicalCpus?: number;
}

const json = (value: unknown): string => JSON.stringify(value);

/** Un entier de `args[key]` borné à [min, max], `def` si absent ; une valeur qui n'est pas un nombre est une erreur, pas un défaut silencieux. */
function int(args: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} doit être un nombre`);
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

function oneOf<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[], def: T): T {
  const v = args[key];
  if (v === undefined || v === null || v === "") return def;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new Error(`${key} doit être l'un de : ${allowed.join(", ")}`);
  return v as T;
}

const text = (args: Record<string, unknown>, key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim() : "");

export function systemReadTools(deps: SystemToolDeps = {}): ToolDef[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return [];
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const logical = deps.logicalCpus ?? (cpus().length || 1);
  let ps: PsRunner | undefined = deps.ps;
  const runner = (): PsRunner => (ps ??= realPsRunner());
  const hasPs = () => deps.ps !== undefined || powershellExe(env) !== null;
  const base = { source: "builtin" as const, audited: true };

  const info: ToolDef = {
    ...base,
    name: "system_info",
    description: "Lit les caractéristiques de cet ordinateur : version de Windows, processeur, cœurs, mémoire (totale/utilisée), temps de fonctionnement, disques (total/utilisé/libre par volume), batterie, nom de la machine et de l'utilisateur. À utiliser avant de conseiller un nettoyage ou pour répondre à une question sur la machine. Lecture seule.",
    parameters: { type: "object", properties: {} },
    available: hasPs,
    async run(_args, ctx) {
      const data = (await runner().json(S.SYSTEM_INFO, undefined, { timeoutMs: 30_000, signal: ctx.signal })) as Record<string, unknown> | null;
      return json({ ...parseSystemInfo(data ?? {}), hostname: hostname(), arch: osArch(), user: userInfo().username, home });
    },
  };

  const processes: ToolDef = {
    ...base,
    name: "system_processes",
    description: "Inspecte les processus en cours. action=top : les plus gourmands par CPU ou mémoire (« qu'est-ce qui consomme le plus ? ») ; action=find : par nom ; action=port : ce qui écoute sur un port TCP/UDP (« qu'y a-t-il sur le port 3000 ? »). Lecture seule.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["top", "find", "port"] },
        sort: { type: "string", enum: ["cpu", "memory"], description: "Pour top : le critère (cpu par défaut)." },
        name: { type: "string", description: "Pour find : fragment du nom ou du chemin, sans casse." },
        port: { type: "integer", description: "Pour port : le numéro de port." },
        limit: { type: "integer", description: "Nombre de lignes maximal (15 par défaut, 100 au plus)." },
      },
      required: ["action"],
    },
    available: hasPs,
    async run(args, ctx) {
      const action = oneOf(args, "action", ["top", "find", "port"] as const, "top");
      const limit = int(args, "limit", 15, 1, 100);
      const opts = { timeoutMs: 40_000, signal: ctx.signal };
      if (action === "port") {
        const port = int(args, "port", 0, 0, 65535);
        if (!port) throw new Error("port est requis pour action=port");
        const listeners = parseListeners(await runner().json(S.LISTENERS, { port }, opts), port);
        return json({ port, listeners, note: listeners.length ? null : `Rien n'écoute sur le port ${port}.` });
      }
      const sort = oneOf(args, "sort", ["cpu", "memory"] as const, "cpu");
      const name = action === "find" ? text(args, "name") : "";
      if (action === "find" && !name) throw new Error("name est requis pour action=find");
      const data = (await runner().json(S.PROCESSES, { sort, limit, name }, opts)) as Record<string, unknown> | null;
      const rows = buildProcessRows(data ?? {}, logical);
      return json(action === "find" ? { name, processes: rows } : { sort, processes: rows });
    },
  };

  const disk: ToolDef = {
    ...base,
    name: "system_disk_usage",
    description: "Trouve ce qui occupe l'espace disque : les plus grosses entrées sous un dossier (par défaut le dossier personnel), les plus grosses d'abord. Commencer large, puis refaire l'appel sur la plus grosse entrée pour creuser. Lent sur les très gros arbres (délai de 90 s). Les emplacements protégés (clés SSH/GnuPG, magasins d'identifiants, dossier Windows, Program Files, ProgramData) sont refusés. Lecture seule.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Dossier à mesurer (absolu, ou ~ pour le dossier personnel ; ~ par défaut)." },
        depth: { type: "integer", description: "Niveaux à rapporter sous le chemin (1 par défaut, 3 au plus)." },
        limit: { type: "integer", description: "Entrées au plus (20 par défaut, 100 au plus)." },
      },
    },
    async run(args, ctx) {
      const raw = text(args, "path") || "~";
      const path = expandHome(raw, home);
      if (!isAbsolute(path)) throw new Error(`Chemin non absolu : ${raw}. Donner un chemin complet (ex. C:\\Users\\moi\\Downloads) ou ~.`);
      const depth = int(args, "depth", 1, 1, 3);
      const limit = int(args, "limit", 20, 1, 100);
      const roots = protectedRoots(env, home);
      // Avant toute lecture : par le nom donné, puis par le chemin réel (un lien ou une jonction ne contourne pas la liste).
      const hit = protectedRoot(path, roots) ?? protectedRoot(realPathOrSelf(path), roots);
      if (hit) throw new Error(`${path} est dans l'emplacement protégé ${hit} : cet outil n'y lit rien.`);
      const result = await measureTree(path, depth, { deadline: Date.now() + 90_000, signal: ctx.signal });
      const entries = [...result.sizes].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p, bytes]) => ({ path: p, bytes }));
      return json({
        path,
        total_bytes: result.timedOut ? null : result.total,
        timed_out: result.timedOut,
        entries,
        note: result.timedOut ? "Délai dépassé : mesure partielle." : result.hadErrors ? "Les tailles excluent ce qui n'a pas pu être lu (accès refusé)." : null,
      });
    },
  };

  const network: ToolDef = {
    ...base,
    name: "system_network",
    description: "Connectivité de cet ordinateur. action=status (par défaut) : en ligne ou non, interface par défaut, passerelle, DNS, chaque interface active avec son IPv4, et la liaison Wi-Fi (connectée, canal, débit, signal). action=bluetooth : état de la radio et appareils appairés. Lecture seule.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["status", "bluetooth"] } } },
    available: hasPs,
    async run(args, ctx) {
      const action = oneOf(args, "action", ["status", "bluetooth"] as const, "status");
      if (action === "bluetooth") return json({ bluetooth: parseBluetooth(await runner().json(S.BLUETOOTH, undefined, { timeoutMs: 30_000, signal: ctx.signal })) });
      const data = (await runner().json(S.NETWORK, undefined, { timeoutMs: 45_000, signal: ctx.signal })) as Record<string, unknown> | null;
      return json(parseNetwork(data ?? {}));
    },
  };

  const logs: ToolDef = {
    ...base,
    name: "system_logs",
    description: "Diagnostic. action=log (par défaut) : le journal des événements Windows (Application et Système) — minutes (10 par défaut, 240 au plus), level error|fault|any (error par défaut), process (fragment du nom de la source ou du message), limit (40 par défaut, 200 au plus) ; rend les lignes les plus récentes. action=crashes : les plantages de programmes des 7 derniers jours. action=crash_report : un plantage en détail, report = le numéro d'enregistrement rendu par crashes. Lecture seule ; peut prendre quelques secondes.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["log", "crashes", "crash_report"] },
        minutes: { type: "integer" },
        level: { type: "string", enum: ["error", "fault", "any"] },
        process: { type: "string", description: "Fragment du nom de la source ou du message." },
        limit: { type: "integer" },
        report: { type: "string", description: "Pour crash_report : le numéro d'enregistrement (voir crashes)." },
      },
    },
    available: hasPs,
    async run(args, ctx) {
      const action = oneOf(args, "action", ["log", "crashes", "crash_report"] as const, "log");
      const limit = int(args, "limit", 40, 1, 200);
      if (action === "crashes") {
        const rows = asList(await runner().json(S.CRASHES, { limit: Math.min(limit, 50) }, { timeoutMs: 45_000, signal: ctx.signal }));
        return json({ crashes: rows.map((r) => ({ report: String(r.record), app: r.app ?? null, time: r.time ?? null, module: r.module ?? null, exception_code: normaliseExceptionCode(r.code) })) });
      }
      if (action === "crash_report") {
        const record = text(args, "report");
        if (!record) throw new Error("report est requis pour action=crash_report (voir action=crashes)");
        if (!/^\d+$/.test(record)) throw new Error("Sous Windows, report est le numéro d'enregistrement (voir action=crashes)");
        const row = (await runner().json(S.CRASH, { record: Number(record) }, { timeoutMs: 45_000, signal: ctx.signal })) as Record<string, unknown> | null;
        return json(summariseCrash(row ?? {}));
      }
      const minutes = int(args, "minutes", 10, 1, 240);
      const level = oneOf(args, "level", ["error", "fault", "any"] as const, "error");
      const proc = text(args, "process");
      const rows = await runner().json(S.EVENT_LOG, { minutes, levels: LOG_LEVELS[level], process: proc, limit }, { timeoutMs: 60_000, signal: ctx.signal });
      return json({ minutes, level, process: proc || null, lines: formatLogLines(rows, limit) });
    },
  };

  const apps: ToolDef = {
    ...base,
    name: "system_apps",
    description: "Applications de cet ordinateur. action=installed : les applications du menu Démarrer (pas toutes les applications installées), filtrables par nom ; action=running : celles qui ont une fenêtre ouverte. Lecture seule (fermer une application n'est pas encore disponible).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["installed", "running"] },
        filter: { type: "string", description: "Fragment du nom, sans casse." },
      },
      required: ["action"],
    },
    available: hasPs,
    async run(args, ctx) {
      const action = oneOf(args, "action", ["installed", "running"] as const, "installed");
      const needle = text(args, "filter").toLowerCase();
      const opts = { timeoutMs: 30_000, signal: ctx.signal };
      const all = action === "installed" ? parseStartApps(await runner().json(S.INSTALLED_APPS, undefined, opts)) : parseRunningApps(await runner().json(S.RUNNING_APPS, undefined, opts));
      const kept = needle ? all.filter((a) => a.name.toLowerCase().includes(needle)) : all;
      return json({ count: kept.length, apps: kept.slice(0, 300) });
    },
  };

  const find: ToolDef = {
    ...base,
    name: "system_find_files",
    description: "Cherche des fichiers et dossiers par leur NOM sur cet ordinateur, hors du dossier de travail (find_files, lui, ne cherche que dans le dossier de travail ; le contenu des fichiers n'est pas lu ici). Combiner : name (fragment du nom, sans casse), text (idem), kind (image, screenshot, document, pdf, video, audio, folder, code, archive), when (today, yesterday, this_week, last_7_days, this_month) ou since/until (AAAA-MM-JJ ou ISO 8601) sur la date de CRÉATION, extensions, scope (un dossier). Sans scope : Bureau, Documents, Téléchargements, Images, Vidéos et Musique (et leurs équivalents OneDrive). Exemple : « les captures d'écran d'hier » → kind=screenshot, when=yesterday. Rend les plus récents d'abord ; les emplacements protégés ne sont ni parcourus ni cités. Lecture seule ; délai de 25 s.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Fragment du nom du fichier, sans casse." },
        text: { type: "string", description: "Mots à trouver dans le nom (le contenu n'est pas lu)." },
        kind: { type: "string", enum: [...KINDS] },
        when: { type: "string", enum: [...WHENS], description: "Fenêtre relative sur la date de création." },
        since: { type: "string", description: "Créé à partir de ce jour (AAAA-MM-JJ ou ISO 8601)." },
        until: { type: "string", description: "Créé avant la fin de ce jour (AAAA-MM-JJ ou ISO 8601)." },
        scope: { type: "string", description: "Ne chercher que sous ce dossier (absolu, ou ~)." },
        extensions: { type: "array", items: { type: "string" }, description: 'Extensions, ex. ["png", "jpg"].' },
        limit: { type: "integer", description: "Résultats au plus (50 par défaut, 200 au plus)." },
      },
    },
    async run(args, ctx) {
      const kind = oneOf(args, "kind", KINDS, "any");
      const when = oneOf(args, "when", ["", ...WHENS] as const, "");
      const extensions = Array.isArray(args.extensions) ? args.extensions.filter((e): e is string => typeof e === "string") : [];
      const name = text(args, "name");
      const needle = text(args, "text");
      let since = text(args, "since");
      let until = text(args, "until");
      if (when) ({ since, until } = resolveWhen(when));
      if (!name && !needle && kind === "any" && !since && !until && extensions.length === 0) {
        throw new Error("Donner au moins un critère : name, text, kind, when ou since/until, extensions.");
      }
      const scope = text(args, "scope");
      const search: Search = {
        ...(name ? { name } : {}),
        ...(needle ? { text: needle } : {}),
        kind,
        since: since ? parseDate(since, false) : null,
        until: until ? parseDate(until, true) : null,
        extensions,
        limit: int(args, "limit", 50, 1, 200),
      };
      const result = await findFiles(search, { env, home, ...(scope ? { scope } : {}), signal: ctx.signal });
      return json({
        count: result.files.length,
        files: result.files,
        partial: result.partial,
        note: result.files.length
          ? result.partial
            ? "Recherche interrompue (délai ou trop d'entrées) : il peut y avoir d'autres résultats. Préciser scope ou les critères."
            : null
          : result.partial
            ? "Rien trouvé avant l'interruption de la recherche (délai ou trop d'entrées). Préciser scope ou les critères."
            : scope
              ? "Aucun résultat dans ce dossier."
              : "Aucun résultat. Sans scope, la recherche couvre Bureau, Documents, Téléchargements, Images, Vidéos et Musique ; donner scope pour chercher ailleurs.",
      });
    },
  };

  return [info, processes, disk, network, logs, apps, find];
}

export type { ToolContext };
