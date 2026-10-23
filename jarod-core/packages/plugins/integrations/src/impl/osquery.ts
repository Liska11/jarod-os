/**
 * G13 — diagnostics système par osquery (osquery/osquery, `osqueryi` seulement : aucun démon, aucune installation).
 *
 *  - Les diagnostics PRÉDÉFINIS sont les raccourcis : l'agent choisit un identifiant. Ils évitent les données sensibles inutiles : ni ligne
 *    de commande ni chemin des processus, ni comptes, ni historique, ni navigateur, ni réseaux Wi-Fi. Des diagnostics PARAMÉTRÉS (un service,
 *    un port, un programme) prennent une valeur validée, jamais du SQL.
 *  - Autonomie configurable (2026-10-21) : la requête LIBRE (`query: "sql"`) existe, mais c'est une opération RÉSERVÉE — refusée tant que
 *    l'utilisateur ne l'a pas accordée par une règle (`jarod permissions add allow system_diagnostics --operation sql`). Lecture seule
 *    (osquery n'écrit pas) ; une seule instruction SELECT ; les tables qui sortent sur le réseau (`curl`, `curl_certificate`) sont refusées :
 *    elles contourneraient l'interrupteur Internet.
 *  - Lancé avec les droits de l'utilisateur (jamais élevé), sans base (`--disable_database`), sans journal, sans extension, sans
 *    événements ; profil redirigé dans un dossier temporaire supprimé ensuite. Délai, plafond de lignes et de sortie.
 *  - Une erreur SQL d'osquery s'écrit sur la sortie d'erreur avec un code de retour 0 (mesuré, 5.23.1) : elle est détectée ici, jamais
 *    rendue comme un résultat vide.
 *  - Chaque résultat porte sa provenance (version d'osquery, requête), son horodatage et les privilèges utilisés.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRefused, AdapterUnavailable } from "./common.js";

export interface OsqueryPreset {
  description: string;
  sql: string;
}

export const OSQUERY_PRESETS: Record<string, OsqueryPreset> = {
  os: { description: "version de Windows", sql: "select name, version, build, platform, arch from os_version" },
  hardware: { description: "processeur, mémoire, modèle", sql: "select cpu_brand, cpu_physical_cores, cpu_logical_cores, physical_memory, hardware_vendor, hardware_model from system_info" },
  uptime: { description: "durée depuis le dernier démarrage", sql: "select days, hours, minutes, total_seconds from uptime" },
  disks: { description: "lecteurs, taille et espace libre", sql: "select device_id, type, file_system, size, free_space from logical_drives" },
  "top-memory": { description: "15 processus les plus gourmands en mémoire (nom seulement)", sql: "select pid, name, resident_size, total_size from processes order by resident_size desc limit 15" },
  "listening-ports": { description: "ports en écoute et processus propriétaire (nom seulement)", sql: "select l.port, l.protocol, l.address, l.pid, p.name from listening_ports l left join processes p using (pid) where l.port != 0 order by l.port limit 200" },
  "stopped-auto-services": { description: "services à démarrage automatique qui ne tournent pas", sql: "select name, display_name, status, start_type from services where start_type = 'AUTO_START' and status != 'RUNNING' limit 100" },
  startup: { description: "programmes lancés au démarrage (nom, source, état)", sql: "select name, source, status from startup_items limit 200" },
  patches: { description: "correctifs Windows installés", sql: "select hotfix_id, description, installed_on from patches limit 200" },
  programs: { description: "programmes installés (nom, version, éditeur)", sql: "select name, version, publisher from programs order by name limit 500" },
};

/** Diagnostics paramétrés : une valeur validée par l'adaptateur, jamais du SQL du modèle. */
export const OSQUERY_PARAMETRIZED: Record<string, { description: string; param: "name" | "port"; build(v: string | number): string }> = {
  "service-status": {
    description: "état d'un service (par son nom ou son nom affiché)",
    param: "name",
    build: (v) => `select name, display_name, status, start_type, pid from services where name = ${lit(v)} or display_name = ${lit(v)}`,
  },
  "port-owner": {
    description: "ce qui écoute sur un port (processus, nom seulement)",
    param: "port",
    build: (v) => `select l.port, l.protocol, l.address, l.pid, p.name from listening_ports l left join processes p using (pid) where l.port = ${Number(v)}`,
  },
  program: {
    description: "programmes installés dont le nom contient un texte",
    param: "name",
    build: (v) => `select name, version, publisher, install_date from programs where name like ${lit(`%${String(v)}%`)} order by name limit 100`,
  },
};

/** Un littéral SQL d'une valeur DÉJÀ validée (`NAME_RE` n'admet pas l'apostrophe ; le doublement reste par prudence). */
const lit = (v: string | number) => `'${String(v).replace(/'/g, "''")}'`;
const NAME_RE = /^[\p{L}\p{N} _.()-]{1,100}$/u;

/** Les tables qu'une requête libre ne peut pas lire : elles font des requêtes réseau (l'interrupteur Internet ne les verrait pas). */
const NETWORK_TABLES = /\bcurl(_certificate)?\b/i;

/** Valide une requête libre : une seule instruction, SELECT (ou WITH … SELECT), sans ATTACH ni PRAGMA ni table réseau. Rend le SQL ou lève. */
export function checkFreeSql(raw: unknown): string {
  const sql = typeof raw === "string" ? raw.trim().replace(/;\s*$/, "") : "";
  if (!sql) throw new AdapterRefused("G13", "sql est requis pour query=sql");
  if (sql.length > 4000) throw new AdapterRefused("G13", "requête trop longue (4000 caractères au plus)");
  if (sql.includes(";")) throw new AdapterRefused("G13", "une seule instruction");
  if (!/^(select|with)\b/i.test(sql)) throw new AdapterRefused("G13", "lecture seulement : SELECT ou WITH … SELECT");
  if (/\battach\b|\bpragma\b/i.test(sql)) throw new AdapterRefused("G13", "ATTACH et PRAGMA refusés");
  if (NETWORK_TABLES.test(sql)) throw new AdapterRefused("G13", "les tables curl et curl_certificate font des requêtes réseau : refusées (interrupteur Internet)");
  return sql;
}

/** Le SQL et la description d'une demande : prédéfinie, paramétrée ou libre. Lève si la demande ou sa valeur est invalide. */
export function osqueryRequest(query: string, args: Record<string, unknown> = {}): { sql: string; description: string } {
  if (Object.hasOwn(OSQUERY_PRESETS, query)) return { sql: OSQUERY_PRESETS[query]!.sql, description: OSQUERY_PRESETS[query]!.description };
  if (Object.hasOwn(OSQUERY_PARAMETRIZED, query)) {
    const d = OSQUERY_PARAMETRIZED[query]!;
    if (d.param === "port") {
      const port = args.port;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new AdapterRefused("G13", `${query} : port entier entre 1 et 65535 requis`);
      return { sql: d.build(port), description: `${d.description} : ${port}` };
    }
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!NAME_RE.test(name)) throw new AdapterRefused("G13", `${query} : name requis (lettres, chiffres, espace, . _ - ( ), 100 caractères au plus)`);
    return { sql: d.build(name), description: `${d.description} : ${name}` };
  }
  if (query === "sql") return { sql: checkFreeSql(args.sql), description: "requête libre (accordée par une règle de l'utilisateur)" };
  throw new AdapterRefused(
    "G13",
    `requête inconnue : ${query} (prédéfinies : ${Object.keys(OSQUERY_PRESETS).join(", ")} ; paramétrées : ${Object.keys(OSQUERY_PARAMETRIZED).join(", ")} ; libre : sql)`,
  );
}

export interface OsqueryResult {
  preset: string;
  description: string;
  rows: Record<string, string>[];
  rowCount: number;
  truncated: boolean;
  collectedAt: string;
  source: string;
  privileges: "utilisateur (non élevé)";
}

const MAX_ROWS = 500;
const ENV_KEEP = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "TEMP", "TMP"];

/** Où trouver `osqueryi` : JAROD_OSQUERYI, sinon JAROD_ENGINES_DIR\osquery\osqueryi.exe. */
export function osqueryBinary(env: Record<string, string | undefined> = process.env): string | null {
  const c = [env.JAROD_OSQUERYI, env.JAROD_ENGINES_DIR && join(env.JAROD_ENGINES_DIR, "osquery", "osqueryi.exe")].filter((x): x is string => Boolean(x));
  return c.find((p) => existsSync(p)) ?? null;
}

function exec(bin: string, args: string[], env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (e?.name === "AbortError") return reject(new AdapterRefused("G13", "diagnostic annulé"));
      if (e?.killed) return reject(new AdapterUnavailable("G13", "osquery n'a pas répondu dans le délai"));
      if (e && typeof e.code === "string") return reject(new AdapterUnavailable("G13", `lancement impossible (${e.code})`));
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function osqueryVersion(bin: string): Promise<string> {
  const { stdout } = await exec(bin, ["--version"], {}, 10_000);
  return /version\s+(\S+)/.exec(stdout)?.[1] ?? "inconnue";
}

export async function runOsqueryPreset(o: { bin: string; preset: string; args?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }): Promise<OsqueryResult> {
  const p = osqueryRequest(o.preset, o.args);
  const home = mkdtempSync(join(tmpdir(), "jarod-osquery-"));
  try {
    const env: Record<string, string> = {};
    for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    Object.assign(env, { USERPROFILE: home, HOME: home, LOCALAPPDATA: join(home, "local"), APPDATA: join(home, "roaming") });
    const args = ["--json", "--disable_extensions=true", "--disable_database=true", "--disable_logging=true", "--disable_events=true", "--disable_watchdog=true", p.sql];
    const [version, out] = await Promise.all([osqueryVersion(o.bin), exec(o.bin, args, env, o.timeoutMs ?? 30_000, o.signal)]);
    const err = out.stderr.split(/\r?\n/).find((l) => /^Error:/.test(l.trim()));
    if (err) throw new AdapterUnavailable("G13", `osquery a refusé la requête ${o.preset} : ${err.trim().slice(0, 300)}`);
    let rows: Record<string, string>[];
    try {
      rows = JSON.parse(out.stdout || "[]") as Record<string, string>[];
    } catch {
      throw new AdapterUnavailable("G13", "sortie d'osquery illisible (JSON attendu)");
    }
    return {
      preset: o.preset,
      description: p.description,
      rows: rows.slice(0, MAX_ROWS),
      rowCount: rows.length,
      truncated: rows.length > MAX_ROWS,
      collectedAt: new Date().toISOString(),
      source: `osquery ${version} (osqueryi, sans démon) — ${p.sql}`,
      privileges: "utilisateur (non élevé)",
    };
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** La forme d'un `ToolDef` de plugin-tools (sans en dépendre). */
export interface OsqueryToolDef {
  name: "system_diagnostics";
  operationOf(args: Record<string, unknown>): string | undefined;
  restrictedOperations: Readonly<Record<string, string>>;
  description: string;
  parameters: Record<string, unknown>;
  dangerous: false;
  audited: true;
  source: "builtin";
  run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null; signal?: AbortSignal }): Promise<string>;
}

const MAX_TEXT = 48_000;

/** Outil de l'agent : un diagnostic PRÉDÉFINI, en lecture seule ; chaque appel laisse sa ligne au journal d'audit. */
export function osqueryTool(bin: () => string | null): OsqueryToolDef {
  return {
    name: "system_diagnostics",
    description: `Diagnostic système Windows en lecture seule (osquery, sans démon, droits de l'utilisateur). Prédéfinis : ${Object.entries(OSQUERY_PRESETS)
      .map(([k, v]) => `${k} (${v.description})`)
      .join(" ; ")}. Paramétrés : ${Object.entries(OSQUERY_PARAMETRIZED)
      .map(([k, v]) => `${k} (${v.description} ; ${v.param})`)
      .join(" ; ")}. Requête libre : query=sql avec sql=« SELECT … » — opération réservée, refusée tant que l'utilisateur ne l'a pas accordée. Rend des lignes JSON horodatées avec leur provenance.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", enum: [...Object.keys(OSQUERY_PRESETS), ...Object.keys(OSQUERY_PARAMETRIZED), "sql"] },
        name: { type: "string", description: "Pour service-status et program." },
        port: { type: "integer", description: "Pour port-owner." },
        sql: { type: "string", description: "Pour query=sql : une instruction SELECT (opération réservée)." },
      },
      required: ["query"],
    },
    operationOf: (args) => (typeof args.query === "string" ? args.query : undefined),
    restrictedOperations: { sql: "une requête osquery libre peut lire les lignes de commande des processus, les comptes, des fichiers (en lecture seule)" },
    dangerous: false,
    audited: true,
    source: "builtin",
    async run(args, ctx) {
      const b = bin();
      if (!b) return "Indisponible : osqueryi introuvable — régler JAROD_OSQUERYI ou JAROD_ENGINES_DIR (voir engines.lock/README.md).";
      try {
        const r = await runOsqueryPreset({ bin: b, preset: String(args.query ?? ""), args, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        let body = JSON.stringify(r.rows);
        const cut = body.length > MAX_TEXT;
        if (cut) body = `${body.slice(0, MAX_TEXT)}…`;
        return [
          `${r.description} — ${r.rowCount} ligne(s)${r.truncated || cut ? " (tronqué)" : ""}`,
          `relevé : ${r.collectedAt} ; source : ${r.source} ; privilèges : ${r.privileges}`,
          body,
        ].join("\n");
      } catch (e) {
        return `Échec : ${(e as Error).message}`;
      }
    },
  };
}
