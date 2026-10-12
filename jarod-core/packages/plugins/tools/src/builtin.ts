// Portage de packages/core/src/tools/builtin.ts (rév. 2e180305).
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { decodeConsoleOutput } from "./console-text.js";
import { assertPublicUrl } from "./net-guard.js";
import type { LlamaServerSupervisor } from "@jarod/plugin-llm";
import type { MemoryService } from "@jarod/plugin-memory";
import { ShellGuardService, type ShellLaunchPlan, type WriteScope } from "@jarod/plugin-permissions";
import { VaultService } from "@jarod/plugin-rag";
import type { MemoryType } from "@jarod/contracts";
import { killTree, truncate, withTimeout } from "@jarod/kernel/util";
import type { ToolContext, ToolDef } from "./registry.js";

const MAX_OUTPUT = 30_000;
/** Largest web page body read by web_fetch. */
const MAX_FETCH_BYTES = 5_000_000;

const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * H3 — `fetch` sans suivi automatique des redirections : chaque saut repasse par le garde réseau, sinon une
 * redirection vers `http://127.0.0.1:…` suffirait à contourner le contrôle posé sur l'URL de départ.
 */
async function fetchChecked(start: URL, signal: AbortSignal | undefined, maxHops = 5): Promise<{ res: Response; url: URL }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 Jarod-One" },
      redirect: "manual",
      signal: withTimeout(signal, 30_000),
    });
    if (res.status < 300 || res.status >= 400) return { res, url };
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!location) return { res, url };
    if (hop >= maxHops) throw new Error(`Trop de redirections (> ${maxHops}) — ${start.href}`);
    url = new URL(location, url);
  }
}

/** Real path of `p`, or of its nearest existing parent followed by the rest (for files not created yet). */
function realPathOf(p: string): string {
  let existing = p;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return p;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
    existing = parent;
  }
  try {
    return join(realpathSync.native(existing), ...rest);
  } catch {
    return p;
  }
}

/**
 * Resolves a model-supplied path inside the workspace; refuses anything that escapes it,
 * including through a symbolic link or junction pointing outside.
 */
export function resolveInWorkspace(ctx: ToolContext, p: unknown): string {
  if (!ctx.workspace) {
    throw new Error(
      "Aucun dossier de travail défini. Choisissez-en un (barre latérale → Fichiers, ou /workspace <chemin>).",
    );
  }
  const root = resolve(ctx.workspace);
  const target = resolve(root, typeof p === "string" && p ? p : ".");
  if (!inside(root, target) || !inside(realPathOf(root), realPathOf(target))) {
    throw new Error(`Chemin hors du dossier de travail refusé : ${String(p)}`);
  }
  return target;
}

/**
 * Lance une commande dans `cwd`.
 *
 * Sans `plan`, c'est exactement le comportement d'avant : la ligne entière est confiée au shell.
 * Avec un `plan` en mode `exec`, c'est un binaire et ses arguments qui sont lancés, sans shell
 * intermédiaire : c'est la forme que prend un confinement réel (le mécanisme est alors le premier
 * mot de la ligne, et il tient le processus).
 */
export function runShell(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
  plan?: ShellLaunchPlan,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; output: string }> {
  const env = Object.keys(extraEnv).length ? { ...process.env, ...extraEnv } : process.env;
  return new Promise((done) => {
    // Its own process group on Unix, so the whole command can be killed at once.
    const child =
      plan && plan.mode === "exec"
        ? spawn(plan.bin, plan.args, {
            cwd,
            shell: false,
            windowsHide: true,
            env,
            detached: process.platform !== "win32",
          })
        : spawn(command, {
            cwd,
            shell: true,
            windowsHide: true,
            env,
            detached: process.platform !== "win32",
          });
    // Bytes, decoded once at the end: a Windows console writes in its OEM code page, and a UTF-8
    // character may be split between two chunks — neither can be decided chunk by chunk.
    const chunks: Buffer[] = [];
    let size = 0;
    let notes = "";
    let finished = false;
    const onData = (b: Buffer) => {
      if (size < MAX_OUTPUT * 4) {
        chunks.push(b);
        size += b.length;
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => killTree(child);
    const finish = (code: number | null, extra = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // A grandchild may still hold the pipes: stop listening rather than waiting for them.
      child.stdout.destroy();
      child.stderr.destroy();
      done({ code, output: truncate(decodeConsoleOutput(Buffer.concat(chunks)) + notes + extra, MAX_OUTPUT) });
    };
    const timer = setTimeout(() => {
      notes += `\n[délai dépassé après ${timeoutMs / 1000}s : commande arrêtée]`;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      notes += "\n[interrompu]";
      kill();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => finish(-1, `\n${e.message}`));
    child.on("close", (code) => finish(code));
    // `close` waits for every holder of stdout/stderr; give them a moment after the shell exits.
    child.on("exit", (code) => setTimeout(() => finish(code), 1500).unref());
  });
}

/** Reads a response body up to `max` bytes (a huge download must not exhaust memory). */
async function readCapped(res: Response, max: number): Promise<{ text: string; capped: boolean }> {
  if (!res.body) return { text: "", capped: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= max) {
      capped = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), capped };
}

/** Lines `offset`..`offset+limit-1` (1-based) of a text, or as many whole lines as fit in MAX_OUTPUT. */
export function sliceLines(text: string, offset?: number, limit?: number): string {
  const lines = text.split("\n");
  const start = Math.max(1, Math.floor(offset ?? 1));
  if (start > lines.length) return `(le fichier n'a que ${lines.length} lignes)`;
  const end = limit ? Math.min(lines.length, start - 1 + Math.max(1, Math.floor(limit))) : lines.length;
  let out = "";
  let last = start - 1;
  for (let i = start - 1; i < end; i++) {
    const next = (out ? "\n" : "") + lines[i];
    if (out.length + next.length > MAX_OUTPUT && out) break;
    out += next;
    last = i + 1;
  }
  if (last < lines.length || start > 1) {
    const more = last < lines.length ? ` Suite : offset=${last + 1}.` : "";
    out += `\n\n[lignes ${start}-${last} sur ${lines.length}.${more}]`;
  }
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export function builtinTools(memory: MemoryService, localServer?: LlamaServerSupervisor): ToolDef[] {
  return [
    // Un outil conditionnel : sans superviseur fourni, il n'existe pas plutôt que d'exister vide.
    ...(localServer ? [localServerTool(localServer)] : []),
    {
      name: "list_dir",
      description: "Liste le contenu d'un dossier du dossier de travail (chemin relatif, '.' par défaut).",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      source: "builtin",
      async run(args, ctx) {
        const dir = resolveInWorkspace(ctx, args.path);
        const entries = await readdir(dir, { withFileTypes: true });
        const lines = entries
          .filter((e) => e.name !== ".git" && e.name !== "node_modules")
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return lines.join("\n") || "(dossier vide)";
      },
    },
    {
      name: "read_file",
      description:
        "Lit un fichier texte du dossier de travail. Pour un gros fichier, lis-le par morceaux avec offset (première ligne, à partir de 1) et limit (nombre de lignes).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
        required: ["path"],
      },
      source: "builtin",
      async run(args, ctx) {
        const file = resolveInWorkspace(ctx, args.path);
        const info = await stat(file);
        if (info.size > 20_000_000)
          return `Fichier trop volumineux (${info.size} octets) : utilise search_files ou run_shell pour en extraire une partie.`;
        const buf = await readFile(file);
        if (buf.subarray(0, 8000).includes(0))
          return `Fichier binaire (${info.size} octets) : non lisible comme texte.`;
        return sliceLines(buf.toString("utf8"), args.offset as number | undefined, args.limit as number | undefined);
      },
    },
    {
      name: "write_file",
      description: "Crée ou remplace un fichier texte dans le dossier de travail.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      dangerous: true,
      source: "builtin",
      async run(args, ctx) {
        const file = resolveInWorkspace(ctx, args.path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, String(args.content), "utf8");
        return `Fichier écrit : ${relative(ctx.workspace!, file)} (${String(args.content).length} caractères)`;
      },
    },
    {
      name: "edit_file",
      description: "Remplace une portion exacte et unique d'un fichier du dossier de travail.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
        required: ["path", "old_text", "new_text"],
      },
      dangerous: true,
      source: "builtin",
      async run(args, ctx) {
        const file = resolveInWorkspace(ctx, args.path);
        const text = await readFile(file, "utf8");
        const oldText = String(args.old_text);
        const count = text.split(oldText).length - 1;
        if (count !== 1)
          throw new Error(
            count === 0 ? "Texte à remplacer introuvable." : `Texte trouvé ${count} fois : il doit être unique.`,
          );
        await writeFile(
          file,
          text.replace(oldText, () => String(args.new_text)),
          "utf8",
        );
        return `Fichier modifié : ${relative(ctx.workspace!, file)}`;
      },
    },
    {
      name: "run_shell",
      description:
        "Exécute une commande shell dans le dossier de travail et renvoie sa sortie. Délai : 2 min par défaut (timeout_seconds, 600 max), la commande est ensuite arrêtée. Ne lance pas de serveur qui tourne indéfiniment. " +
        // Without this the model writes bash on Windows (`ls`, `cat`, `grep`), and every command fails.
        (process.platform === "win32"
          ? 'Sous Windows, la commande passe par cmd.exe : syntaxe cmd (dir, type, findstr, &&, variables %X%), pas bash ; pour PowerShell, écrire `powershell -NoProfile -Command "…"`. '
          : "") +
        'Avec isolation:"workspace", la commande doit être retenue dans le dossier de travail : si la machine ne sait pas le tenir, elle est refusée — jamais lancée sans protection.',
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: { type: "integer" },
          secrets: {
            type: "array",
            items: { type: "string" },
            description:
              "Noms de secrets du coffre (vault_list) à fournir à la commande en variables d'environnement. Tu ne vois jamais leur valeur : utilise la variable ($NOM, %NOM% sous cmd), jamais une valeur écrite en clair.",
          },
          isolation: {
            type: "string",
            enum: ["none", "workspace"],
            description:
              "Message « workspace » : écriture limitée au dossier de travail (refus si la plateforme ne peut pas le tenir).",
          },
        },
        required: ["command"],
      },
      dangerous: true,
      source: "builtin",
      async run(args, ctx) {
        const cwd = resolveInWorkspace(ctx, ".");
        const seconds = Math.min(600, Math.max(1, Number(args.timeout_seconds) || 120));
        // Le garde décide AVANT de lancer : autorisé, refusé, ou accord demandé par la porte existante.
        const guard = new ShellGuardService({
          workspace: ctx.workspace,
          policy: ctx.shellGuard,
          approve: ctx.approve,
          sessionId: ctx.sessionId,
        });
        const requested: WriteScope | undefined = args.isolation === "workspace" ? "workspace" : undefined;
        const names = Array.isArray(args.secrets) ? args.secrets.map(String) : [];
        if (names.length && !ctx.vault) throw new Error("Aucun coffre d'identifiants n'est disponible ici.");
        const secrets = names.length && ctx.vault ? ctx.vault.shellEnv(names) : { env: {}, used: [] };
        const envKeys = Object.keys(secrets.env);
        const planned = await guard.plan(
          String(args.command),
          requested ? { writeScope: requested, cwd, envKeys } : { cwd, envKeys },
        );
        // Un refus n'est pas un résultat : il lève. Le refus ne doit jamais pouvoir passer pour une
        // sortie de commande réussie (le cœur le marque alors en erreur, avec la raison écrite).
        if (planned.kind === "refuse") throw new Error(planned.reason);
        const { code, output } = await runShell(
          String(args.command),
          cwd,
          ctx.signal,
          seconds * 1000,
          planned,
          secrets.env,
        );
        const note = planned.mode === "exec" ? `[${planned.detail}]\n` : "";
        // A command that prints its environment must not hand the value to the model.
        return VaultService.redact(`${note}code de sortie : ${code}\n${output}`, secrets.used);
      },
    },
    {
      name: "web_fetch",
      description: "Télécharge une page web (http/https) et renvoie son texte.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      source: "builtin",
      // H3 : l'URL est choisie par le MODÈLE, donc par ce qu'il vient de lire. Sans accord, un contenu non
      // fiable fait partir la mémoire du prompt dans l'URL (`https://x/?d=…`) sans que rien ne s'affiche.
      dangerous: true,
      async run(args, ctx) {
        const start = new URL(String(args.url));
        const { res, url } = await fetchChecked(start, ctx.signal);
        const type = res.headers.get("content-type") ?? "";
        if (/^(image|audio|video)\/|application\/(octet-stream|zip|pdf)/.test(type)) {
          await res.body?.cancel().catch(() => {});
          return `HTTP ${res.status} — ${url.href}\n\nContenu non textuel (${type}).`;
        }
        const { text: body, capped } = await readCapped(res, MAX_FETCH_BYTES);
        const text = type.includes("html") ? htmlToText(body) : body;
        return truncate(
          `HTTP ${res.status} — ${url.href}\n\n${text}${capped ? "\n… [page tronquée]" : ""}`,
          MAX_OUTPUT,
        );
      },
    },
    {
      name: "memory_save",
      description:
        "Enregistre un souvenir durable sur l'utilisateur (fait, préférence ou contexte) pour les futures conversations.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
          type: { type: "string", enum: ["fact", "preference", "context"] },
        },
        required: ["content"],
      },
      source: "builtin",
      async run(args) {
        const m = memory.add(String(args.content), (args.type as MemoryType) ?? "fact");
        return `Mémorisé (${m.type}) : ${m.content}`;
      },
    },
    {
      name: "memory_search",
      description: "Cherche dans la mémoire à long terme.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      source: "builtin",
      async run(args) {
        const hits = memory.search(String(args.query));
        return hits.length ? hits.map((m) => `- [${m.type}] ${m.content}`).join("\n") : "Aucun souvenir correspondant.";
      },
    },
  ];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const decodeEntities = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();

/** Parses DuckDuckGo's HTML results page (no API key needed). */
export function parseDuckDuckGo(html: string, limit = 8): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const b of blocks) {
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    let url = a[1]!.replace(/&amp;/g, "&");
    const redirect = /[?&]uddg=([^&]+)/.exec(url);
    if (redirect) url = decodeURIComponent(redirect[1]!);
    if (url.startsWith("//")) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // sponsored
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(b);
    out.push({ title: decodeEntities(a[2]!), url, snippet: snip ? decodeEntities(snip[1]!) : "" });
    if (out.length >= limit) break;
  }
  return out;
}

export const webSearchTool: ToolDef = {
  name: "web_search",
  description:
    "Recherche sur le web (DuckDuckGo) et renvoie titres, liens et extraits. Utilise web_fetch pour lire une page.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, max_results: { type: "integer" } },
    required: ["query"],
  },
  source: "builtin",
  async run(args, ctx) {
    const q = String(args.query);
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Jarod-One",
      },
      body: new URLSearchParams({ q, kl: "fr-fr" }).toString(),
      signal: withTimeout(ctx.signal, 20_000),
    });
    if (!res.ok) throw new Error(`Recherche indisponible (HTTP ${res.status})`);
    const results = parseDuckDuckGo(await res.text(), Math.min(Number(args.max_results) || 8, 15));
    if (results.length === 0) return `Aucun résultat pour « ${q} ».`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
  },
};

/**
 * Piloter le serveur de modèles local.
 *
 * Le chemin du binaire et le modèle sont des ARGUMENTS, pas des réglages cachés : ici le chemin
 * réel n'est même pas lisible par l'utilisateur courant, donc un défaut serait une invention.
 */
function localServerTool(localServer: LlamaServerSupervisor): ToolDef {
  return {
    name: "local_model_server",
    description:
      "Pilote le serveur de modèles local (llama-server) : status, start (avec bin et model), stop. Jarod n'arrête que le serveur qu'il a lui-même lancé.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "start", "stop"] },
        bin: { type: "string" },
        model: { type: "string" },
        port: { type: "integer" },
      },
      required: ["action"],
    },
    source: "builtin",
    // Démarrer un processus est un effet de bord : il passe par le canal d'approbation.
    dangerous: true,
    async run(args) {
      const action = String(args.action ?? "");
      if (action === "status") {
        const state = localServer.status();
        if (!state.running) return "Aucun serveur lancé par Jarod.";
        return `Serveur ${state.ready ? "prêt" : "en cours de démarrage"} sur le port ${state.port}, modèle ${state.model}, pid ${state.pid}, ${state.restarts} relance(s).`;
      }
      if (action === "stop") {
        return (await localServer.stop())
          ? "Serveur arrêté (seulement celui que Jarod avait lancé)."
          : "Aucun serveur n'était lancé par Jarod : rien n'a été arrêté.";
      }
      if (action === "start") {
        try {
          const state = await localServer.start({
            bin: String(args.bin ?? ""),
            model: String(args.model ?? ""),
            port: Number(args.port ?? 8080),
          });
          return `Serveur prêt sur le port ${state.port}, modèle ${state.model}.`;
        } catch (error) {
          // Un refus lisible plutôt qu'une exception : l'agent doit pouvoir dire pourquoi.
          return `Refusé : ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      return `Action inconnue : ${action}`;
    },
  };
}
