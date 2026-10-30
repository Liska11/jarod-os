// Lot 4 (30/10) : météo, agenda, débit Internet, rangement de dossier, briefing — capacités de brahma-ai-evo (weather_report,
// device_location, calendar_scheduler, internet_speed_test, desktop_organizer_mcp, daily_briefing) réécrites pour Jarod.
// Météo : Open-Meteo (sans clé ni compte) ; position : la ville donnée, sinon celle de l'adresse IP (geojs.io). Rien d'autre ne sort.
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statfsSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { activePolicy } from "@jarod/kernel/network";
import type { Db } from "@jarod/plugin-storage";
import type { ToolDef } from "./registry.js";
import { protectedRoot, protectedRoots, realPathOrSelf } from "./system/disk.js";

const json = (v: unknown) => JSON.stringify(v);
type Fetch = typeof fetch;

// ── Météo ────────────────────────────────────────────────────────────────────────────────────────────────

/** Les codes météo de l'OMM qu'Open-Meteo rend, en mots. */
export const WEATHER_CODES: Record<number, string> = {
  0: "ciel dégagé", 1: "plutôt dégagé", 2: "partiellement nuageux", 3: "couvert", 45: "brouillard", 48: "brouillard givrant",
  51: "bruine légère", 53: "bruine", 55: "bruine forte", 56: "bruine verglaçante", 57: "bruine verglaçante forte",
  61: "pluie faible", 63: "pluie", 65: "forte pluie", 66: "pluie verglaçante", 67: "forte pluie verglaçante",
  71: "neige faible", 73: "neige", 75: "forte neige", 77: "grains de neige", 80: "averses", 81: "averses", 82: "violentes averses",
  85: "averses de neige", 86: "fortes averses de neige", 95: "orage", 96: "orage avec grêle", 99: "violent orage avec grêle",
};

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
  source: "ville" | "adresse IP";
}

async function getJson(fetchFn: Fetch, url: string): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Jarod-OS" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} pour ${new URL(url).host}`);
  return (await res.json()) as Record<string, unknown>;
}

/** La ville demandée (géocodage Open-Meteo), sinon la position approximative de l'adresse IP. */
export async function locate(fetchFn: Fetch, city?: string): Promise<Place> {
  if (city && city.trim()) {
    const r = await getJson(fetchFn, `https://geocoding-api.open-meteo.com/v1/search?count=1&language=fr&name=${encodeURIComponent(city.trim())}`);
    const hit = (r.results as { name: string; latitude: number; longitude: number; country?: string }[] | undefined)?.[0];
    if (!hit) throw new Error(`Ville introuvable : ${city}`);
    return { name: hit.country ? `${hit.name} (${hit.country})` : hit.name, latitude: hit.latitude, longitude: hit.longitude, source: "ville" };
  }
  const r = await getJson(fetchFn, "https://get.geojs.io/v1/ip/geo.json");
  const lat = Number(r.latitude);
  const lon = Number(r.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Position introuvable : donnez une ville.");
  return { name: String(r.city ?? r.region ?? "position approximative"), latitude: lat, longitude: lon, source: "adresse IP" };
}

export async function weatherFor(fetchFn: Fetch, city?: string, days = 3) {
  const place = await locate(fetchFn, city);
  const n = Math.min(7, Math.max(1, Math.round(days)));
  const r = await getJson(
    fetchFn,
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&timezone=auto&forecast_days=${n}` +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
  );
  const c = (r.current ?? {}) as Record<string, number>;
  const d = (r.daily ?? {}) as Record<string, (number | string)[]>;
  const label = (code: unknown) => WEATHER_CODES[Number(code)] ?? `code ${String(code)}`;
  return {
    place: place.name,
    located_by: place.source,
    now: { temperature: c.temperature_2m, feels_like: c.apparent_temperature, humidity: c.relative_humidity_2m, wind_kmh: c.wind_speed_10m, sky: label(c.weather_code) },
    days: (d.time ?? []).map((day, i) => ({ day, sky: label(d.weather_code?.[i]), min: d.temperature_2m_min?.[i], max: d.temperature_2m_max?.[i], rain_chance: d.precipitation_probability_max?.[i] })),
    source: "Open-Meteo",
  };
}

// ── Débit Internet ───────────────────────────────────────────────────────────────────────────────────────

export async function speedTest(fetchFn: Fetch, signal?: AbortSignal) {
  const base = "https://speed.cloudflare.com";
  const pings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const r = await fetchFn(`${base}/__down?bytes=0`, { signal: signal ?? AbortSignal.timeout(10_000) });
    await r.arrayBuffer();
    pings.push(performance.now() - t0);
  }
  const down = 25_000_000;
  let t0 = performance.now();
  const dr = await fetchFn(`${base}/__down?bytes=${down}`, { signal: signal ?? AbortSignal.timeout(60_000) });
  const got = (await dr.arrayBuffer()).byteLength;
  const downS = (performance.now() - t0) / 1000;
  const up = 5_000_000;
  t0 = performance.now();
  const ur = await fetchFn(`${base}/__up`, { method: "POST", body: new Uint8Array(up), signal: signal ?? AbortSignal.timeout(60_000) });
  await ur.arrayBuffer();
  const upS = (performance.now() - t0) / 1000;
  const mbps = (bytes: number, s: number) => Math.round(((bytes * 8) / s / 1e6) * 10) / 10;
  return { latency_ms: Math.round(Math.min(...pings)), download_mbps: mbps(got, downS), upload_mbps: mbps(up, upS), server: "Cloudflare (speed.cloudflare.com)" };
}

// ── Agenda ───────────────────────────────────────────────────────────────────────────────────────────────

export interface AgendaEvent {
  id: string;
  title: string;
  start: number;
  end: number | null;
  place: string;
  note: string;
}

export class Agenda {
  private ready = false;

  constructor(private readonly db: Db) {}

  private table(): void {
    if (this.ready) return;
    // Créée à la première utilisation, dans la base chiffrée du profil (rejouable).
    this.db.exec(`CREATE TABLE IF NOT EXISTS agenda_events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, start INTEGER NOT NULL, end_at INTEGER, place TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS agenda_events_start ON agenda_events(start);`);
    this.ready = true;
  }

  add(e: Omit<AgendaEvent, "id">): AgendaEvent {
    this.table();
    const id = `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.db.run("INSERT INTO agenda_events (id, title, start, end_at, place, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, e.title, e.start, e.end, e.place, e.note, Date.now());
    return { id, ...e };
  }

  between(from: number, to: number): AgendaEvent[] {
    this.table();
    return this.db
      .all<{ id: string; title: string; start: number; end_at: number | null; place: string; note: string }>("SELECT * FROM agenda_events WHERE start >= ? AND start < ? ORDER BY start", from, to)
      .map((r) => ({ id: r.id, title: r.title, start: r.start, end: r.end_at, place: r.place, note: r.note }));
  }

  remove(id: string): boolean {
    this.table();
    return this.db.run("DELETE FROM agenda_events WHERE id = ?", id).changes > 0;
  }
}

/** Une date donnée par le modèle (ISO, « 2026-11-02 14:30 ») ; une date illisible est une erreur, jamais « maintenant » en silence. */
export function parseWhen(v: unknown, key: string): number {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${key} est requis (date et heure, ex. 2026-11-02 14:30)`);
  const t = Date.parse(v.trim().replace(" ", "T"));
  if (!Number.isFinite(t)) throw new Error(`${key} illisible : ${v} (format attendu : 2026-11-02 14:30)`);
  return t;
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const fmt = (ms: number) => new Date(ms).toLocaleString("fr-FR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

// ── Rangement d'un dossier ──────────────────────────────────────────────────────────────────────────────

export const CATEGORIES: Record<string, string[]> = {
  Images: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".svg", ".tif", ".tiff", ".raw"],
  Vidéos: [".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".m4v"],
  Musique: [".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac", ".wma"],
  PDF: [".pdf"],
  Documents: [".doc", ".docx", ".odt", ".rtf", ".txt", ".md", ".epub"],
  Tableurs: [".xls", ".xlsx", ".ods", ".csv"],
  Présentations: [".ppt", ".pptx", ".odp"],
  Archives: [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"],
  Installateurs: [".exe", ".msi", ".msix", ".appx"],
  Code: [".js", ".ts", ".py", ".java", ".c", ".cpp", ".cs", ".go", ".rs", ".json", ".html", ".css", ".sh", ".ps1", ".bat"],
};

export function categoryOf(file: string): string {
  const ext = extname(file).toLowerCase();
  for (const [cat, exts] of Object.entries(CATEGORIES)) if (exts.includes(ext)) return cat;
  return "Autres";
}

async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Le plan de rangement (rien n'est déplacé ici) : chaque fichier vers le sous-dossier de sa catégorie, plus les doublons exacts. */
export async function organizePlan(folder: string, roots: readonly string[]) {
  if (!isAbsolute(folder)) throw new Error("folder doit être un chemin absolu");
  const hit = protectedRoot(folder, roots) ?? protectedRoot(realPathOrSelf(folder), roots);
  if (hit) throw new Error(`${folder} est dans l'emplacement protégé ${hit}`);
  const entries = readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile());
  const operations: { op: "move"; path: string; to: string }[] = [];
  const skipped: string[] = [];
  const bySize = new Map<number, { path: string; mtime: number }[]>();
  const count: Record<string, number> = {};
  for (const e of entries) {
    const path = join(folder, e.name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const cat = categoryOf(e.name);
    count[cat] = (count[cat] ?? 0) + 1;
    const to = join(folder, cat, e.name);
    try {
      statSync(to);
      skipped.push(`${e.name} : existe déjà dans ${cat}`);
    } catch {
      operations.push({ op: "move", path, to });
    }
    if (st.size > 0 && st.size <= 500 * 1024 * 1024) {
      const list = bySize.get(st.size) ?? [];
      list.push({ path, mtime: st.mtimeMs });
      bySize.set(st.size, list);
    }
  }
  const duplicates: { keep: string; copies: string[] }[] = [];
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const byHash = new Map<string, { path: string; mtime: number }[]>();
    for (const f of group) {
      const h = await sha256(f.path).catch(() => "");
      if (!h) continue;
      byHash.set(h, [...(byHash.get(h) ?? []), f]);
    }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      same.sort((a, b) => a.mtime - b.mtime);
      duplicates.push({ keep: same[0]!.path, copies: same.slice(1).map((f) => f.path) });
    }
  }
  return { folder, files: entries.length, by_category: count, operations, skipped, duplicates };
}

// ── Outils ───────────────────────────────────────────────────────────────────────────────────────────────

export function dailyTools(deps: { db: Db; fetch?: Fetch; env?: NodeJS.ProcessEnv }): ToolDef[] {
  const fetchFn = deps.fetch ?? fetch;
  const agenda = new Agenda(deps.db);
  const roots = () => protectedRoots(deps.env ?? process.env);

  const weather: ToolDef = {
    name: "weather",
    description: "Météo actuelle et prévisions (1 à 7 jours) : city (ville) ou, sans ville, la position approximative de l'adresse IP. Source Open-Meteo, sans clé.",
    parameters: { type: "object", properties: { city: { type: "string" }, days: { type: "integer", description: "1 à 7 (3 par défaut)." } } },
    dangerous: false,
    source: "builtin",
    async run(args) {
      return json(await weatherFor(fetchFn, typeof args.city === "string" ? args.city : undefined, typeof args.days === "number" ? args.days : 3));
    },
  };

  const speed: ToolDef = {
    name: "internet_speed",
    description: "Mesure la connexion Internet : latence, débit descendant et montant (serveurs Cloudflare ; ~30 Mo échangés, ~20 s).",
    parameters: { type: "object", properties: {} },
    dangerous: false,
    audited: true,
    source: "builtin",
    async run(_args, ctx) {
      return json(await speedTest(fetchFn, ctx.signal));
    },
  };

  const agendaTool: ToolDef = {
    name: "agenda",
    description:
      "L'agenda local de l'utilisateur (gardé dans la base chiffrée de Jarod). action=add : title, start (2026-11-02 14:30), end, place, note ; action=list : les événements à venir (days, 7 par défaut ; from pour une autre date) ; action=delete : id. Pour un rappel à heure fixe, créer aussi un cronjob.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "delete"] },
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        place: { type: "string" },
        note: { type: "string" },
        from: { type: "string" },
        days: { type: "integer" },
        id: { type: "string" },
      },
      required: ["action"],
    },
    dangerous: false,
    source: "builtin",
    async run(args) {
      if (args.action === "add") {
        if (typeof args.title !== "string" || !args.title.trim()) throw new Error("title est requis");
        const start = parseWhen(args.start, "start");
        const end = args.end ? parseWhen(args.end, "end") : null;
        if (end !== null && end < start) throw new Error("end est avant start");
        const e = agenda.add({ title: args.title.trim().slice(0, 200), start, end, place: String(args.place ?? "").slice(0, 200), note: String(args.note ?? "").slice(0, 1000) });
        return `Ajouté à l'agenda : ${e.title} — ${fmt(e.start)} (id ${e.id})`;
      }
      if (args.action === "list") {
        const from = args.from ? startOfDay(parseWhen(args.from, "from")) : Date.now() - 60 * 60_000;
        const days = typeof args.days === "number" ? Math.min(366, Math.max(1, args.days)) : 7;
        const list = agenda.between(from, from + days * 86_400_000);
        return list.length ? list.map((e) => `- ${fmt(e.start)} : ${e.title}${e.place ? ` (${e.place})` : ""} [${e.id}]`).join("\n") : "Rien à l'agenda sur cette période.";
      }
      if (args.action === "delete") return agenda.remove(String(args.id ?? "")) ? "Événement supprimé." : "Aucun événement avec cet id.";
      throw new Error("action doit être add, list ou delete");
    },
  };

  const organize: ToolDef = {
    name: "folder_organize_plan",
    description:
      "Prépare le RANGEMENT d'un dossier (Téléchargements, Bureau…) sans rien déplacer : chaque fichier vers un sous-dossier de sa catégorie (Images, Vidéos, Musique, PDF, Documents, Tableurs, Présentations, Archives, Installateurs, Code, Autres), et la liste des doublons exacts (même contenu). Montrer le plan à l'utilisateur, puis l'appliquer avec system_files action=batch (operations), et mettre les doublons à la corbeille seulement s'il le demande.",
    parameters: { type: "object", properties: { folder: { type: "string", description: "Chemin absolu du dossier." } }, required: ["folder"] },
    dangerous: false,
    audited: true,
    source: "builtin",
    async run(args) {
      return json(await organizePlan(String(args.folder ?? ""), roots()));
    },
  };

  const briefing: ToolDef = {
    name: "briefing",
    description:
      "Le point du jour en un appel (idée du « daily briefing ») : date, agenda d'aujourd'hui et de demain, météo (si Internet est permis), espace libre sur les disques. À utiliser pour « fais-moi le point », « qu'est-ce que j'ai aujourd'hui ? », ou dans une automatisation du matin.",
    parameters: { type: "object", properties: { city: { type: "string" } } },
    dangerous: false,
    source: "builtin",
    async run(args) {
      const today = startOfDay(Date.now());
      const events = agenda.between(today, today + 2 * 86_400_000).map((e) => ({ when: fmt(e.start), title: e.title, place: e.place || undefined }));
      let meteo: unknown = "Internet désactivé : pas de météo.";
      if (activePolicy().internet) {
        try {
          const w = await weatherFor(fetchFn, typeof args.city === "string" ? args.city : undefined, 2);
          meteo = { place: w.place, now: w.now, today: w.days[0], tomorrow: w.days[1] };
        } catch (e) {
          meteo = `météo indisponible : ${(e as Error).message}`;
        }
      }
      const disks: { drive: string; free_gb: number }[] = [];
      if (process.platform === "win32") {
        for (const letter of "CDEFGH") {
          try {
            const s = statfsSync(`${letter}:\\`);
            disks.push({ drive: `${letter}:`, free_gb: Math.round((s.bavail * s.bsize) / 1e9) });
          } catch {
            // Lecteur absent.
          }
        }
      }
      return json({ date: new Date().toLocaleDateString("fr-FR", { dateStyle: "full" }), agenda: events.length ? events : "rien aujourd'hui ni demain", weather: meteo, disks });
    },
  };

  return [weather, speed, agendaTool, organize, briefing];
}

