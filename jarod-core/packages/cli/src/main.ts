// Portage de packages/cli/src/main.ts (rév. 2e180305) — sous-commandes dont les services sont portés
// (ask, sessions, show, search, memory, profiles, events, serve — P3 avec plugin-gateways).
// `mcp` : SPECS-P5-MCP.md ; `acp` : SPECS-P5-ACP.md. Plus aucune commande en attente. `improve` n'est pas porté (décision du 2026-10-02).
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { MemoryType, Settings } from "@jarod/contracts";
import type { AgentHooks } from "@jarod/plugin-agent";
import type { StoredEvent } from "@jarod/plugin-storage";
import { type CliCore as JarodCore, defaultDataRoot, openCore } from "./context.js";
import { acpCommand } from "./acp-agent.js";
import { defaultDiagnosticsName, diagnosticsCommand } from "./diagnostics.js";
import { headlessCommand } from "./headless.js";
import { collectHealth, healthExitCode, renderHealth } from "./health.js";
import { mcpCommand } from "./mcp-server.js";
import { overrideSettings } from "./settings-override.js";
import { serve } from "./serve.js";
import { upstreamWatch } from "./upstream-watch.js";

const VERSION = "0.1.0";
const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);

export const HELP = `Jarod-One ${VERSION} — en ligne de commande

Usage :
  jarod ask [options] "question"   Pose une question à l'agent (dossier courant = dossier de travail)
  jarod sessions [--limit N]       Liste les conversations
  jarod show <id>                  Affiche une conversation
  jarod search <texte>             Recherche plein texte dans l'historique
  jarod memory                     Affiche la mémoire
  jarod memory add [type] <texte>  Ajoute un souvenir (fact, preference, context)
  jarod profiles                   Liste les profils
  jarod health [--json]            Diagnostic de l'installation (code 1 si dégradée)
  jarod diagnostics [--out F.zip]  Archive ZIP minimale à joindre à un rapport de bug
  jarod events [--stream S] [--type T] [--follow]   Journal d'événements
  jarod headless [start|status|stop]  Instance en arrière-plan (sans fenêtre ni icône)
  jarod serve                      Démon sans Electron (serveur, conteneur, service) : bots,
                                   tâches planifiées, déclencheurs ; arrêt : Ctrl-C ou jarod headless stop
  jarod upstream watch [--dry-run] [--repo O/R] [--since D] [--root R] [--max-details N]
                                   Veille des dépôts amont (api.github.com, lecture seule) : rapport dans docs/upstream-watch/,
                                   curseur dans upstream.json ; GITHUB_TOKEN (environnement) facultatif, GH_TOKEN refusé ; aucun code amont copié
  jarod mcp                        Serveur MCP (stdio, lecture seule) : mémoire et historique pour un client que VOUS configurez
                                   (démarrage manuel seulement ; lisez l'avertissement ci-dessous)
  jarod acp                        Agent ACP (stdio) : Jarod comme agent dans Zed, JetBrains… (lancé par l'éditeur ; accords dans l'éditeur)

AVERTISSEMENT — jarod mcp : le déclarer dans un client MCP (Claude Code, Cursor…) donne à ce client, donc à son fournisseur
de modèle, accès à TOUTE la mémoire et à TOUT l'historique des conversations (textes de l'utilisateur et de l'assistant) du
profil servi. Lecture seule, aucun outil d'écriture ni d'envoi. L'expurgation des clés et jetons est un filet imparfait.
Démarrage manuel seulement : Jarod ne le lance jamais de lui-même. stdio seulement : aucun port réseau n'est ouvert.

jarod acp : à déclarer dans votre éditeur (Zed, JetBrains…). Chaque outil sensible demande votre accord DANS l'éditeur (autoriser une
fois / refuser, jamais « toujours ») ; sans réponse en 300 s, c'est refusé. Les serveurs MCP et les fichiers de l'éditeur ne sont pas utilisés ;
Jarod lit et écrit dans le dossier du projet ouvert. Démarrage manuel seulement, stdio seulement.

Options de ask :
  -c, --continue        Continue la dernière conversation CLI
  --session <id>        Continue une conversation précise
  --model <fournisseur/modèle>   Modèle pour cette commande (ex. anthropic/claude-opus-5)
  --plan                Mode Plan (lecture seule)
  -y, --yes             Approuve automatiquement les outils sensibles
Options globales :
  --profile <nom>       Profil à utiliser

Clés API : variables d'environnement (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY…).
Jetons des messageries (serve) : DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN ; Telegram : coffre du profil
(écran Passerelles du desktop), jamais l'environnement.
Données : JAROD_HOME, sinon le dossier de l'application de bureau.`;

/** Commandes annoncées par l'aide mais pas encore portées (SPECS-P5-CLI.md) : chaque livraison retire la sienne d'ici ET la marque de l'aide. */
export const PENDING_COMMANDS: readonly string[] = [];

export interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const withValue = new Set(["session", "model", "profile", "limit", "out", "type", "after", "stream", "config", "since", "root", "max-details", "repo"]);
  const aliases: Record<string, string> = { c: "continue", y: "yes", h: "help", v: "version" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
    if (m && !/^-\d/.test(a)) {
      const name = aliases[m[1]!] ?? m[1]!;
      if (m[2] !== undefined) flags[name] = m[2];
      else if (withValue.has(name) && argv[i + 1] !== undefined) flags[name] = argv[++i]!;
      else flags[name] = true;
    } else positional.push(a);
  }
  return { command: positional.shift() ?? "help", positional, flags };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function ask(core: JarodCore, dataDir: string, args: Args): Promise<number> {
  const question = [args.positional.join(" "), await readStdin()].filter(Boolean).join("\n\n");
  if (!question) {
    console.error('Question manquante. Exemple : jarod ask "Résume ce dossier"');
    return 2;
  }
  const overrides: Partial<Settings> = { workspace: process.cwd(), autoTitle: false };
  if (typeof args.flags.model === "string") {
    const [provider, ...rest] = args.flags.model.split("/");
    if (rest.length) Object.assign(overrides, { activeProvider: provider, activeModel: rest.join("/") });
    else overrides.activeModel = args.flags.model;
  }
  if (args.flags.plan) overrides.agentMode = "plan";
  overrideSettings(core, overrides);
  await core.skills.reload();

  const lastFile = join(dataDir, "cli-last-session.txt");
  let sessionId = typeof args.flags.session === "string" ? args.flags.session : null;
  if (!sessionId && args.flags.continue) {
    try {
      sessionId = readFileSync(lastFile, "utf8").trim() || null;
    } catch {
      sessionId = null;
    }
  }
  if (!sessionId || !core.sessions.get(sessionId)) {
    sessionId = core.sessions.create(`\u{1F4BB} ${question.replace(/\s+/g, " ").slice(0, 50)}`).id;
  }
  writeFileSync(lastFile, sessionId);
  // A continued conversation runs in the current folder (and with --model / --plan when given).
  core.updateSessionContext(sessionId, {
    workspace: process.cwd(),
    ...(overrides.activeProvider ? { provider: overrides.activeProvider } : {}),
    ...(overrides.activeModel ? { model: overrides.activeModel } : {}),
    ...(overrides.agentMode ? { agentMode: overrides.agentMode } : {}),
  });

  let exitCode = 0;
  let streamed = false;
  const hooks: AgentHooks = {
    emit: (e) => {
      if (e.type === "delta" && e.text) {
        process.stdout.write(e.text);
        streamed = true;
      } else if (e.type === "tool-start") {
        process.stderr.write(
          dim(`${streamed ? "\n" : ""}  ⚙ ${e.call.name} ${JSON.stringify(e.call.args).slice(0, 120)}\n`),
        );
        streamed = false;
      } else if (e.type === "status") {
        process.stderr.write(dim(`  … ${e.status}\n`));
      } else if (e.type === "error") {
        process.stderr.write(red(`\nErreur : ${e.error}\n`));
        exitCode = 1;
      }
    },
    approve: async (_s, call, description) => {
      if (args.flags.yes) return true;
      if (!process.stdin.isTTY) {
        process.stderr.write(red(`  ✗ ${call.name} refusé (utilisez --yes pour autoriser sans confirmation)\n`));
        return false;
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(
        `\n${bold(`Autoriser ${call.name} ?`)} ${dim(description)}\n${dim(JSON.stringify(call.args, null, 2).slice(0, 800))}\n[o/N] `,
      );
      rl.close();
      return /^(o|oui|y|yes)$/i.test(answer.trim());
    },
  };
  await core.runAndWait(sessionId, question, hooks);
  process.stdout.write("\n");
  return exitCode;
}

const formatEvent = (event: StoredEvent): string =>
  `${dim(String(event.seq).padStart(7))} ${dim(new Date(event.at).toISOString())} ${bold(event.stream)} ${
    event.type
  } ${dim(JSON.stringify(event.data).slice(0, 200))}`;

/** `jarod events --follow`: prints entries as they are appended, until Ctrl+C. */
function followEvents(core: JarodCore): Promise<void> {
  process.stderr.write(dim("… suivi du journal (Ctrl+C pour quitter)\n"));
  const stop = core.events.subscribe((event) => console.log(formatEvent(event)));
  return new Promise((resolve) => {
    process.once("SIGINT", () => {
      stop();
      resolve();
    });
  });
}

/** `upstream` : `fetch` ferme ses connexions en tâche de fond ; `process.exit()` à ce moment fait échouer libuv sous Windows (assertion UV_HANDLE_CLOSING) — sortie naturelle. */
let naturalExit = false;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (args.command === "help" || args.flags.help) {
    console.log(HELP);
    return 0;
  }
  if (PENDING_COMMANDS.includes(args.command)) {
    console.error(`« jarod ${args.command} » : pas encore disponible.`);
    return 2;
  }
  // stdout carries the JSON-RPC stream in protocol modes: route stray logs (plugins…) to stderr.
  if (args.command === "mcp" || args.command === "acp") console.log = console.info = console.debug = console.error;
  // `health` : lecture seule, sans verrou ni cœur (SPECS-P5-CLI.md) — l'installation peut être cassée au point que le cœur ne s'ouvre pas.
  if (args.command === "health") {
    const report = collectHealth({
      dataRoot: defaultDataRoot(),
      ...(typeof args.flags.profile === "string" ? { profile: args.flags.profile } : {}),
    });
    console.log(args.flags.json ? JSON.stringify(report, null, 2) : renderHealth(report));
    return healthExitCode(report);
  }
  // `diagnostics` : archive minimale (liste blanche), sans verrou ni cœur ; n'écrase jamais un fichier existant.
  if (args.command === "diagnostics") {
    return diagnosticsCommand({
      dataRoot: defaultDataRoot(),
      version: VERSION,
      ...(typeof args.flags.profile === "string" ? { profile: args.flags.profile } : {}),
      out: typeof args.flags.out === "string" ? args.flags.out : join(process.cwd(), defaultDiagnosticsName()),
    });
  }
  // `upstream` : requêtes GET vers api.github.com ; n'écrit que upstream.json et docs/upstream-watch/ ; ni cœur, ni profil, ni verrou.
  if (args.command === "upstream") {
    if (args.positional[0] !== "watch") {
      console.error("Usage: jarod upstream watch [--dry-run] [--repo <propriétaire/dépôt>] [--since <date ISO>] [--root <dossier>] [--max-details N]");
      return 2;
    }
    const maxDetails = typeof args.flags["max-details"] === "string" ? Number(args.flags["max-details"]) : undefined;
    if (maxDetails !== undefined && !(Number.isInteger(maxDetails) && maxDetails >= 0)) {
      console.error("--max-details : entier positif ou nul attendu.");
      return 2;
    }
    naturalExit = true;
    return upstreamWatch({
      ...(typeof args.flags.root === "string" ? { root: args.flags.root } : {}),
      ...(typeof args.flags.repo === "string" ? { repo: args.flags.repo } : {}),
      ...(typeof args.flags.since === "string" ? { since: args.flags.since } : {}),
      ...(maxDetails !== undefined ? { maxDetails } : {}),
      dryRun: args.flags["dry-run"] === true,
    });
  }
  // `acp` : agent stdio pour un éditeur (SPECS-P5-ACP.md) ; contrôle de schéma avant tout, jamais de migration.
  if (args.command === "acp") {
    return acpCommand({
      dataRoot: defaultDataRoot(),
      version: VERSION,
      ...(typeof args.flags.profile === "string" ? { profile: args.flags.profile } : {}),
    });
  }
  // `mcp` : serveur stdio en LECTURE SEULE (SPECS-P5-MCP.md) ; contrôle de schéma avant tout, jamais de migration.
  if (args.command === "mcp") {
    return mcpCommand({
      dataRoot: defaultDataRoot(),
      version: VERSION,
      ...(typeof args.flags.profile === "string" ? { profile: args.flags.profile } : {}),
    });
  }
  // `headless` : lit/écrit le seul fichier d'état et lance `jarod serve` ; jamais de cœur ouvert ici (un démon le tiendrait).
  if (args.command === "headless") {
    return headlessCommand(args.positional[0], {
      dataRoot: defaultDataRoot(),
      version: VERSION,
      ...(typeof args.flags.profile === "string" ? { profile: args.flags.profile } : {}),
    });
  }
  // File-only commands run before the core opens: a background instance is often inspected precisely
  // because the database cannot be opened.
  // main.ts:425-430 (rév. 2e180305)
  if (args.command === "serve") {
    return serve({
      version: VERSION,
      ...(typeof args.flags.profile === "string" ? { profile: args.flags.profile } : {}),
    });
  }

  const { core, dataDir, profile } = await openCore(
    typeof args.flags.profile === "string" ? { profile: args.flags.profile } : {},
  );

  switch (args.command) {
    case "ask":
      return ask(core, dataDir, args).finally(() => core.dispose());
    case "sessions": {
      for (const s of core.sessions.list(Number(args.flags.limit) || 20)) {
        console.log(
          `${dim(s.id)}  ${s.title}  ${dim(`${s.messageCount} msg · ${new Date(s.updatedAt).toLocaleString()}`)}`,
        );
      }
      break;
    }
    case "show": {
      const s = args.positional[0] && core.sessions.get(args.positional[0]);
      if (!s) {
        console.error("Conversation introuvable.");
        await core.dispose();
        return 1;
      }
      console.log(bold(`# ${s.title}\n`));
      for (const m of core.messages.list(s.id)) {
        if (m.role === "user") console.log(`${bold("Vous :")} ${m.content}\n`);
        else if (m.role === "assistant" && m.content) console.log(`${bold("Jarod :")} ${m.content}\n`);
        else if (m.role === "tool") console.log(dim(`  ⚙ ${m.toolName}\n`));
      }
      break;
    }
    case "search": {
      const hits = core.sessions.search(args.positional.join(" "));
      if (hits.length === 0) console.log("Aucun résultat.");
      for (const h of hits)
        console.log(`${dim(h.sessionId)}  ${bold(h.title)}${h.snippet ? `\n    ${h.snippet}` : ""}`);
      break;
    }
    case "memory": {
      if (args.positional[0] === "add") {
        const types: MemoryType[] = ["fact", "preference", "context"];
        const [maybeType, ...rest] = args.positional.slice(1);
        const isType = types.includes(maybeType as MemoryType);
        const text = (isType ? rest : args.positional.slice(1)).join(" ");
        const m = core.memory.add(text, isType ? (maybeType as MemoryType) : "fact");
        console.log(`Mémorisé (${m.type}) : ${m.content}`);
      } else {
        const all = core.memory.list();
        if (all.length === 0) console.log("Mémoire vide.");
        for (const m of all) console.log(`${dim(`[${m.type}]`)} ${m.content}`);
      }
      break;
    }
    case "profiles":
      console.log(`Profil actif : ${bold(profile)}`);
      break;
    case "events": {
      const list = core.events.list({
        limit: Number(args.flags.limit) || 50,
        ...(typeof args.flags.stream === "string" ? { stream: args.flags.stream } : {}),
        ...(typeof args.flags.type === "string" ? { type: args.flags.type } : {}),
        ...(Number(args.flags.after) > 0 ? { after: Number(args.flags.after) } : {}),
      });
      if (list.length === 0) console.log("Aucun événement.");
      for (const event of list) console.log(formatEvent(event));
      if (args.flags.follow) {
        console.log(dim(`\n… suite à partir de #${list.at(-1)?.seq ?? 0}`));
        await followEvents(core);
        await core.dispose();
        return 0;
      }
      break;
    }
    default:
      console.error(`Commande inconnue : ${args.command}\n\n${HELP}`);
      await core.dispose();
      return 2;
    case "portability": {
      const bundleDir = args.positional[1];
      if (args.positional[0] !== "apply" || !bundleDir) {
        console.error("Usage: jarod portability apply <bundle-dir> [--approve-mcp]");
        await core.dispose();
        return 2;
      }
      const { portabilityApply } = await import("./portability.js");
      const code = await portabilityApply(core, {
        bundleDir,
        profile,
        approveMcp: args.flags["approve-mcp"] === true
      });
      await core.dispose();
      return code;
    }
  }
  await core.dispose();
  return 0;
}

if (!process.env.VITEST) {
  main().then(
    (code) => {
      if (code < 0) return;
      if (naturalExit) process.exitCode = code;
      else process.exit(code);
    },
    (e: Error) => {
      console.error(red(e.message));
      process.exit(1);
    },
  );
}
