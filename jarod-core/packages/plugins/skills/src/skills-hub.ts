// Portage de packages/core/src/services/skills-hub.ts (rév. 2e180305).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { withTimeout } from "@jarod/kernel/util";
import { type GuardReport, scanSkillFiles } from "@jarod/plugin-permissions";
import { parseFrontmatter, type SkillRegistry, skillId } from "./skills.js";
import { BUNDLED_PACKS } from "./bundled/index.js";

/**
 * Skills Hub: find and install third-party skills in the open Agent Skills format (a folder with a
 * `SKILL.md`), the same catalog Hermes Agent, Claude Code and others read.
 *
 * - Search goes through skills.sh (the public directory) and, for a domain, its
 *   `/.well-known/skills/index.json`.
 * - Content always comes from its origin, pinned: a GitHub skill is downloaded at an exact commit,
 *   never at a moving branch, and every file's SHA-256 lands in `skills/.hub/lock.json`.
 * - Every install is scanned (`skill-guard.ts`); a `dangerous` verdict blocks it.
 * - A hub install never replaces a skill the user wrote: same folder name, different origin → refused.
 */

const SKILLS_SH_SEARCH = "https://skills.sh/api/search";
const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
/** Where a repository usually keeps its skills, tried in order before a search of the whole tree. */
const SKILL_ROOTS = ["", "skills/", ".agents/skills/", ".claude/skills/"];
const MAX_FILES = 100;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 5_000_000;
const TIMEOUT_MS = 20_000;

export const HUB_DIR = ".hub";

export interface HubSearchResult {
  /** What `install` takes: `owner/repo/skill`, `well-known:domain/skill` or a URL. */
  identifier: string;
  name: string;
  description?: string;
  source: "skills.sh" | "well-known";
  installs?: number;
}

export interface HubFile {
  /** Path inside the skill folder, POSIX separators. */
  path: string;
  data: Buffer;
}

export interface HubBundle {
  identifier: string;
  source: "github" | "well-known" | "url" | "bundled";
  name: string;
  description: string;
  files: HubFile[];
  /** GitHub only: the repository, folder and commit the files come from. */
  repo?: string;
  path?: string;
  commit?: string;
  url?: string;
}

export interface HubLockEntry {
  identifier: string;
  source: HubBundle["source"];
  repo?: string;
  path?: string;
  commit?: string;
  url?: string;
  installedAt: number;
  verdict: GuardReport["verdict"];
  files: Record<string, string>;
}

export interface HubInstallResult {
  id: string;
  bundle: HubBundle;
  scan: GuardReport;
  updated: boolean;
}

export interface SkillsHubDeps {
  skills: SkillRegistry;
  fetch?: typeof fetch;
  /** Optional GitHub token (raises the anonymous limit of 60 requests an hour). */
  githubToken?: () => string | undefined;
  /**
   * V-07 — each file of a PUBLIC skill passes the quarantine (`ctx.quarantine.admitBytes`) before it is written. Wired by the plugin (a
   * refusal for every file when the quarantine is missing); absent only in a test that builds the hub by hand. Bundled packs ship with
   * Jarod and do not pass it.
   */
  admit?: (data: Buffer, label: string, provenance: { source: string; url?: string }) => { admitted: boolean; reason?: string };
}

type Target =
  | { kind: "github"; repo: string; rest: string; ref?: string }
  | { kind: "well-known"; domain: string; skill: string }
  | { kind: "url"; url: string }
  | { kind: "bundled"; pack: string; skill: string };

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);

/** A path from a remote index or tree: relative, POSIX, no `..`, nothing hidden at the root. */
function safeRelPath(p: string): string {
  const norm = posix.normalize(p.replace(/\\/g, "/"));
  if (!norm || norm.startsWith("/") || norm.startsWith("..") || /^[a-zA-Z]:/.test(norm) || norm.includes("/../")) {
    throw new Error(`Chemin refusé dans la skill : ${p}`);
  }
  return norm;
}

export function parseHubIdentifier(raw: string): Target {
  const id = raw.trim();
  const tree = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/([^/]+)\/(.+?)\/?$/i.exec(id);
  if (tree) return { kind: "github", repo: tree[1]!, ref: tree[2]!, rest: tree[3]! };
  if (/^https?:\/\//i.test(id)) {
    if (!/\/SKILL\.md$/i.test(new URL(id).pathname))
      throw new Error("Une URL directe doit pointer vers un fichier SKILL.md.");
    return { kind: "url", url: id };
  }
  // Cockpit, lot 3 : une skill EMBARQUÉE dans le code (provenance épinglée), sans réseau.
  const bundled = /^bundled:([\w.-]+)\/([\w.-]+)$/.exec(id);
  if (bundled) return { kind: "bundled", pack: bundled[1]!, skill: bundled[2]! };
  const wk = /^well-known:([a-z0-9.-]+\.[a-z]{2,})\/([\w.-]+)$/i.exec(id);
  if (wk) return { kind: "well-known", domain: wk[1]!.toLowerCase(), skill: wk[2]! };
  const gh = /^(?:github:|skills-sh\/|skills\.sh\/)?([\w.-]+\/[\w.-]+)\/(.+?)\/?$/.exec(id);
  if (gh && !gh[2]!.split("/").includes("..")) return { kind: "github", repo: gh[1]!, rest: gh[2]! };
  throw new Error(
    `Identifiant non reconnu : ${raw} (attendu : propriétaire/dépôt/skill, well-known:domaine/skill ou une URL).`,
  );
}

export class SkillsHubService {
  private readonly http: typeof fetch;

  constructor(private readonly d: SkillsHubDeps) {
    this.http = d.fetch ?? fetch;
  }

  private get lockPath(): string {
    return join(this.d.skills.dir, HUB_DIR, "lock.json");
  }

  async lock(): Promise<Record<string, HubLockEntry>> {
    try {
      return JSON.parse(await readFile(this.lockPath, "utf8")) as Record<string, HubLockEntry>;
    } catch {
      return {};
    }
  }

  private async writeLock(lock: Record<string, HubLockEntry>): Promise<void> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    await writeFile(this.lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }

  private async get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    const res = await this.http(url, {
      headers: { "user-agent": "Jarod-One", ...headers },
      signal: withTimeout(undefined, TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res;
  }

  private async json<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    return (await (await this.get(url, headers)).json()) as T;
  }

  private async bytes(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
    const res = await this.get(url, headers);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_FILE_BYTES) throw new Error(`Fichier trop gros (${declared} octets) : ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) throw new Error(`Fichier trop gros (${buf.length} octets) : ${url}`);
    return buf;
  }

  private githubHeaders(): Record<string, string> {
    const token = this.d.githubToken?.();
    return {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  // ---------- Search ----------

  async search(query: string, limit = 10): Promise<HubSearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const n = Math.min(Math.max(1, Math.floor(limit)), 50);
    // A bare domain is a publisher: read its well-known index instead of the directory.
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(q) && !q.includes("/")) {
      const index = await this.wellKnownIndex(q.toLowerCase());
      return index.slice(0, n).map((e) => ({
        identifier: `well-known:${q.toLowerCase()}/${e.name}`,
        name: e.name,
        ...(e.description ? { description: e.description } : {}),
        source: "well-known" as const,
      }));
    }
    const data = await this.json<{
      skills?: { id?: string; source?: string; skillId?: string; name?: string; installs?: number }[];
    }>(`${SKILLS_SH_SEARCH}?q=${encodeURIComponent(q)}&limit=${n}`);
    return (data.skills ?? [])
      .map((s): HubSearchResult | null => {
        const identifier = s.id ?? (s.source && s.skillId ? `${s.source}/${s.skillId}` : "");
        if (identifier.split("/").length < 3) return null;
        const r: HubSearchResult = { identifier, name: s.name ?? s.skillId ?? identifier, source: "skills.sh" };
        if (typeof s.installs === "number") r.installs = s.installs;
        return r;
      })
      .filter((r): r is HubSearchResult => r !== null)
      .slice(0, n);
  }

  private async wellKnownIndex(domain: string): Promise<{ name: string; description?: string; files?: string[] }[]> {
    const index = await this.json<{ skills?: unknown }>(`https://${domain}/.well-known/skills/index.json`);
    if (!Array.isArray(index.skills)) throw new Error(`Index de skills invalide sur ${domain}`);
    return index.skills.filter(
      (e): e is { name: string; description?: string; files?: string[] } =>
        typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string",
    );
  }

  // ---------- Fetch ----------

  async fetchBundle(identifier: string): Promise<HubBundle> {
    const t = parseHubIdentifier(identifier);
    const bundle =
      t.kind === "bundled"
        ? this.fromBundled(identifier, t)
        : t.kind === "github"
        ? await this.fetchGithub(identifier, t)
        : t.kind === "well-known"
          ? await this.fetchWellKnown(identifier, t)
          : await this.fetchUrl(identifier, t.url);
    const total = bundle.files.reduce((n, f) => n + f.data.length, 0);
    if (total > MAX_TOTAL_BYTES) throw new Error(`Skill trop volumineuse (${total} octets).`);
    return bundle;
  }

  private withMeta(base: Omit<HubBundle, "name" | "description">, fallbackName: string): HubBundle {
    const skillMd = base.files.find((f) => f.path === "SKILL.md");
    if (!skillMd) throw new Error("Pas de SKILL.md dans cette skill.");
    const { meta } = parseFrontmatter(skillMd.data.toString("utf8"));
    return { ...base, name: meta.name || fallbackName, description: meta.description || "" };
  }

  /** Cockpit, lot 3 : une skill embarquée — les fichiers viennent du code, la provenance du lot (dépôt, commit, licence). */
  private fromBundled(identifier: string, t: { pack: string; skill: string }): HubBundle {
    const pack = BUNDLED_PACKS[t.pack];
    const skill = pack?.skills[t.skill];
    if (!pack || !skill) throw new Error(`Skill embarquée inconnue : ${identifier}`);
    const files: HubFile[] = Object.entries(skill.files).map(([path, text]) => ({ path, data: Buffer.from(text, "utf8") }));
    files.push({ path: "LICENSE", data: Buffer.from(pack.licenseText, "utf8") });
    return this.withMeta({ identifier, source: "bundled", repo: pack.repo, path: skill.origin, commit: pack.commit, files }, t.skill);
  }

  /** Les skills embarquées, avec leur provenance et si elles sont déjà installées. */
  async bundled(): Promise<{ identifier: string; id: string; pack: string; repo: string; commit: string; license: string; name: string; description: string; installed: boolean }[]> {
    const lock = await this.lock();
    const out = [];
    for (const [packId, pack] of Object.entries(BUNDLED_PACKS)) {
      for (const id of Object.keys(pack.skills)) {
        const identifier = `bundled:${packId}/${id}`;
        const b = this.fromBundled(identifier, { pack: packId, skill: id });
        out.push({ identifier, id, pack: packId, repo: pack.repo, commit: pack.commit, license: pack.license, name: b.name, description: b.description, installed: lock[id]?.identifier === identifier && Boolean(this.d.skills.get(id)) });
      }
    }
    return out;
  }

  private async fetchUrl(identifier: string, url: string): Promise<HubBundle> {
    const data = await this.bytes(url);
    const last = new URL(url).pathname.split("/").slice(-2)[0] ?? "skill";
    return this.withMeta({ identifier, source: "url", url, files: [{ path: "SKILL.md", data }] }, last);
  }

  private async fetchWellKnown(identifier: string, t: { domain: string; skill: string }): Promise<HubBundle> {
    const entry = (await this.wellKnownIndex(t.domain)).find((e) => e.name === t.skill);
    if (!entry) throw new Error(`Skill ${t.skill} absente de l'index de ${t.domain}`);
    const list = Array.isArray(entry.files) && entry.files.length ? entry.files : ["SKILL.md"];
    if (list.length > MAX_FILES) throw new Error(`Trop de fichiers (${list.length}).`);
    const base = `https://${t.domain}/.well-known/skills/${encodeURIComponent(t.skill)}/`;
    const files: HubFile[] = [];
    for (const p of list) {
      const path = safeRelPath(String(p));
      files.push({ path, data: await this.bytes(new URL(path, base).href) });
    }
    return this.withMeta({ identifier, source: "well-known", url: base, files }, t.skill);
  }

  private async fetchGithub(identifier: string, t: { repo: string; rest: string; ref?: string }): Promise<HubBundle> {
    const h = this.githubHeaders();
    const ref =
      t.ref ?? (await this.json<{ default_branch: string }>(`${GITHUB_API}/repos/${t.repo}`, h)).default_branch;
    const commit = (
      await this.json<{ sha: string }>(`${GITHUB_API}/repos/${t.repo}/commits/${encodeURIComponent(ref)}`, h)
    ).sha;
    const tree = await this.json<{ tree: { path: string; type: string; size?: number }[] }>(
      `${GITHUB_API}/repos/${t.repo}/git/trees/${commit}?recursive=1`,
      h,
    );
    const blobs = tree.tree.filter((e) => e.type === "blob");
    const has = new Set(blobs.map((b) => b.path));
    const rest = t.rest.replace(/\/SKILL\.md$/i, "").replace(/^\/+|\/+$/g, "");
    let dir = SKILL_ROOTS.map((r) => `${r}${rest}`).find((d) => has.has(`${d}/SKILL.md`));
    if (!dir) {
      // Last resort: a unique folder of that name anywhere in the repository.
      const leaf = rest.split("/").at(-1)!;
      const matches = blobs
        .map((b) => b.path)
        .filter((p) => p.endsWith(`/${leaf}/SKILL.md`) || p === `${leaf}/SKILL.md`);
      if (matches.length !== 1) {
        throw new Error(
          matches.length
            ? `Plusieurs skills « ${leaf} » dans ${t.repo} : précise le chemin.`
            : `Skill « ${rest} » introuvable dans ${t.repo}.`,
        );
      }
      dir = matches[0]!.slice(0, -"/SKILL.md".length);
    }
    const inside = blobs.filter((b) => b.path.startsWith(`${dir}/`));
    if (inside.length > MAX_FILES) throw new Error(`Trop de fichiers dans la skill (${inside.length}).`);
    const files: HubFile[] = [];
    for (const b of inside) {
      if ((b.size ?? 0) > MAX_FILE_BYTES) throw new Error(`Fichier trop gros : ${b.path}`);
      const path = safeRelPath(b.path.slice(dir.length + 1));
      const url = `${GITHUB_RAW}/${t.repo}/${commit}/${b.path.split("/").map(encodeURIComponent).join("/")}`;
      files.push({ path, data: await this.bytes(url) });
    }
    return this.withMeta(
      { identifier, source: "github", repo: t.repo, path: dir, commit, files },
      dir.split("/").at(-1) ?? rest,
    );
  }

  // ---------- Inspect / install ----------

  scan(bundle: HubBundle): GuardReport {
    return scanSkillFiles(
      bundle.files.filter((f) => isText(f.data)).map((f) => ({ path: f.path, text: f.data.toString("utf8") })),
    );
  }

  async inspect(identifier: string): Promise<{ bundle: HubBundle; scan: GuardReport; id: string }> {
    const bundle = await this.fetchBundle(identifier);
    return { bundle, scan: this.scan(bundle), id: skillId(bundle.name) || skillId(identifier.split("/").at(-1) ?? "") };
  }

  /**
   * Downloads, scans and installs a skill. A `dangerous` scan blocks it (`force` does not override
   * that). Re-installing the same identifier updates it; a folder of that name from anywhere else
   * — the user's own skill, or another origin — is never overwritten.
   */
  async install(identifier: string): Promise<HubInstallResult> {
    const { bundle, scan, id } = await this.inspect(identifier);
    if (!id) throw new Error("Nom de skill invalide.");
    if (scan.verdict === "dangerous") {
      throw new Error(`Installation bloquée : l'analyse a trouvé des motifs dangereux dans ${identifier}.`);
    }
    if (bundle.source !== "bundled" && this.d.admit) {
      for (const f of bundle.files) {
        const verdict = this.d.admit(f.data, f.path, { source: "skill", ...(bundle.url ? { url: bundle.url } : {}) });
        if (!verdict.admitted) throw new Error(`Installation bloquée : ${f.path} refusé par la quarantaine (${verdict.reason ?? "non admis"}). Rien n'a été écrit.`);
      }
    }
    const lock = await this.lock();
    const target = join(this.d.skills.dir, id);
    const previous = lock[id];
    const existing = this.d.skills.get(id);
    if (existing && dirname(existing.path) !== target) {
      throw new Error(`La skill « ${id} » existe déjà dans ${dirname(existing.path)} : rien n'a été remplacé.`);
    }
    if (existsSync(target) && previous?.identifier !== bundle.identifier) {
      throw new Error(
        `Un dossier « ${id} » existe déjà (skill locale ou d'une autre origine) : rien n'a été remplacé.`,
      );
    }
    const staging = join(this.d.skills.dir, HUB_DIR, "staging", `${id}-${Date.now()}`);
    try {
      for (const f of bundle.files) {
        const dest = join(staging, ...f.path.split("/"));
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, f.data);
      }
      if (existsSync(target)) await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    lock[id] = {
      identifier: bundle.identifier,
      source: bundle.source,
      ...(bundle.repo ? { repo: bundle.repo } : {}),
      ...(bundle.path ? { path: bundle.path } : {}),
      ...(bundle.commit ? { commit: bundle.commit } : {}),
      ...(bundle.url ? { url: bundle.url } : {}),
      installedAt: Date.now(),
      verdict: scan.verdict,
      files: Object.fromEntries(bundle.files.map((f) => [f.path, sha256(f.data)])),
    };
    await this.writeLock(lock);
    await this.d.skills.reload();
    return { id, bundle, scan, updated: Boolean(previous) };
  }

  /** Re-fetches hub skills; only those whose content changed are reinstalled. */
  async update(onlyId?: string): Promise<{ id: string; status: "updated" | "unchanged" | "error"; detail?: string }[]> {
    const lock = await this.lock();
    const ids = onlyId ? [onlyId] : Object.keys(lock);
    const out: { id: string; status: "updated" | "unchanged" | "error"; detail?: string }[] = [];
    for (const id of ids) {
      const entry = lock[id];
      if (!entry) {
        out.push({ id, status: "error", detail: "pas installée depuis le hub" });
        continue;
      }
      try {
        const bundle = await this.fetchBundle(entry.identifier);
        const files = Object.fromEntries(bundle.files.map((f) => [f.path, sha256(f.data)]));
        if (JSON.stringify(files) === JSON.stringify(entry.files)) {
          out.push({ id, status: "unchanged" });
          continue;
        }
        await this.install(entry.identifier);
        out.push({ id, status: "updated", ...(bundle.commit ? { detail: bundle.commit.slice(0, 7) } : {}) });
      } catch (e) {
        out.push({ id, status: "error", detail: (e as Error).message });
      }
    }
    return out;
  }

  /** Uninstalls a hub skill: archived like any other (recoverable), and dropped from the lock. */
  async remove(id: string): Promise<void> {
    const lock = await this.lock();
    if (!lock[id]) throw new Error(`« ${id} » n'a pas été installée depuis le hub.`);
    if (this.d.skills.get(id)) await this.d.skills.archive(id);
    delete lock[id];
    await this.writeLock(lock);
  }
}
