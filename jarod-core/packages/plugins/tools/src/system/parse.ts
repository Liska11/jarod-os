// Outils système (phase 1, lecture seule) : les analyseurs PURS, des sorties des scripts vers le contrat JSON des outils. Repris de
// `parse_*` de `windows.py` (Herald OS, MIT) ; testés avec des données d'essai sur toute plateforme.
import { asList } from "./ps.js";

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export const BATTERY_STATES: Record<number, string> = {
  1: "discharging", 2: "on AC power", 3: "charged", 4: "low", 5: "critical", 6: "charging", 7: "charging", 8: "charging", 9: "charging", 11: "partially charged",
};

/** Les codes d'exception les plus courants d'un plantage (événement 1000). */
export const EXCEPTION_NAMES: Record<string, string> = {
  "0xc0000005": "access violation (the program touched memory it did not own)",
  "0xc0000409": "stack buffer overrun or fail-fast (the program stopped itself after detecting corruption)",
  "0x80000003": "breakpoint (a deliberate trap or a debugger break)",
  "0xc00000fd": "stack overflow",
  "0xc0000374": "heap corruption",
  "0xc0000094": "integer division by zero",
  "0xc000001d": "illegal instruction",
  "0xe0434352": ".NET unhandled exception",
  "0xe06d7363": "C++ exception that was not caught",
  "0xc0000135": "a required DLL was not found",
  "0xc0000142": "a DLL failed to initialise",
  "0xc000007b": "invalid image format (a 32-bit and 64-bit mix-up)",
  "0xc0000006": "in-page I/O error (a file the program had mapped went away)",
  "0x40000015": "fatal application exit",
};

/** Sortie de `SYSTEM_INFO` → la charge utile de `system_info` (le reste vient de `node:os`, ajouté par l'outil). */
export function parseSystemInfo(data: Row): Row {
  const total = num(data.total_kb) * 1024;
  const free = num(data.free_kb) * 1024;
  const disks = asList(data.disks)
    .map((d) => ({ mount: str(d.mount), size: num(d.total_bytes), left: num(d.free_bytes) }))
    .filter((d) => d.size > 0)
    .map((d) => ({ mount: d.mount, total_bytes: d.size, used_bytes: Math.max(0, d.size - d.left), free_bytes: d.left }));
  const rawBattery = data.battery as Row | null | undefined;
  const battery = rawBattery && rawBattery.percent !== null && rawBattery.percent !== undefined
    ? { percent: num(rawBattery.percent), state: BATTERY_STATES[num(rawBattery.status)] ?? "unknown" }
    : null;
  const caption = str(data.caption || "Windows").replace(/^Microsoft\s+/, "").trim();
  const version = str(data.version);
  return {
    os: version ? `${caption} (${version})` : caption,
    build: str(data.build),
    chip: str(data.chip).replace(/\s+/g, " ").trim() || null,
    cpu_cores: num(data.logical),
    memory_total_bytes: total,
    memory_used_bytes: Math.max(0, total - free),
    load_average: null, // Windows n'a pas de moyenne de charge.
    uptime_seconds: data.uptime_seconds === null || data.uptime_seconds === undefined ? null : num(data.uptime_seconds),
    disks,
    battery,
  };
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  user: string;
  name: string;
  cpu_percent: number;
  mem_percent: number;
  rss_bytes: number;
  command: string;
}

/** Sortie de `PROCESSES` → lignes. Le CPU du script est la somme sur les cœurs : on le ramène à 0-100 de la machine. */
export function buildProcessRows(data: Row, logicalCpus: number): ProcessRow[] {
  const total = num(data.total_memory);
  const cores = Math.max(1, logicalCpus);
  return asList(data.rows).map((r) => {
    const rss = num(r.rss);
    const name = str(r.name);
    return {
      pid: num(r.pid),
      ppid: num(r.ppid),
      user: str(r.user),
      name,
      cpu_percent: Math.round(Math.min(100, num(r.cpu) / cores) * 10) / 10,
      mem_percent: total ? Math.round((rss / total) * 1000) / 10 : 0,
      rss_bytes: rss,
      command: str(r.path) || name,
    };
  });
}

export function parseListeners(data: unknown, port: number): Row[] {
  return asList(data)
    .filter((r) => r.pid !== null && r.pid !== undefined)
    .map((r) => ({ pid: num(r.pid), command: str(r.name), user: str(r.user), port, protocol: str(r.protocol) || "tcp" }));
}

export interface AppInfo {
  name: string;
  path: string;
  bundle_id: string | null;
  running: boolean;
  pid: number | null;
}

/** Lignes de `Get-StartApps` → applications ; un programme a souvent plusieurs entrées, la première de chaque nom est gardée. */
export function parseStartApps(data: unknown): AppInfo[] {
  const apps = new Map<string, AppInfo>();
  for (const r of asList(data)) {
    const name = str(r.name).trim();
    const id = str(r.id).trim();
    if (name && id && !apps.has(name.toLowerCase())) apps.set(name.toLowerCase(), { name, path: `shell:AppsFolder\\${id}`, bundle_id: id, running: false, pid: null });
  }
  return [...apps.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export function parseRunningApps(data: unknown): AppInfo[] {
  return asList(data)
    .filter((r) => r.pid !== null && r.pid !== undefined && (r.description || r.process))
    .map((r) => ({ name: str(r.description || r.process).trim(), path: str(r.path), bundle_id: null, running: true, pid: num(r.pid) }));
}

/**
 * `netsh wlan show interfaces` → le résumé de la liaison, ou `null`. Les libellés sont traduits : seuls ceux qui se lisent pareil
 * partout (SSID, Signal) sont exigés ; l'ordre des lignes, lui, ne l'est pas, et sert de repli pour un libellé inconnu.
 */
export function parseWlan(text: string): Row | null {
  const ssid = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(text);
  if (!ssid) return null;
  const field = (...labels: string[]): string | null => {
    const m = new RegExp(`^\\s*(?:${labels.join("|")})[^:\\n]*:\\s*(.+?)\\s*$`, "im").exec(text);
    return m?.[1] ?? null;
  };
  const rows = text.split(/\r?\n/).filter((l) => l.includes(":")).map((l) => {
    const i = l.indexOf(":");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as const;
  });
  let start = rows.findIndex(([label]) => label.toUpperCase() === "SSID");
  if (start < 0) start = rows.length;
  const after = rows.slice(start + 1);
  const numbers = after.map(([, v]) => v).filter((v) => /^\d+(?:[.,]\d+)?$/.test(v));
  const signal = /^\s*(?:Signal|Señal)\s*:\s*(\d+)\s*%/im.exec(text) ?? /:\s*(\d+)\s*%\s*$/m.exec(text);
  const channel = field("Channel", "Canal") ?? numbers[0] ?? null;
  const rateRaw = field("Receive rate", "Vitesse de réception") ?? numbers[1] ?? null;
  const rate = rateRaw ? rateRaw.replace(",", ".") : rateRaw;
  return {
    interface: field("Name", "Nom", "Nombre"),
    connected: true,
    ssid: ssid[1],
    phy_mode: field("Radio type", "Type de radio") ?? after[2]?.[1] ?? null,
    channel: channel && /^\d+$/.test(channel) ? Number(channel) : null,
    rate_mbps: rate && /^[\d.]+$/.test(rate) ? Number(rate) : null,
    signal_percent: signal?.[1] ? Number(signal[1]) : null,
    security: field("Authentication", "Authentification") ?? after[3]?.[1] ?? null,
  };
}

export function parseNetwork(data: Row): Row {
  const config = asList(data.config);
  const adapters = new Map(asList(data.adapters).map((a) => [str(a.name), a]));
  const def = config.find((c) => c.gateway) ?? null;
  const interfaces = config
    .filter((c) => str(c.ipv4) && !str(c.ipv4).startsWith("169.254."))
    .map((c) => ({
      name: str(c.description) || str(c.name),
      device: str(c.name),
      mac: str(adapters.get(str(c.name))?.mac) || null,
      ipv4: str(c.ipv4),
      default_route: c === def,
    }));
  return {
    online: def !== null,
    default_interface: def ? str(def.name) : null,
    gateway: def ? str(def.gateway) : null,
    // `ConvertTo-Json` écrit une chaîne seule là où il y a une seule adresse.
    dns: def ? (Array.isArray(def.dns) ? def.dns : def.dns ? [def.dns] : []).map(str).slice(0, 6) : [],
    interfaces,
    wifi: parseWlan(str(data.wlan)),
    note: null,
  };
}

export function parseBluetooth(devices: unknown): Row {
  const rows = asList(devices);
  const paired = [...new Set(rows.filter((d) => d.name && /^BTH(?:ENUM|LE)\\DEV_/i.test(str(d.id))).map((d) => str(d.name)))].sort();
  const radios = rows.filter((d) => d.name && !/^BTH/i.test(str(d.id)) && d.present);
  return {
    powered_on: radios.length > 0 ? radios.some((r) => str(r.status) === "OK") : null,
    connected: [],
    paired,
    note: paired.length > 0 ? "Windows does not tell which paired device is connected right now." : null,
  };
}

const LEVEL_NAMES: Record<number, string> = { 1: "CRITICAL", 2: "ERROR", 3: "WARNING", 4: "INFO", 5: "VERBOSE" };
export const LOG_LEVELS: Record<string, number[]> = { error: [1, 2], fault: [1], any: [] };

/** Lignes d'événements (les plus récentes d'abord) → lignes `heure NIVEAU source : message`, chronologiques, les `limit` dernières. */
export function formatLogLines(rows: unknown, limit: number): string[] {
  const lines = asList(rows).map((r) => `${str(r.time)} ${LEVEL_NAMES[num(r.level) || 4] ?? "INFO"} ${str(r.provider)}: ${str(r.message)}`.trimEnd());
  lines.reverse();
  return lines.slice(-limit);
}

export function normaliseExceptionCode(value: unknown): string | null {
  const text = str(value).trim().toLowerCase();
  if (!text) return null;
  return /^(?:0x)?[0-9a-f]+$/.test(text) ? `0x${text.replace(/^0x/, "").padStart(8, "0")}` : text;
}

export function summariseCrash(row: Row): Row {
  const code = normaliseExceptionCode(row.code);
  return {
    report: str(row.record),
    app: row.app ?? null,
    version: row.version ?? null,
    time: row.time ?? null,
    exception: { code, meaning: EXCEPTION_NAMES[code ?? ""] ?? null },
    faulting_module: row.module ?? null,
    module_version: row.module_version ?? null,
    fault_offset: row.offset ?? null,
    process_id: /^\d+$/.test(str(row.pid)) ? Number(row.pid) : null,
    app_path: row.app_path ?? null,
    module_path: row.module_path ?? null,
    message: str(row.message).slice(0, 4000),
  };
}
