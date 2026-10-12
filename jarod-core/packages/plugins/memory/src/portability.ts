// Portage de packages/core/src/services/portability.ts (rév. 2e180305).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Settings } from "@jarod/contracts";
import type { SettingsService } from "@jarod/plugin-storage";
import type { MemoryService } from "./memory.js";

/** The format version of a bundle. Read strictly: a bundle from the future is refused, not guessed. */
export const BUNDLE_VERSION = 1;

export interface BundleManifest {
  version: number;
  at: number;
  profile: string;
  profiles: string[];
  counts: { memory: number; settings: number; personas: number };
  /**
   * Every path left out on the way out, named. A silent omission would be a lie by omission: the
   * reader has to be able to see that a token existed and did not travel.
   */
  redacted: string[];
}

export interface BundlePlan {
  profile: string;
  memory: number;
  profiles: string[];
  personas: string[];
  settingsKeys: string[];
  redacted: string[];
}

/** Un réglage qui change ce que le système EXÉCUTE : montré avec ses VALEURS, écrit seulement si l'utilisateur l'approuve. */
export interface ApprovalRequest {
  key: string;
  lines: string[];
}

export interface ImportInspection {
  manifest: BundleManifest;
  memory: { added: number; alreadyThere: number; examples: string[] };
  /** Les réglages qui seraient écrits (liste blanche), par leur nom. */
  settings: string[];
  /** Les réglages du paquet que l'import n'écrira JAMAIS (hors liste blanche), par leur nom. */
  ignored: string[];
  /** Les réglages qui ne s'écrivent que sur approbation nominative, avec ce qu'ils feraient. */
  approval: ApprovalRequest[];
}

export interface ImportResult {
  memory: { added: number; alreadyThere: number };
  settings: number;
  personas: number;
  ignored: string[];
  /** Les réglages à approbation effectivement écrits (l'utilisateur a dit oui). */
  approved: string[];
}

/**
 * What never leaves the machine, matched on the key's own name. Applied on both sides: on the way
 * out so a backup cannot carry a token, and on the way in so a hand-edited bundle cannot plant one.
 */
const SECRET_KEY = /(token|apikey|api_key|secret|password|passwd|credential)/i;

/**
 * Q19-5 — ce qu'un paquet a le droit d'écrire dans les réglages : une liste BLANCHE. Tout réglage qui n'y figure pas
 * (sensible, nouveau ou inconnu) est ignoré et NOMMÉ ; ajouter une clé ici est une décision de sécurité. Ce sont des
 * PRÉFÉRENCES : elles changent ce que l'utilisateur voit ou choisit, jamais ce que le système exécute, ni le garde
 * (`autoApproveTools`, `shellGuard`, `agentMode`, `disabled*`, `sessionBudget`…), ni le réseau (`providerOverrides`,
 * `rag`, `updates`, passerelles, `remote`, `mobile`, `webhooks`, `apiServer`…), ni le dossier de travail.
 */
export const IMPORTABLE_SETTINGS: readonly string[] = [
  "language",
  "theme",
  "activeProvider",
  "activeModel",
  "fallbacks",
  "thinking",
  "effort",
  "memoryInject",
  "autoTitle",
  "compactThreshold",
  "maxAgentSteps",
  "toolSearch",
  "browserVisible",
];

/** Réglages qui changent ce que le système EXÉCUTE : jamais écrits sans approbation nominative, valeurs affichées. */
export const APPROVAL_SETTINGS: readonly string[] = ["mcpServers"];

/** Sépare les réglages d'un paquet (déjà expurgés des secrets) : écrits, à approuver, ignorés. */
function classify(clean: Record<string, unknown>): { write: string[]; approval: string[]; ignored: string[] } {
  const out = { write: [] as string[], approval: [] as string[], ignored: [] as string[] };
  for (const key of Object.keys(clean).sort()) {
    if (IMPORTABLE_SETTINGS.includes(key)) out.write.push(key);
    else if (APPROVAL_SETTINGS.includes(key)) out.approval.push(key);
    else out.ignored.push(key);
  }
  return out;
}

const clip = (v: unknown, n = 300): string => (String(v).length > n ? `${String(v).slice(0, n)}…` : String(v));

/** Ce que chaque serveur MCP du paquet ferait : nom, commande ou URL, NOMS des variables (jamais leurs valeurs). */
function describeMcp(value: unknown): string[] {
  if (!Array.isArray(value)) return ["(valeur illisible : rien ne sera écrit)"];
  return value.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const where =
      typeof e.url === "string" && e.url
        ? `URL ${clip(e.url)}`
        : `commande ${clip([e.command, ...(Array.isArray(e.args) ? e.args : [])].map(String).join(" "))}`;
    const env = e.env && typeof e.env === "object" ? Object.keys(e.env) : [];
    return `${clip(e.name ?? "?", 80)} — ${where}${env.length ? ` (variables : ${env.map((k) => clip(k, 40)).join(", ")})` : ""}${e.enabled === false ? " [désactivé]" : ""}`;
  });
}

const strings = (v: unknown): v is Record<string, string> =>
  Boolean(v) && typeof v === "object" && Object.values(v as object).every((x) => typeof x === "string");

/** Fusionne les serveurs du paquet dans ceux qui existent : jamais de remplacement, un nom déjà pris est laissé tel quel. */
function mergeMcp(current: Settings["mcpServers"], incoming: unknown): Settings["mcpServers"] {
  const out = [...current];
  const names = new Set(out.map((s) => s.name));
  const ids = new Set(out.map((s) => s.id));
  if (!Array.isArray(incoming)) return out;
  for (const raw of incoming) {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name.trim() || names.has(e.name)) continue;
    const command = typeof e.command === "string" ? e.command : "";
    const url = typeof e.url === "string" ? e.url : "";
    if (!command && !url) continue; // ni commande ni URL : rien à lancer, rien à écrire
    const args = Array.isArray(e.args) && e.args.every((a) => typeof a === "string") ? (e.args as string[]) : [];
    const id = typeof e.id === "string" && e.id && !ids.has(e.id) ? e.id : randomUUID();
    ids.add(id);
    names.add(e.name);
    out.push({
      id,
      name: e.name,
      command,
      args,
      env: strings(e.env) ? e.env : {},
      enabled: e.enabled !== false,
      ...(url ? { url } : {}),
      ...(strings(e.headers) ? { headers: e.headers } : {}),
    });
  }
  return out;
}

/**
 * An installation, carried as plain files: profiles, memory, settings, and a persona file when one
 * exists. Two rules hold it together.
 *
 * First: a secret never travels. The `secrets` table is not read at all, and the settings are walked
 * so that a token buried in `telegram.token` or `mcp[].env.KEY` is dropped **and named** in the
 * manifest — an omission the reader can see.
 *
 * Second: an import merges. It adds what is missing and never deletes what is there, because the
 * one thing that cannot be undone is a restore that overwrote six weeks of memory with an older
 * copy. That is not a theory: it is the mistake this machine already made once.
 */
export class PortabilityService {
  constructor(
    private readonly d: {
      memory: MemoryService;
      settings: SettingsService;
      /** The profile's own folder: where a persona file would live, if one exists. */
      profileDir: () => string;
      /** Where a bundle goes by default: the app's own folder, never the working directory. */
      dir: () => string;
      /** The profile's name, when the caller knows it. The core wires one profile, not the list. */
      profile?: () => string;
    },
  ) {}

  /** What an export would contain, without writing anything. */
  plan(): BundlePlan {
    const settings = this.d.settings.getAll() as unknown as Record<string, unknown>;
    const { clean, redacted } = redactSecrets(settings);
    const name = this.profile();
    return {
      profile: name,
      profiles: [name],
      memory: this.d.memory.list().length,
      // Les noms, pas le compte : un plan se lit par un humain avant de dire oui.
      personas: this.personaFiles().map(([file]) => file),
      settingsKeys: Object.keys(clean).sort(),
      redacted,
    };
  }

  /** Writes the bundle and returns where it landed, with the manifest that describes it. */
  export(target?: string): { dir: string; manifest: BundleManifest } {
    const profile = this.profile();
    const settings = this.d.settings.getAll() as unknown as Record<string, unknown>;
    const { clean, redacted } = redactSecrets(settings);
    const memories = this.d.memory.list();
    const personas = this.personaFiles();

    const dir = target ?? this.freeDir();
    mkdirSync(join(dir, "personas"), { recursive: true });
    const manifest: BundleManifest = {
      version: BUNDLE_VERSION,
      at: Date.now(),
      profile,
      profiles: [profile],
      counts: { memory: memories.length, settings: Object.keys(clean).length, personas: personas.length },
      redacted,
    };
    writeJson(join(dir, "manifest.json"), manifest);
    writeJson(
      join(dir, "memory.json"),
      memories.map((entry) => ({ content: entry.content, type: entry.type })),
    );
    writeJson(join(dir, "settings.json"), clean);
    for (const [name, text] of personas) writeFileSync(join(dir, "personas", name), text, "utf8");
    return { dir, manifest };
  }

  /** Reads a bundle and says what applying it would change. It writes nothing — that is the point. */
  inspect(dir: string): ImportInspection {
    const manifest = this.readManifest(dir);
    const incoming = readJson<{ content: string; type: string }[]>(join(dir, "memory.json"), []);
    const known = new Set(this.d.memory.list().map((entry) => entry.content.trim()));
    const missing = incoming.filter((entry) => !known.has(String(entry.content).trim()));
    const { clean } = redactSecrets(readJson<Record<string, unknown>>(join(dir, "settings.json"), {}));
    const kinds = classify(clean);
    return {
      manifest,
      memory: {
        added: missing.length,
        alreadyThere: incoming.length - missing.length,
        examples: missing.slice(0, 5).map((entry) => String(entry.content)),
      },
      settings: kinds.write,
      ignored: kinds.ignored,
      approval: kinds.approval.map((key) => ({ key, lines: key === "mcpServers" ? describeMcp(clean[key]) : [clip(JSON.stringify(clean[key]))] })),
    };
  }

  /**
   * Applies a bundle: memory is merged by content, personas land only when absent, and settings obey the
   * Q19-5 rules — only the whitelisted preferences are written (`IMPORTABLE_SETTINGS`), secrets are dropped even if
   * the file carries them, what changes what the system runs (`APPROVAL_SETTINGS`) is written only when the caller
   * names it in `approve` (after the user saw its values) and then MERGED, everything else is ignored and named.
   */
  apply(dir: string, opts: { onlySettings?: boolean; approve?: readonly string[] } = {}): ImportResult {
    this.readManifest(dir);
    const before = this.d.memory.list();
    const known = new Set(before.map((entry) => entry.content.trim()));
    let added = 0;
    let alreadyThere = 0;

    if (!opts.onlySettings) {
      const incoming = readJson<{ content: string; type?: string }[]>(join(dir, "memory.json"), []);
      for (const entry of incoming) {
        const content = String(entry.content ?? "").trim();
        if (!content) continue;
        if (known.has(content)) {
          alreadyThere += 1;
          continue;
        }
        this.d.memory.add(content, (entry.type ?? "fact") as never);
        known.add(content);
        added += 1;
      }
    }

    const settings = readJson<Record<string, unknown>>(join(dir, "settings.json"), {});
    const { clean } = redactSecrets(settings);
    const kinds = classify(clean);
    for (const key of kinds.write) this.d.settings.set(key as never, clean[key] as never);
    const approved = kinds.approval.filter((key) => opts.approve?.includes(key));
    for (const key of approved) {
      if (key === "mcpServers") this.d.settings.set("mcpServers", mergeMcp(this.d.settings.get("mcpServers"), clean[key]));
    }

    let personas = 0;
    const source = join(dir, "personas");
    if (existsSync(source)) {
      const profileDir = this.d.profileDir();
      mkdirSync(profileDir, { recursive: true });
      for (const name of readdirSync(source)) {
        const target = join(profileDir, name);
        // Un fichier existant n'est jamais écrasé par un import : on ajoute, on ne remplace pas.
        if (existsSync(target)) continue;
        writeFileSync(target, readFileSync(join(source, name)));
        personas += 1;
      }
    }

    return { memory: { added, alreadyThere }, settings: kinds.write.length + approved.length, personas, ignored: [...kinds.ignored, ...kinds.approval.filter((k) => !approved.includes(k))], approved };
  }

  private readManifest(dir: string): BundleManifest {
    const manifest = readJson<BundleManifest | null>(join(dir, "manifest.json"), null);
    if (!manifest) throw new Error(`BUNDLE_UNREADABLE: aucun manifeste lisible dans ${dir}`);
    if (Number(manifest.version) > BUNDLE_VERSION) {
      throw new Error(
        `BUNDLE_TOO_RECENT: ce paquet est en version ${manifest.version}, cette application lit la ${BUNDLE_VERSION}`,
      );
    }
    return manifest;
  }

  /** A persona is any markdown file the profile folder carries, so the day one exists it travels. */
  private personaFiles(): [string, string][] {
    const dir = this.d.profileDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .map((name) => [name, readFileSync(join(dir, name), "utf8")] as [string, string]);
  }

  private profile(): string {
    return this.d.profile?.() ?? "default";
  }

  /** `exports/2026-09-24T20-42` — a new folder each time, never over an existing bundle. */
  private freeDir(): string {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const base = join(this.d.dir(), stamp);
    let candidate = base;
    let n = 2;
    while (existsSync(candidate)) candidate = `${base}-${n++}`;
    return candidate;
  }
}

/**
 * Walks an object and drops every key whose name looks like a secret, naming the paths removed.
 * The paths are returned rather than logged so the manifest can state them.
 */
export function redactSecrets(value: unknown, path = ""): { clean: Record<string, unknown>; redacted: string[] } {
  const redacted: string[] = [];
  const walk = (node: unknown, at: string): unknown => {
    if (Array.isArray(node)) return node.map((entry, index) => walk(entry, `${at}[${index}]`));
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const here = at ? `${at}.${key}` : key;
        if (SECRET_KEY.test(key)) {
          redacted.push(here);
          continue;
        }
        // defineProperty : une clé `__proto__` du paquet devient une clé comme une autre (nommée, ignorée), pas un prototype.
        Object.defineProperty(out, key, { value: walk(child, here), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return node;
  };
  const clean = walk(value, path) as Record<string, unknown>;
  return { clean: clean ?? {}, redacted };
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
