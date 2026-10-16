// Portage de packages/core/src/services/skills.ts (rév. 2e180305).
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NotificationService } from "@jarod/plugin-storage";
import type { SettingsService } from "@jarod/plugin-storage";

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  path: string;
  body: string;
  /** `agent` when the agent wrote it with `skill_manage`; absent for the user's own skills. */
  author?: string;
  /** The folder path above the skill (`mlops/inference`); absent for a flat skill. */
  category?: string;
}

/** Two skill folders with the same leaf name: one is loaded, the others are reported, never merged. */
export interface SkillCollision {
  id: string;
  /** Loaded folder, relative POSIX path under the skills root. */
  kept: string;
  /** Folders not loaded, same form. */
  ignored: string[];
}

interface ManifestEntry {
  mtimeMs: number;
  size: number;
  meta: Record<string, string>;
  body: string;
}

/** A discovered skill folder: `rel` is its relative POSIX path under the root. */
interface Found {
  id: string;
  rel: string;
  path: string;
}

const MANIFEST_KEYS = ["name", "description", "version", "author"] as const;

/** Where archived skills go: a dot folder, so `reload()` never lists them. */
export const SKILL_ARCHIVE_DIR = ".archive";
/**
 * Read cache of the `SKILL.md` files (Q2), at the root of the skills folder. Never an authority: the
 * folders are walked on every `reload()`; an entry only spares re-reading an unchanged `SKILL.md`.
 */
export const SKILL_MANIFEST_FILE = ".manifest.json";
export const MAX_SKILL_BODY = 20_000;
/** Deepest skill folder under the root (1 = flat `<id>/`; Hermes goes to 3: `mlops/inference/<id>/`). */
const MAX_SKILL_DEPTH = 6;
const MANIFEST_VERSION = 1;
/**
 * A `SKILL.md` modified less than this before it was read is not cached ("racy" entry, as in git):
 * a same-size rewrite within the file system's mtime granularity would otherwise go unnoticed.
 */
const RACY_MS = 2_000;
const MAX_SKILL_NAME = 80;
const MAX_SKILL_DESCRIPTION = 300;

/** Frontmatter values are flat single lines: a newline would let a value forge another key. */
const oneLine = (value: string, max: number): string => value.replace(/\s+/g, " ").trim().slice(0, max);

export const skillId = (raw: string): string =>
  raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");

/** Bumps the last number of a `x.y.z` version (anything else restarts at 1.0.1). */
export function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "1.0.1";
}

function skillText(meta: Record<string, string>, body: string): string {
  const head = Object.entries(meta)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${head}\n---\n${body.trim()}\n`;
}

/**
 * Parses a `---`-delimited YAML-ish frontmatter: flat `key: value` pairs, plus the folded (`>`) and
 * literal (`|`) block scalars that Agent Skills from the hub use for long descriptions. Indented
 * lines under any other key (nested maps, lists) are skipped.
 */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const value = kv[2]!.trim();
    const block = /^([>|])[-+]?$/.exec(value);
    if (!block) {
      meta[kv[1]!] = value.replace(/^["']|["']$/g, "");
      continue;
    }
    const parts: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) {
      parts.push(lines[++i]!.trim());
    }
    meta[kv[1]!] = (block[1] === ">" ? parts.join(" ").replace(/\s+/g, " ") : parts.join("\n")).trim();
  }
  return { meta, body: m[2]!.trim() };
}

const EXAMPLE_SKILLS: Record<string, string> = {
  "resume-document": `---
name: Résumé de document
description: Résumer un long texte ou fichier en points clés, décisions et actions à mener.
version: 1.0.0
---
Quand l'utilisateur demande un résumé :
1. Si un fichier est mentionné, lis-le avec read_file.
2. Produis : un TL;DR d'une phrase, 3 à 7 points clés, les décisions prises, puis les actions à mener (qui / quoi / quand).
3. Signale explicitement les zones ambiguës au lieu d'inventer.`,
  "revue-de-code": `---
name: Revue de code
description: Relire du code pour trouver les bugs, les failles de sécurité et les simplifications possibles.
version: 1.0.0
---
Pour une revue de code :
- Lis les fichiers concernés (list_dir / read_file) avant de commenter.
- Classe les remarques par gravité : bloquant, important, suggestion.
- Pour chaque bug, donne un scénario concret qui le déclenche et la correction proposée.
- Ne propose pas de refactorisation cosmétique si le code est déjà clair.`,
};

/**
 * Skills are folders holding a `SKILL.md`, flat (`<dataDir>/skills/<id>/`) or filed by category as
 * Hermes does (`skills/<catégorie>/[<sous-catégorie>/]<id>/`, Q2). The id is the leaf folder name.
 * Only their name and description go into the system prompt; the agent loads the full body on demand
 * with the `load_skill` tool. Version bumps produce an update receipt notification.
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private clashes: SkillCollision[] = [];
  private reportedClashes = "";
  /** Every discovered `SKILL.md`, collision losers included. */
  private paths: string[] = [];
  /** `SKILL_MANIFEST_FILE`, loaded on the first `reload()`, keyed by relative POSIX folder. */
  private manifest?: Map<string, ManifestEntry>;

  constructor(
    readonly dir: string,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
  ) {}

  async seed(): Promise<void> {
    if (existsSync(this.dir)) return;
    for (const [id, text] of Object.entries(EXAMPLE_SKILLS)) {
      await mkdir(join(this.dir, id), { recursive: true });
      await writeFile(join(this.dir, id, "SKILL.md"), text, "utf8");
    }
  }

  /**
   * Skill folders, breadth first: a folder with a `SKILL.md` is a skill (not descended into), any
   * other folder is a category. Dot folders (`.archive`, `.hub`…) are skipped. Sorted by depth, then
   * by relative path in code-unit order: the order that settles id collisions, whatever `readdir` does.
   */
  private async discover(): Promise<Found[]> {
    const found: Found[] = [];
    let level = [""];
    for (let depth = 1; depth <= MAX_SKILL_DEPTH && level.length > 0; depth++) {
      const next: string[] = [];
      const atDepth: Found[] = [];
      for (const rel of level) {
        let entries;
        try {
          entries = await readdir(rel ? join(this.dir, ...rel.split("/")) : this.dir, { withFileTypes: true });
        } catch (e) {
          if (!rel) throw e;
          continue; // an unreadable category hides only its own skills
        }
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          const sub = rel ? `${rel}/${e.name}` : e.name;
          const path = join(this.dir, ...sub.split("/"), "SKILL.md");
          if (existsSync(path)) atDepth.push({ id: e.name, rel: sub, path });
          else next.push(sub);
        }
      }
      found.push(...atDepth.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)));
      level = next;
    }
    return found;
  }

  private async loadManifest(): Promise<Map<string, ManifestEntry>> {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, SKILL_MANIFEST_FILE), "utf8")) as {
        v?: unknown;
        skills?: Record<string, ManifestEntry>;
      };
      if (raw.v === MANIFEST_VERSION && raw.skills && typeof raw.skills === "object") {
        return new Map(Object.entries(raw.skills));
      }
    } catch {
      // missing or unreadable: rebuilt from the files
    }
    return new Map();
  }

  /** `SKILL.md` content, from the manifest when its size and mtime are unchanged. */
  private async readSkill(
    found: Found,
    cache: Map<string, ManifestEntry>,
    next: Map<string, ManifestEntry>,
  ): Promise<{ meta: Record<string, string>; body: string; added: boolean }> {
    const info = await stat(found.path);
    const hit = cache.get(found.rel);
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
      next.set(found.rel, hit);
      return { meta: hit.meta, body: hit.body, added: false };
    }
    const { meta, body } = parseFrontmatter(await readFile(found.path, "utf8"));
    if (Date.now() - info.mtimeMs < RACY_MS) return { meta, body, added: false };
    const kept: Record<string, string> = {};
    for (const k of MANIFEST_KEYS) if (meta[k]) kept[k] = meta[k];
    next.set(found.rel, { mtimeMs: info.mtimeMs, size: info.size, meta: kept, body });
    return { meta, body, added: true };
  }

  /** Best effort, atomic: a skills folder that cannot be written simply goes uncached. */
  private async saveManifest(entries: Map<string, ManifestEntry>): Promise<void> {
    const file = join(this.dir, SKILL_MANIFEST_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ v: MANIFEST_VERSION, skills: Object.fromEntries(entries) }), "utf8");
      await rename(tmp, file);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  async reload(): Promise<Skill[]> {
    await mkdir(this.dir, { recursive: true });
    const disabled = new Set(this.settings.get("disabledSkills"));
    const versions = { ...this.settings.get("skillVersions") };
    let versionsChanged = false;
    const next = new Map<string, Skill>();
    const cache = (this.manifest ??= await this.loadManifest());
    const nextCache = new Map<string, ManifestEntry>();
    let cacheChanged = false;
    const keptRel = new Map<string, string>();
    const clashes = new Map<string, SkillCollision>();
    const found = await this.discover();
    for (const f of found) {
      const winner = keptRel.get(f.id);
      if (winner !== undefined) {
        const clash = clashes.get(f.id) ?? { id: f.id, kept: winner, ignored: [] };
        clash.ignored.push(f.rel);
        clashes.set(f.id, clash);
        continue;
      }
      keptRel.set(f.id, f.rel);
      const { meta, body, added } = await this.readSkill(f, cache, nextCache);
      if (added) cacheChanged = true;
      const skill: Skill = {
        id: f.id,
        name: meta.name || f.id,
        description: meta.description || "",
        version: meta.version || "0.0.0",
        enabled: !disabled.has(f.id),
        path: f.path,
        body,
        ...(meta.author ? { author: meta.author } : {}),
        ...(f.rel.includes("/") ? { category: f.rel.slice(0, f.rel.lastIndexOf("/")) } : {}),
      };
      next.set(skill.id, skill);
      const previous = versions[skill.id];
      if (previous !== skill.version) {
        if (previous) {
          this.notifications.add("info", `Skill mise à jour : ${skill.name}`, `Version ${previous} → ${skill.version}`);
        }
        versions[skill.id] = skill.version;
        versionsChanged = true;
      }
    }
    if (versionsChanged) this.settings.set("skillVersions", versions);
    if (cacheChanged || nextCache.size !== cache.size) await this.saveManifest(nextCache);
    this.manifest = nextCache;
    this.skills = next;
    this.paths = found.map((f) => f.path);
    this.clashes = [...clashes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.reportClashes();
    return this.list();
  }

  /** Same-name skill folders found by the last `reload()`: the shallowest, then the first path, wins. */
  collisions(): SkillCollision[] {
    return this.clashes.map((c) => ({ ...c, ignored: [...c.ignored] }));
  }

  /** One notification per new set of collisions (not one per reload). */
  private reportClashes(): void {
    const signature = JSON.stringify(this.clashes);
    if (signature === this.reportedClashes) return;
    this.reportedClashes = signature;
    if (this.clashes.length === 0) return;
    this.notifications.add(
      "warning",
      `Skills en double : ${this.clashes.length} identifiant(s)`,
      this.clashes.map((c) => `${c.id} : ${c.kept} chargée, ignorée(s) : ${c.ignored.join(", ")}`).join("\n"),
    );
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  enabled(): Skill[] {
    return this.list().filter((s) => s.enabled);
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const disabled = new Set(this.settings.get("disabledSkills"));
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.settings.set("disabledSkills", [...disabled]);
    const s = this.skills.get(id);
    if (s) s.enabled = enabled;
  }

  /**
   * Ré-applique `disabledSkills` sur l'inventaire EN MÉMOIRE — synchrone, sans relire un seul
   * fichier : le seul effet d'une écriture du réglage. `reload()` fait le même filtrage au
   * chargement ; c'est ce chemin qui rend DS3 immédiat (aucune fenêtre « à moitié »).
   */
  applyDisabled(): void {
    const disabled = new Set(this.settings.get("disabledSkills"));
    for (const s of this.skills.values()) s.enabled = !disabled.has(s.id);
  }

  /**
   * Writes a new skill. The settings screen overwrites an existing id; the agent passes
   * `overwrite: false` so it can never silently replace a skill the user wrote.
   */
  async create(
    id: string,
    name: string,
    description: string,
    body: string,
    opts: { author?: string; overwrite?: boolean } = {},
  ): Promise<Skill> {
    const safe = skillId(id);
    if (!safe) throw new Error("Identifiant de skill invalide");
    // An existing skill of that id is rewritten where it lives (possibly in a category): a new flat
    // folder would shadow it.
    const existing = this.skills.get(safe);
    const folder = existing ? dirname(existing.path) : join(this.dir, safe);
    if (opts.overwrite === false && (existing || existsSync(join(folder, "SKILL.md")))) {
      throw new Error(`La skill « ${safe} » existe déjà : modifie-la au lieu de la recréer.`);
    }
    if (!existing && this.paths.some((p) => p.startsWith(folder + sep))) {
      throw new Error(`« ${safe} » est un dossier de catégorie de skills : choisis un autre identifiant.`);
    }
    if (body.length > MAX_SKILL_BODY) throw new Error(`Skill trop longue (max ${MAX_SKILL_BODY} caractères).`);
    await mkdir(folder, { recursive: true });
    const meta = {
      name: oneLine(name, MAX_SKILL_NAME) || safe,
      description: oneLine(description, MAX_SKILL_DESCRIPTION),
      version: "1.0.0",
      author: opts.author ? oneLine(opts.author, 40) : "",
    };
    await writeFile(join(folder, "SKILL.md"), skillText(meta, body), "utf8");
    await this.reload();
    if (opts.author === "agent") {
      this.notifications.add("info", `Nouvelle skill apprise : ${meta.name}`, meta.description);
    }
    return this.get(safe)!;
  }

  /** Rewrites some fields of a skill and bumps its patch version (the reload notifies the user). */
  async update(id: string, patch: { name?: string; description?: string; body?: string }): Promise<Skill> {
    const skill = this.skills.get(id);
    if (!skill) throw new Error(`Skill introuvable : ${id}`);
    const body = patch.body ?? skill.body;
    if (body.length > MAX_SKILL_BODY) throw new Error(`Skill trop longue (max ${MAX_SKILL_BODY} caractères).`);
    const { meta } = parseFrontmatter(await readFile(skill.path, "utf8"));
    if (patch.name !== undefined) meta.name = oneLine(patch.name, MAX_SKILL_NAME) || skill.name;
    if (patch.description !== undefined) meta.description = oneLine(patch.description, MAX_SKILL_DESCRIPTION);
    meta.version = bumpPatch(skill.version);
    await writeFile(skill.path, skillText(meta, body), "utf8");
    await this.reload();
    return this.get(id)!;
  }

  /** Replaces one exact, unique passage of a skill's instructions. */
  async patchBody(id: string, oldText: string, newText: string): Promise<Skill> {
    const skill = this.skills.get(id);
    if (!skill) throw new Error(`Skill introuvable : ${id}`);
    if (!oldText) throw new Error("Le passage à remplacer est vide.");
    const first = skill.body.indexOf(oldText);
    if (first < 0) throw new Error("Passage introuvable dans la skill : recharge-la avec load_skill.");
    if (skill.body.indexOf(oldText, first + 1) >= 0) {
      throw new Error("Passage ambigu (plusieurs occurrences) : cite un extrait plus long.");
    }
    return this.update(id, { body: skill.body.replace(oldText, () => newText) });
  }

  /** The skill's own folder (where `SKILL.md` and its supporting files live). */
  folder(id: string): string {
    const skill = this.skills.get(id);
    if (!skill) throw new Error(`Skill introuvable : ${id}`);
    return dirname(skill.path);
  }

  /** Supporting files of a skill (scripts, references, templates), relative POSIX paths. */
  async files(id: string, max = 200): Promise<string[]> {
    const root = this.folder(id);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (out.length >= max) return;
        if (e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          const rel = relative(root, full).split("\\").join("/");
          if (rel !== "SKILL.md") out.push(rel);
        }
      }
    };
    await walk(root);
    return out.sort();
  }

  /**
   * Reads one supporting file, confined to the skill's folder (symlinks included). Text only: a
   * binary file is described, not dumped into the conversation.
   */
  async readFile(id: string, rel: string, maxChars = 50_000): Promise<string> {
    const root = this.folder(id);
    const target = resolve(root, rel);
    const within = (a: string, b: string) => {
      const r = relative(a, b);
      return r !== "" && !r.startsWith("..") && !isAbsolute(r);
    };
    if (!within(root, target) || !existsSync(target) || !within(realpathSync(root), realpathSync(target))) {
      throw new Error(`Fichier introuvable dans la skill ${id} : ${rel}`);
    }
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Pas un fichier : ${rel}`);
    const data = await readFile(target);
    if (data.subarray(0, 8000).includes(0)) return `[fichier binaire, ${info.size} octets : ${target}]`;
    const text = data.toString("utf8");
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n… [tronqué, ${text.length - maxChars} caractères de plus]`
      : text;
  }

  /**
   * Moves a skill into `.archive/<id>-<horodatage>` instead of deleting it: nothing the agent does is
   * unrecoverable. A filed skill leaves its (possibly empty) category folder in place.
   */
  async archive(id: string): Promise<string> {
    const skill = this.skills.get(id);
    if (!skill) throw new Error(`Skill introuvable : ${id}`);
    const archive = join(this.dir, SKILL_ARCHIVE_DIR);
    await mkdir(archive, { recursive: true });
    const target = join(archive, `${id}-${Date.now()}`);
    await rename(dirname(skill.path), target);
    await this.reload();
    return target;
  }

  /** The categories that hold at least one skill, sorted. */
  categories(): string[] {
    return [...new Set(this.list().flatMap((s) => (s.category ? [s.category] : [])))].sort();
  }

  /**
   * The skills the prompt names. With `categories`, only skills filed under one of them (or under a
   * sub-category: whole path segments, not text prefixes) plus the flat ones, which belong to no category.
   * The body never goes in: the agent loads it on demand.
   */
  promptSection(options: { categories?: string[] } = {}): string {
    const wanted = options.categories;
    const inScope = (s: Skill) => !wanted || !s.category || wanted.some((c) => s.category === c || s.category!.startsWith(`${c}/`));
    const list = this.enabled().filter(inScope);
    if (list.length === 0) return "";
    const lines = list.map((s) => `- ${s.id} : ${s.name} — ${s.description}`);
    return `## Skills disponibles\nAvant une tâche qui correspond à une skill, charge ses instructions avec l'outil load_skill.\n${lines.join("\n")}`;
  }
}
