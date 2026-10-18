// Portage de packages/core/src/services/lsp.ts (rév. 2e180305) avec les gardes NOUVELLES
// (SPECS-P5-LSP.md § 2.2) : G1 accord obligatoire, G2 jamais de démarrage automatique,
// G3 serveur de projet annoncé, G4 custom lu des réglages, G5 environnement réduit, G6 bornes.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findOnPath } from "@jarod/kernel/find-on-path";
import { killTree } from "@jarod/kernel/util";
import type { LspConfig, ToolCall } from "@jarod/contracts";
import { resolveInWorkspace } from "./builtin.js";
import type { ShellApprover } from "@jarod/plugin-permissions";
import type { ToolDef } from "./registry.js";

// ---------- Types ----------

export interface LspServerStatus {
  id: string;
  name: string;
  extensions: string[];
  custom: boolean;
  found: string | null;
  installHint: string;
  running: boolean;
}

export interface Launch {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  display: string;
  provenance: "path" | "project" | "custom";
}

interface ServerDef {
  id: string;
  name: string;
  extensions: string[];
  installHint: string;
  custom: boolean;
  resolve(root: string): Launch | null;
}

export interface Diagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface Location {
  uri: string;
  range: Diagnostic["range"];
}

// ---------- Constants ----------

const SEVERITY = ["", "erreur", "avertissement", "info", "suggestion"];

const SYMBOL_KINDS = [
  "",
  "fichier",
  "module",
  "namespace",
  "package",
  "classe",
  "méthode",
  "propriété",
  "champ",
  "constructeur",
  "enum",
  "interface",
  "fonction",
  "variable",
  "constante",
  "chaîne",
  "nombre",
  "booléen",
  "tableau",
  "objet",
  "clé",
  "null",
  "membre d'enum",
  "struct",
  "événement",
  "opérateur",
  "paramètre de type",
];

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
};

const languageId = (file: string) => LANGUAGE_IDS[extname(file).toLowerCase()] ?? extname(file).slice(1).toLowerCase();

const MAX_PATHS = 20;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // G5 : 10 minutes

// ---------- Helpers ----------

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function binaryLaunch(path: string, args: string[]): Launch {
  if (/\.(cmd|bat)$/i.test(path)) return { command: `"${path}"`, args, shell: true, display: path, provenance: "path" };
  return { command: path, args, display: path, provenance: "path" };
}

/** L'hôte vu par `nodeInterpreter` : injectable pour les tests. */
export interface NodeHost {
  electron: string | undefined;
  execPath: string;
  find(command: string): string | null;
}
const currentHost = (): NodeHost => ({ electron: process.versions.electron, execPath: process.execPath, find: (c) => findOnPath(c) });

/**
 * L'interpréteur Node des serveurs de langage « du projet ». Hors Electron (CLI), `process.execPath` EST node. Sous Electron, c'est
 * l'exécutable de l'application : avec le fuse `runAsNode=false` (audit v4, B2), `ELECTRON_RUN_AS_NODE=1` n'en fait plus un Node et le
 * lancement ouvrirait une seconde instance de l'application. On prend donc le `node` du PATH ; absent : `null` (serveur du projet non proposé).
 */
export function nodeInterpreter(host: NodeHost = currentHost()): string | null {
  return host.electron ? host.find("node") : host.execPath;
}

export function nodeLaunch(script: string, args: string[], host: NodeHost = currentHost()): Launch | null {
  const command = nodeInterpreter(host);
  if (!command) return null;
  return { command, args: [script, ...args], display: script, provenance: "project" };
}

/** Looks for `node_modules/<pkg>` in the workspace or one of its parents. */
function findPackage(root: string, pkg: string): { dir: string; version: string } | null {
  let dir = resolve(root);
  for (;;) {
    const manifest = join(dir, "node_modules", pkg, "package.json");
    if (existsSync(manifest)) {
      try {
        return { dir: dirname(manifest), version: String(JSON.parse(readFileSync(manifest, "utf8")).version ?? "0") };
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const onPath = (command: string, args: string[]) => (): Launch | null => {
  const p = findOnPath(command);
  return p ? binaryLaunch(p, args) : null;
};

// ---------- Built-in servers ----------

const BUILTIN_SERVERS: ServerDef[] = [
  {
    id: "typescript",
    name: "TypeScript / JavaScript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    installHint: "npm i -D typescript@7 (serveur intégré) ou npm i -g typescript-language-server typescript",
    custom: false,
    resolve(root) {
      // G3 : serveur de projet seulement si aucun sur le PATH
      const ts = findPackage(root, "typescript");
      if (ts && Number.parseInt(ts.version, 10) >= 7 && existsSync(join(ts.dir, "bin", "tsc"))) {
        const launch = nodeLaunch(join(ts.dir, "bin", "tsc"), ["--lsp", "--stdio"]);
        if (launch) return launch;
      }
      const tls = findPackage(root, "typescript-language-server");
      if (tls && existsSync(join(tls.dir, "lib", "cli.mjs"))) {
        const launch = nodeLaunch(join(tls.dir, "lib", "cli.mjs"), ["--stdio"]);
        if (launch) return launch;
      }
      return onPath("typescript-language-server", ["--stdio"])();
    },
  },
  {
    id: "python",
    name: "Python",
    extensions: [".py", ".pyi"],
    installHint: "npm i -g pyright (ou pip install python-lsp-server)",
    custom: false,
    resolve(root) {
      const pyright = findPackage(root, "pyright");
      if (pyright && existsSync(join(pyright.dir, "langserver.index.js"))) {
        const launch = nodeLaunch(join(pyright.dir, "langserver.index.js"), ["--stdio"]);
        if (launch) return launch;
      }
      return (
        onPath("pyright-langserver", ["--stdio"])() ??
        onPath("basedpyright-langserver", ["--stdio"])() ??
        onPath("pylsp", [])()
      );
    },
  },
  {
    id: "rust",
    name: "Rust",
    extensions: [".rs"],
    installHint: "rustup component add rust-analyzer",
    custom: false,
    resolve: onPath("rust-analyzer", []),
  },
  {
    id: "go",
    name: "Go",
    extensions: [".go"],
    installHint: "go install golang.org/x/tools/gopls@latest",
    custom: false,
    resolve: onPath("gopls", []),
  },
  {
    id: "clangd",
    name: "C / C++",
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"],
    installHint: "Installez clangd (LLVM) et ajoutez-le au PATH",
    custom: false,
    resolve: onPath("clangd", []),
  },
];

// ---------- File keys ----------

function fileKey(p: string): string {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function uriKey(uri: string): string {
  try {
    return fileKey(fileURLToPath(uri));
  } catch {
    return uri;
  }
}

// ---------- Reduced environment (G5) ----------

function reducedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keys = ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "TEMP", "TMP", "USERPROFILE", "HOME"];
  for (const k of keys) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

// ---------- JSON-RPC client ----------

export class LspClient {
  private proc: ChildProcess;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private docs = new Map<string, { version: number; text: string }>();
  private diags = new Map<string, { items: Diagnostic[]; at: number }>();
  private listeners = new Set<() => void>();
  private stderrTail = "";
  capabilities: Record<string, any> = {};
  dead = false;
  readonly ready: Promise<void>;
  lastActivity = Date.now();

  constructor(
    readonly serverId: string,
    readonly root: string,
    launch: Launch,
  ) {
    this.proc = spawn(launch.command, launch.args, {
      cwd: root,
      env: launch.env ?? reducedEnv(),
      shell: launch.shell ?? false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr!.on(
      "data",
      (chunk: Buffer) => (this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000)),
    );
    this.proc.stdin!.on("error", () => {});
    const onGone = (reason: string) => {
      if (this.dead) return;
      this.dead = true;
      const err = new Error(
        `Serveur de langage ${serverId} arrêté (${reason}).${this.stderrTail ? ` ${this.stderrTail.trim().slice(-400)}` : ""}`,
      );
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      for (const l of this.listeners) l();
    };
    this.proc.on("error", (e) => onGone(e.message));
    this.proc.on("exit", (code) => onGone(`code ${code}`));
    this.ready = this.initialize();
    this.ready.catch(() => {});
  }

  private async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.root).href;
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "jarod-one" },
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: basename(this.root) || this.root }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
            diagnostic: { dynamicRegistration: false },
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ["markdown", "plaintext"] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: { configuration: true, workspaceFolders: true },
          window: { workDoneProgress: false },
        },
      },
      60_000,
    );
    this.capabilities = result?.capabilities ?? {};
    this.notify("initialized", {});
  }

  private write(msg: object): void {
    if (this.dead) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
    this.proc.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.dead) return Promise.reject(new Error(`Serveur de langage ${this.serverId} arrêté.`));
    this.lastActivity = Date.now();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Le serveur de langage ${this.serverId} n'a pas répondu à ${method} à temps.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(this.buf.subarray(0, headerEnd).toString("ascii"))?.[1]);
      if (!Number.isFinite(length)) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      if (this.buf.length < headerEnd + 4 + length) return;
      const body = this.buf.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      this.buf = this.buf.subarray(headerEnd + 4 + length);
      try {
        this.onMessage(JSON.parse(body));
      } catch {
        // Ignore malformed messages.
      }
    }
  }

  private onMessage(msg: any): void {
    if (msg.id !== undefined && msg.method) {
      let result: unknown = null;
      if (msg.method === "workspace/configuration") result = (msg.params?.items ?? []).map(() => null);
      else if (msg.method === "workspace/workspaceFolders")
        result = [{ uri: pathToFileURL(this.root).href, name: basename(this.root) }];
      else if (
        !/^(window\/workDoneProgress\/create|client\/(un)?registerCapability|window\/showMessageRequest|workspace\/(diagnostic|semanticTokens|inlayHint|codeLens)\/refresh)$/.test(
          msg.method,
        )
      ) {
        this.write({ id: msg.id, error: { code: -32601, message: `Unsupported: ${msg.method}` } });
        return;
      }
      this.write({ id: msg.id, result });
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.message ?? "Erreur du serveur de langage"}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
      this.diags.set(uriKey(msg.params.uri), { items: msg.params.diagnostics ?? [], at: Date.now() });
      for (const l of this.listeners) l();
    }
  }

  async sync(file: string): Promise<boolean> {
    await this.ready;
    const text = await readFile(file, "utf8");
    const key = fileKey(file);
    const uri = pathToFileURL(file).href;
    const doc = this.docs.get(key);
    if (!doc) {
      this.docs.set(key, { version: 1, text });
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(file), version: 1, text } });
      return true;
    }
    if (doc.text === text) return false;
    doc.version++;
    doc.text = text;
    this.notify("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] });
    return true;
  }

  async diagnostics(file: string, timeoutMs = 20_000): Promise<{ items: Diagnostic[]; complete: boolean }> {
    const since = Date.now();
    const changed = await this.sync(file);
    if (this.capabilities.diagnosticProvider) {
      try {
        const r = await this.request(
          "textDocument/diagnostic",
          { textDocument: { uri: pathToFileURL(file).href } },
          timeoutMs,
        );
        if (r?.kind === "full") return { items: r.items ?? [], complete: true };
      } catch {
        // Fall back to pushed diagnostics.
      }
    }
    const key = fileKey(file);
    const cached = this.diags.get(key);
    if (!changed && cached) return { items: cached.items, complete: true };
    const deadline = since + timeoutMs;
    const QUIET_MS = 800;
    return new Promise((done) => {
      let timer: NodeJS.Timeout | null = null;
      const finish = (complete: boolean) => {
        this.listeners.delete(check);
        if (timer) clearTimeout(timer);
        done({ items: this.diags.get(key)?.items ?? [], complete });
      };
      const check = () => {
        if (this.dead) return finish(false);
        const d = this.diags.get(key);
        if (timer) clearTimeout(timer);
        const now = Date.now();
        if (now >= deadline) return finish(false);
        if (d && d.at >= since) timer = setTimeout(() => finish(true), Math.min(QUIET_MS, deadline - now));
        else timer = setTimeout(() => finish(false), deadline - now);
      };
      this.listeners.add(check);
      check();
    });
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    const exited = new Promise<void>((r) => this.proc.once("exit", () => r()));
    if (!this.dead) {
      await this.request("shutdown", null, 2000).catch(() => {});
      this.notify("exit", null);
    }
    const timer = setTimeout(() => killTree(this.proc), 1000);
    await exited;
    clearTimeout(timer);
  }
}

// ---------- Formatting ----------

function displayPath(root: string, file: string): string {
  const rel = relative(root, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : file;
}

export function formatDiagnostics(
  root: string,
  file: string,
  items: Diagnostic[],
  maxSeverity = 2,
  limit = 50,
): string[] {
  return items
    .filter((d) => (d.severity ?? 1) <= maxSeverity)
    .sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line)
    .slice(0, limit)
    .map((d) => {
      const code =
        d.code !== undefined
          ? ` [${d.source ?? ""}${d.source && /^\d/.test(String(d.code)) ? " " : ""}${d.code}]`
          : d.source
            ? ` [${d.source}]`
            : "";
      const message = d.message.trim().replace(/\n\s*/g, "\n    ");
      return `${displayPath(root, file)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity ?? 1] ?? "erreur"}${code} : ${message}`;
    });
}

function hoverText(contents: any): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n");
  if (typeof contents.value === "string")
    return contents.language ? `\`\`\`${contents.language}\n${contents.value}\n\`\`\`` : contents.value;
  return "";
}

function toLocations(result: any): Location[] {
  const list = result == null ? [] : Array.isArray(result) ? result : [result];
  return list
    .map((l: any) => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l))
    .filter((l: any) => l?.uri && l.range);
}

// ---------- Manager ----------

export const DEFAULT_LSP_CONFIG: LspConfig = { enabled: true, diagnoseAfterEdit: true, custom: [] };

/** Validates a custom server command (G4): absolute path or bare name, no spaces or shell metacharacters. */
function validateCustomCommand(command: string): string | null {
  if (command.includes(" ") || /[;&|<>$`]/.test(command)) return `Commande custom invalide : ${command}`;
  if (isAbsolute(command)) return isFile(command) ? null : `Commande custom introuvable : ${command}`;
  return findOnPath(command) ? null : `Commande custom introuvable sur le PATH : ${command}`;
}

export class LspManager {
  private clients = new Map<string, LspClient>();
  private approvals = new Set<string>(); // sessionId|serverId|root
  private idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly settings: { get(key: string): unknown },
    private readonly approve?: ShellApprover | null,
  ) {}

  config(): LspConfig {
    return { ...DEFAULT_LSP_CONFIG, ...(this.settings.get("lsp") as Partial<LspConfig>) };
  }

  private defs(): ServerDef[] {
    const cfg = this.config();
    // G4 : validation du custom À LA LECTURE (échec rapide, pas lazy)
    for (const c of cfg.custom) {
      const err = validateCustomCommand(c.command);
      if (err) throw new Error(err);
    }
    const custom: ServerDef[] = cfg.custom.map((c) => ({
      id: c.id,
      name: c.name,
      extensions: c.extensions.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()),
      installHint: `Vérifiez que « ${c.command} » est installé.`,
      custom: true,
      resolve: (_root: string) => {
        const p = findOnPath(c.command);
        if (!p) return null;
        const launch = binaryLaunch(p, c.args);
        launch.provenance = "custom";
        return launch;
      },
    }));
    return [...custom, ...BUILTIN_SERVERS];
  }

  status(root: string | null): LspServerStatus[] {
    const dirs = root ? [resolve(root)] : [process.cwd()];
    return this.defs().map((d) => {
      let found: string | null = null;
      for (const dir of dirs) {
        try {
          found = d.resolve(dir)?.display ?? null;
        } catch {
          found = null;
        }
        if (found) break;
      }
      const running = [...this.clients.values()].some((c) => c.serverId === d.id && !c.dead);
      return {
        id: d.id,
        name: d.name,
        extensions: d.extensions,
        custom: d.custom,
        found,
        installHint: d.installHint,
        running,
      };
    });
  }

  /** G1 : demande d'accord pour démarrer un serveur. Retourne true si accordé. */
  private async requestApproval(
    sessionId: string,
    serverId: string,
    root: string,
    launch: Launch,
  ): Promise<boolean> {
    const key = `${sessionId}|${serverId}|${fileKey(root)}`;
    if (this.approvals.has(key)) return true;
    if (!this.approve) return false;

    const provenanceLabel =
      launch.provenance === "project" ? "dans le projet" : launch.provenance === "custom" ? "serveur custom" : "sur le PATH";
    const command = launch.shell ? `${launch.command} ${launch.args.join(" ")}` : `${launch.command} ${launch.args.join(" ")}`.trim();
    const description = `Démarrer le serveur de langage ${serverId} (${provenanceLabel}) :\n  Commande : ${command}\n  Dossier : ${root}`;

    const call: ToolCall = {
      id: `lsp-start-${serverId}`,
      name: "lsp/start",
      args: { serverId, command, root },
    };
    const approved = await this.approve(sessionId, call, description);
    if (approved) this.approvals.add(key);
    return approved;
  }

  /** G6 : démarre le timer d'inactivité pour un client. */
  private scheduleIdleCheck(key: string, client: LspClient): void {
    this.cancelIdleCheck(key);
    const timer = setTimeout(() => {
      if (Date.now() - client.lastActivity >= IDLE_TIMEOUT_MS) {
        void client.stop().then(() => this.clients.delete(key));
      } else {
        this.scheduleIdleCheck(key, client);
      }
    }, IDLE_TIMEOUT_MS);
    this.idleTimers.set(key, timer);
  }

  private cancelIdleCheck(key: string): void {
    const t = this.idleTimers.get(key);
    if (t) clearTimeout(t);
    this.idleTimers.delete(key);
  }

  /** The running (or newly started) server for a file, or null when no server handles it. */
  private async clientFor(
    root: string,
    file: string,
    sessionId: string,
  ): Promise<{ client: LspClient } | { error: string } | null> {
    const ext = extname(file).toLowerCase();
    const def = this.defs().find((d) => d.extensions.includes(ext));
    if (!def) return null;
    const key = `${def.id}|${fileKey(root)}`;
    const existing = this.clients.get(key);
    if (existing && !existing.dead) return { client: existing };

    // G1 : accord obligatoire avant démarrage
    const launch = def.resolve(dirname(file)) ?? def.resolve(root);
    if (!launch) return { error: `Aucun serveur de langage ${def.name} trouvé. Installation : ${def.installHint}` };

    const approved = await this.requestApproval(sessionId, def.id, root, launch);
    if (!approved) return { error: "Accord requis pour démarrer le serveur de langage." };

    const client = new LspClient(def.id, root, launch);
    this.clients.set(key, client);
    this.scheduleIdleCheck(key, client);
    return { client };
  }

  /** G2 : afterEditNote n'utilise que les serveurs DÉJÀ lancés. */
  private clientForAfterEdit(root: string, file: string): { client: LspClient } | null {
    const ext = extname(file).toLowerCase();
    const def = this.defs().find((d) => d.extensions.includes(ext));
    if (!def) return null;
    const key = `${def.id}|${fileKey(root)}`;
    const existing = this.clients.get(key);
    if (existing && !existing.dead) return { client: existing };
    return null; // G2 : jamais de démarrage automatique
  }

  private need(root: string, file: string, sessionId: string): Promise<LspClient> {
    if (!this.config().enabled)
      return Promise.reject(new Error("Le LSP est désactivé (Paramètres → Extensions → Serveurs de langage)."));
    return this.clientFor(root, file, sessionId).then((r) => {
      if (!r) throw new Error(`Aucun serveur de langage pour les fichiers ${extname(file) || basename(file)}.`);
      if ("error" in r) throw new Error(r.error);
      return r.client;
    });
  }

  async diagnose(
    root: string,
    file: string,
    sessionId: string,
    timeoutMs?: number,
  ): Promise<{ items: Diagnostic[]; complete: boolean }> {
    const client = await this.need(root, file, sessionId);
    return client.diagnostics(file, timeoutMs);
  }

  /** Short note appended to write_file / edit_file results (G2 : serveurs déjà lancés seulement). */
  async afterEditNote(root: string, file: string): Promise<string> {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.diagnoseAfterEdit) return "";
    const r = this.clientForAfterEdit(root, file);
    if (!r) return "";
    try {
      const { items, complete } = await r.client.diagnostics(file, 15_000);
      const errors = formatDiagnostics(root, file, items, 1, 20);
      if (errors.length) return `\n\nDiagnostics (${r.client.serverId}) — erreurs à corriger :\n${errors.join("\n")}`;
      return complete ? `\n\nDiagnostics (${r.client.serverId}) : aucune erreur.` : "";
    } catch {
      return "";
    }
  }

  async navigate(
    root: string,
    file: string,
    action: string,
    position: { line: number; character: number } | null,
    sessionId: string,
  ): Promise<string> {
    const client = await this.need(root, file, sessionId);
    await client.sync(file);
    const textDocument = { uri: pathToFileURL(file).href };
    const lineOf = (loc: Location): string => {
      try {
        const path = fileURLToPath(loc.uri);
        const text = readFileSync(path, "utf8").split(/\r?\n/)[loc.range.start.line]?.trim() ?? "";
        return `${displayPath(root, path)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}${text ? `  ${text.slice(0, 160)}` : ""}`;
      } catch {
        return `${loc.uri}:${loc.range.start.line + 1}`;
      }
    };
    if (action === "symbols") {
      const result: any[] = (await client.request("textDocument/documentSymbol", { textDocument })) ?? [];
      const lines: string[] = [];
      const walk = (symbols: any[], depth: number) => {
        for (const s of symbols) {
          const range = s.selectionRange ?? s.range ?? s.location?.range;
          lines.push(
            `${"  ".repeat(depth)}L${(range?.start.line ?? 0) + 1} ${SYMBOL_KINDS[s.kind] ?? "symbole"} ${s.name}`,
          );
          if (Array.isArray(s.children) && depth < 4) walk(s.children, depth + 1);
        }
      };
      walk(result, 0);
      return lines.slice(0, 300).join("\n") || "Aucun symbole.";
    }
    if (!position) throw new Error("Indiquez la ligne (et le symbole ou la colonne) pour cette action.");
    const params = { textDocument, position };
    if (action === "hover") {
      const r = await client.request("textDocument/hover", params);
      return hoverText(r?.contents).trim() || "Aucune information à cette position.";
    }
    if (action === "definition") {
      const locs = toLocations(await client.request("textDocument/definition", params));
      return locs.length ? locs.slice(0, 20).map(lineOf).join("\n") : "Définition introuvable à cette position.";
    }
    if (action === "references") {
      const locs = toLocations(
        await client.request("textDocument/references", { ...params, context: { includeDeclaration: true } }),
      );
      if (!locs.length) return "Aucune référence trouvée.";
      return `${locs.length} référence(s) :\n${locs.slice(0, 100).map(lineOf).join("\n")}${locs.length > 100 ? "\n…" : ""}`;
    }
    throw new Error(`Action inconnue : ${action}`);
  }

  async stopAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    await Promise.all(clients.map((c) => c.stop()));
  }
}

// ---------- Agent tools ----------

/** Converts the model's 1-based line + symbol (or column) into an LSP position. */
export function findPosition(
  text: string,
  line: unknown,
  symbol: unknown,
  column: unknown,
): { line: number; character: number } {
  const lines = text.split(/\r?\n/);
  const l = Number(line);
  if (!Number.isInteger(l) || l < 1 || l > lines.length)
    throw new Error(`Ligne invalide : ${String(line)} (le fichier a ${lines.length} lignes).`);
  const content = lines[l - 1]!;
  if (typeof symbol === "string" && symbol) {
    const idx = content.indexOf(symbol);
    if (idx < 0) throw new Error(`« ${symbol} » absent de la ligne ${l} : ${content.trim().slice(0, 120)}`);
    return { line: l - 1, character: idx };
  }
  const c = Number(column);
  if (Number.isInteger(c) && c >= 1) return { line: l - 1, character: Math.min(c - 1, content.length) };
  const first = content.search(/\S/);
  return { line: l - 1, character: first < 0 ? 0 : first };
}

export function lspTools(lsp: LspManager): ToolDef[] {
  return [
    {
      name: "code_diagnostics",
      description:
        "Vérifie des fichiers de code avec le serveur de langage du projet (LSP : TypeScript, Python, Rust, Go, C/C++…) et renvoie les erreurs et avertissements du compilateur au format fichier:ligne:colonne. Plus fiable et plus rapide que lancer une compilation complète pour vérifier une modification.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Fichiers à vérifier (chemins relatifs au dossier de travail, 20 max).",
          },
        },
        required: ["paths"],
      },
      source: "builtin",
      async run(args, ctx) {
        const root = resolveInWorkspace(ctx, ".");
        const paths = (args.paths as unknown[]).map(String).slice(0, MAX_PATHS);
        const out: string[] = [];
        for (const p of paths) {
          const file = resolveInWorkspace(ctx, p);
          try {
            const { items, complete } = await lsp.diagnose(root, file, ctx.sessionId);
            const lines = formatDiagnostics(root, file, items);
            const suffix = complete ? "" : " (analyse incomplète : le serveur n'a pas fini à temps)";
            out.push(
              lines.length ? `${lines.join("\n")}${suffix}` : `${displayPath(root, file)} : aucun problème${suffix}.`,
            );
          } catch (e) {
            out.push(`${displayPath(root, file)} : ${(e as Error).message}`);
          }
        }
        return out.join("\n");
      },
    },
    {
      name: "code_navigate",
      description:
        "Navigation dans le code via le serveur de langage : `definition` (où un symbole est défini), `references` (où il est utilisé), `hover` (type et documentation), `symbols` (plan du fichier : classes, fonctions…). Pour definition/references/hover, donnez la ligne (commençant à 1) et le symbole tel qu'il apparaît sur cette ligne.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["definition", "references", "hover", "symbols"] },
          path: { type: "string" },
          line: { type: "integer", description: "Ligne, à partir de 1." },
          symbol: {
            type: "string",
            description: "Identifiant présent sur la ligne (sa première occurrence est utilisée).",
          },
          column: { type: "integer", description: "Colonne à partir de 1, si le symbole n'est pas fourni." },
        },
        required: ["action", "path"],
      },
      source: "builtin",
      async run(args, ctx) {
        const root = resolveInWorkspace(ctx, ".");
        const file = resolveInWorkspace(ctx, args.path);
        const action = String(args.action);
        const position =
          action === "symbols" ? null : findPosition(await readFile(file, "utf8"), args.line, args.symbol, args.column);
        return lsp.navigate(root, file, action, position, ctx.sessionId);
      },
    },
  ];
}
