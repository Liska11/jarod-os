/**
 * Commandes intégrées portées de `core.ts` `registerBuiltinCommands` (rév. 2e180305), corps
 * inchangés (`this.` → `core.`), une ligne source par commande. Les commandes dont le service
 * arrive plus tard (curator, hub, goal, pair, plugins, bundle) sont enregistrées par leur plugin.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { MemoryType, ShellPolicy } from "@jarod/contracts";
import { PROVIDERS } from "@jarod/plugin-llm";
import { ShellGuardService } from "@jarod/plugin-permissions";
import { DEFAULT_TITLE } from "./agent.js";
import { budgetRatio, describeBudget, limitsFor } from "./budget.js";
import type { CommandRegistry } from "./commands.js";
import type { AgentRuntime } from "./runtime.js";

/** Ce que les commandes lisent : le runtime, plus l'état MCP (plugin-mcp, Phase 2 ; vide sans lui). */
export type CommandHost = AgentRuntime & { mcp: { list(): { name: string; state: string }[] } };

/**
 * Le texte de `/shell-guard` : ce qui est permis, où, et ce qui exige un accord, mécanisme de confinement de cette machine compris. Exporté pour
 * que l'écran des réglages montre EXACTEMENT ce que la commande montre — sans exécuter de commande (les sites d'appel de `commands.execute`
 * sont recensés : composer et garde seulement).
 */
export function describeShellGuard(s: { workspace: string | null; shellGuard?: Partial<ShellPolicy> | undefined }): string {
  return new ShellGuardService({ workspace: s.workspace, policy: s.shellGuard }).describe();
}

export function registerAgentCommands(core: CommandHost): void {
  // Prologue — core.ts:1794-1806
    const c = core.commands;
    const s = core.settings;
    const need = (id: string | null): string => {
      if (!id) throw new Error("Aucune conversation active");
      return id;
    };
    const add = (
      name: string,
      description: string,
      run: Parameters<CommandRegistry["register"]>[0]["run"],
      usage?: string,
    ) => c.register({ name, description, run, source: "builtin", ...(usage ? { usage } : {}) });

    // /help — core.ts:1807-1815
    add("help", "Liste des commandes", () => ({
      text: c
        .list()
        .map(
          (x) =>
            `- \`/${x.name}\`${x.usage ? ` — \`${x.usage}\`` : ""} : ${x.description}${x.source === "plugin" ? " _(plugin)_" : ""}`,
        )
        .join("\n"),
    }));
    // /new — core.ts:1816-1816
    add("new", "Nouvelle conversation", () => ({ action: "new-session" }));
    // /clear — core.ts:1817-1820
    add("clear", "Efface les messages de la conversation", (_a, ctx) => {
      core.messages.clear(need(ctx.sessionId));
      return { action: "clear" };
    });
    // /retry — core.ts:1821-1821
    add("retry", "Régénère la dernière réponse", () => ({ action: "retry" }));
    // /undo — core.ts:1822-1825
    add("undo", "Annule le dernier échange (le message revient dans la zone de saisie)", (_a, ctx) => {
      const text = core.messages.undoLastTurn(need(ctx.sessionId));
      return text === undefined ? { text: "Rien à annuler." } : { action: "undo", payload: text };
    });
    // /model — core.ts:1826-1845
    add(
      "model",
      "Change de modèle (fournisseur/modèle ou modèle seul)",
      (args, ctx) => {
        if (!args) {
          const cur = ctx.sessionId ? core.agent.settingsFor(ctx.sessionId) : s.getAll();
          return { text: `Modèle actuel : **${cur.activeProvider} / ${cur.activeModel}**` };
        }
        const slash = args.indexOf("/");
        const maybeProvider = slash > 0 ? args.slice(0, slash) : "";
        if (maybeProvider && PROVIDERS.some((p) => p.id === maybeProvider)) {
          s.patch({ activeProvider: maybeProvider, activeModel: args.slice(slash + 1) });
        } else {
          s.set("activeModel", args);
        }
        core.updateSessionContext(ctx.sessionId, { provider: s.get("activeProvider"), model: s.get("activeModel") });
        return { text: `Modèle : **${s.get("activeProvider")} / ${s.get("activeModel")}**`, action: "refresh" };
      },
      "/model anthropic/claude-opus-5",
    );
    // /models — core.ts:1846-1853
    add("models", "Liste les modèles connus du fournisseur actif", () => {
      const def = core.providers.def(s.get("activeProvider"));
      return {
        text: def.models.length
          ? def.models.map((m) => `- \`${m}\``).join("\n")
          : "Aucun modèle en cache : Paramètres → Fournisseurs → Actualiser.",
      };
    });
    // /usage — core.ts:1854-1863
    add("usage", "Tokens et coût estimé de la conversation", (_a, ctx) => {
      const u = core.sessionUsage(need(ctx.sessionId));
      const cost = u.costUsd === null ? "inconnu pour ce modèle" : `~${u.costUsd.toFixed(4)} $`;
      const cached = u.cacheReadTokens
        ? ` (dont ${u.cacheReadTokens.toLocaleString("fr-FR")} lus depuis le cache)`
        : "";
      return {
        text: `**Entrée :** ${u.inputTokens.toLocaleString("fr-FR")} tokens${cached} · **Sortie :** ${u.outputTokens.toLocaleString("fr-FR")} tokens · **Coût :** ${cost}`,
      };
    });
    // /budget — Jarod-cordis (G4, décision 2026-09-28) : plafond de LA conversation ; le réglage
    // global `sessionBudget` reste le plafond par défaut des autres.
    add(
      "budget",
      "Plafond de tokens/coût de la conversation : l'affiche, le relève (0 = aucun), revient au global (reset) ; `global` règle celui de toutes",
      (args, ctx) => {
        const cfg = s.get("sessionBudget");
        let arg = args.trim();
        const global = /^global(\s|$)/.test(arg);
        if (global) arg = arg.slice("global".length).trim();
        const usage = "Usage : /budget <tokens> [<usd>] · /budget reset · /budget global <tokens> [<usd>]";
        const parse = (): { maxTokens?: number; maxCostUsd?: number } => {
          const [tok, usd, extra] = arg.split(/\s+/);
          const num = (v: string | undefined) => (v === undefined ? undefined : Number(v.replace(",", ".")));
          const maxTokens = num(tok);
          const maxCostUsd = num(usd);
          const bad = (n: number | undefined) => n !== undefined && (!Number.isFinite(n) || n < 0);
          if (extra !== undefined || bad(maxTokens) || bad(maxCostUsd) || !Number.isInteger(maxTokens)) {
            throw new Error(usage);
          }
          return { maxTokens, ...(maxCostUsd === undefined ? {} : { maxCostUsd }) };
        };
        if (global) {
          if (arg) s.set("sessionBudget", { ...cfg, ...parse() });
          const g = s.get("sessionBudget");
          const none = g.maxTokens <= 0 && g.maxCostUsd <= 0;
          const parts = [
            ...(g.maxTokens > 0 ? [`${g.maxTokens.toLocaleString("fr-FR")} tokens`] : []),
            ...(g.maxCostUsd > 0 ? [`${g.maxCostUsd} $`] : []),
          ];
          return { text: `**Plafond global (par conversation) :** ${none ? "aucun" : parts.join(" · ")}` };
        }
        const id = need(ctx.sessionId);
        if (arg === "reset") {
          const { [id]: _gone, ...rest } = cfg.perSession ?? {};
          s.set("sessionBudget", { ...cfg, perSession: rest });
        } else if (arg) {
          const { maxTokens, maxCostUsd } = parse();
          const cur = limitsFor(cfg, id);
          s.set("sessionBudget", {
            ...cfg,
            perSession: {
              ...(cfg.perSession ?? {}),
              [id]: { maxTokens: maxTokens ?? cur.maxTokens, maxCostUsd: maxCostUsd ?? cur.maxCostUsd },
            },
          });
        }
        const after = s.get("sessionBudget");
        const limits = limitsFor(after, id);
        const u = core.sessionUsage(id);
        const ratio = budgetRatio(u, limits);
        const own = after.perSession?.[id] ? "propre à cette conversation" : "plafond global";
        return {
          text: `**Plafond (${own}) :** ${describeBudget(u, limits)}${ratio === null ? "" : ` — ${Math.round(ratio * 100)} %`}`,
        };
      },
      "/budget 200000 2.5",
    );
    // /rewind — core.ts:1864-1881
    add(
      "rewind",
      "Annule les modifications de fichiers du dernier tour de l'agent (répéter pour remonter plus loin)",
      (_a, ctx) => {
        const id = need(ctx.sessionId);
        if (core.isRunning(id)) throw new Error("Attendez la fin de la réponse en cours.");
        const r = core.checkpoints.rewind(id);
        if (!r) return { text: "Aucune modification de fichier à annuler dans cette conversation." };
        const lines = [
          ...r.restored.map((p) => `- restauré : \`${p}\``),
          ...r.deleted.map((p) => `- supprimé (créé par l'agent) : \`${p}\``),
        ];
        return {
          text: `Fichiers remis dans leur état précédent :\n${lines.join("\n")}\n\n_Les effets des commandes shell ne sont pas annulés._`,
          action: "refresh",
        };
      },
    );
    // /memory — core.ts:1882-1897
    add(
      "memory",
      "Affiche la mémoire, ou ajoute un souvenir",
      (args) => {
        if (args) {
          const [maybeType, ...rest] = args.split(/\s+/);
          const types: MemoryType[] = ["fact", "preference", "context"];
          const isType = types.includes(maybeType as MemoryType);
          const m = core.memory.add(isType ? rest.join(" ") : args, isType ? (maybeType as MemoryType) : "fact");
          return { text: `Mémorisé (${m.type}) : ${m.content}`, action: "refresh" };
        }
        const all = core.memory.list();
        return { text: all.length ? all.map((m) => `- _${m.type}_ : ${m.content}`).join("\n") : "Mémoire vide." };
      },
      "/memory preference Je préfère des réponses courtes",
    );
    // /persona — core.ts:1898-1902 ; Q4 = A : avec plugin-persona, lit/écrit SOUL.md du profil
    // (le réglage reste le repli affiché tant que le fichier n'existe pas).
    add("persona", "Affiche ou remplace la persona (prompt système)", (args) => {
      if (!args) return { text: `\`\`\`\n${core.persona?.read().trim() || s.get("persona")}\n\`\`\`` };
      if (core.persona) core.persona.write(args);
      else s.set("persona", args);
      return { text: "Persona mise à jour.", action: "refresh" };
    });
    // /tools — core.ts:1903-1908
    add("tools", "Liste les outils disponibles pour l'agent", () => ({
      text: core.tools
        .info(s.get("disabledTools"))
        .map((t) => `- ${t.enabled ? "✅" : "⛔"} \`${t.name}\`${t.dangerous ? " ⚠️" : ""} — ${t.description}`)
        .join("\n"),
    }));
    // /shell-guard — core.ts:1909-1915
    add("shell-guard", "Ce que `run_shell` a le droit de faire : programmes, écritures, accords", (_a, ctx) => {
      // La même politique que celle employée pour décider, lue à la même source : ce qui s'affiche
      // est ce qui s'applique, et rien d'autre.
      const cur = ctx.sessionId ? core.agent.settingsFor(ctx.sessionId) : s.getAll();
      return { text: describeShellGuard(cur) };
    });
    // /skills — core.ts:2046-2052
    add("skills", "Liste les skills", () => ({
      text:
        core.skills
          .list()
          .map((k) => `- ${k.enabled ? "✅" : "⛔"} **${k.name}** (v${k.version}) — ${k.description}`)
          .join("\n") || "Aucune skill.",
    }));
    // /search — core.ts:2135-2147
    add(
      "search",
      "Recherche plein texte dans toutes les conversations",
      (args) => {
        const hits = core.sessions.search(args);
        return {
          text: hits.length
            ? hits.map((h) => `- **${h.title}**${h.snippet ? ` — ${h.snippet}` : ""}`).join("\n")
            : "Aucun résultat.",
        };
      },
      "/search facture",
    );
    // /workspace — core.ts:2148-2163
    add(
      "workspace",
      "Définit le dossier de travail des outils",
      (args, ctx) => {
        if (!args) {
          const cur = ctx.sessionId ? core.agent.settingsFor(ctx.sessionId) : s.getAll();
          return { text: `Dossier de travail : \`${cur.workspace ?? "aucun"}\`` };
        }
        const dir = resolve(args);
        if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Dossier introuvable : ${dir}`);
        s.set("workspace", dir);
        core.updateSessionContext(ctx.sessionId, { workspace: dir });
        return { text: `Dossier de travail : \`${dir}\``, action: "refresh" };
      },
      "/workspace C:\\projets\\demo",
    );
    // /think — core.ts:2164-2173
    add(
      "think",
      "Active/désactive la réflexion étendue",
      (args) => {
        const on = args ? /^(on|oui|1|true)$/i.test(args) : !s.get("thinking");
        s.set("thinking", on);
        return { text: `Réflexion ${on ? "activée" : "désactivée"}.`, action: "refresh" };
      },
      "/think on",
    );
    // /effort — core.ts:2174-2180
    add("effort", "Niveau d'effort : low, medium, high, xhigh, max (vide = défaut)", (args) => {
      const v = args.toLowerCase();
      if (v && !["low", "medium", "high", "xhigh", "max"].includes(v))
        throw new Error("Valeurs : low, medium, high, xhigh, max");
      s.set("effort", v as never);
      return { text: `Effort : ${v || "défaut du modèle"}.`, action: "refresh" };
    });
    // /status — core.ts:2181-2194
    add("status", "État de l'agent", (_a, ctx) => {
      const st = ctx.sessionId && core.sessions.get(ctx.sessionId) ? core.agent.settingsFor(ctx.sessionId) : s.getAll();
      const mcp = core.mcp.list();
      return {
        text: [
          `**Modèle :** ${st.activeProvider} / ${st.activeModel}`,
          `**Réflexion :** ${st.thinking ? "oui" : "non"} · **Effort :** ${st.effort || "défaut"}`,
          `**Dossier de travail :** ${st.workspace ?? "aucun"}`,
          `**Outils :** ${core.tools.all().length} · **Skills actives :** ${core.skills.enabled().length} · **Plugins :** ${core.plugins.list().filter((p) => p.state === "active").length}`,
          `**MCP :** ${mcp.length ? mcp.map((m) => `${m.name} (${m.state})`).join(", ") : "aucun"}`,
          `**Conversation en cours :** ${ctx.sessionId && core.isRunning(ctx.sessionId) ? "génération…" : "inactive"}`,
        ].join("\n"),
      };
    });
    // /version — core.ts:2195-2197
    add("version", "Version de Jarod-One", () => ({
      text: `Jarod-One v${core.appVersion} · Node ${process.versions.node}`,
    }));
    // /settings — core.ts:2198-2198
    add("settings", "Ouvre les paramètres", () => ({ action: "open-settings" }));
    // /plan — core.ts:2199-2203
    add("plan", "Mode Plan : lecture seule, l'agent explore et propose", (_a, ctx) => {
      s.set("agentMode", "plan");
      core.updateSessionContext(ctx.sessionId, { agentMode: "plan" });
      return { text: "Mode **Plan** activé : lecture seule.", action: "refresh" };
    });
    // /build — core.ts:2204-2208
    add("build", "Mode Build : l'agent peut modifier fichiers et lancer des commandes", (_a, ctx) => {
      s.set("agentMode", "build");
      core.updateSessionContext(ctx.sessionId, { agentMode: "build" });
      return { text: "Mode **Build** activé.", action: "refresh" };
    });
    // /compact — core.ts:2209-2216
    // Q18 : `/compact <consigne>` = ce que le résumé doit préserver (SANK-AI `context-compaction`, `preserve`).
    add(
      "compact",
      "Résume l'historique ancien pour libérer du contexte (option : ce qu'il faut préserver)",
      async (args, ctx) => {
      const id = need(ctx.sessionId);
      if (core.isRunning(id)) throw new Error("Attendez la fin de la réponse en cours.");
      const done = await core.agent.compact(id, AbortSignal.timeout(180_000), undefined, args.trim());
      return done
        ? { text: "Contexte compacté : les anciens échanges sont remplacés par un résumé.", action: "clear" }
        : { text: "Conversation trop courte pour être compactée." };
      },
      "/compact les tests qui échouent",
    );
    // /title — core.ts:2217-2225
    add("title", "Régénère le titre de la conversation", async (_a, ctx) => {
      const id = need(ctx.sessionId);
      const msgs = core.messages.list(id);
      const q = msgs.find((m) => m.role === "user" && !m.kind)?.content ?? "";
      const a = [...msgs].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? "";
      if (!q) return { text: "Rien à titrer." };
      await core.agent.generateTitle(id, q, a);
      return { text: `Titre : **${core.sessions.get(id)?.title ?? DEFAULT_TITLE}**`, action: "refresh" };
    });

    // Q19 : ce que ces commandes peuvent faire SANS effet, seul cas où une passerelle les exécute sans
    // accord (`executeGuardedCommand`). Toute commande absente d'ici a un effet — défaut sûr.
    const noArgs = (a: string) => a.trim() === "";
    for (const name of ["help", "models", "usage", "tools", "shell-guard", "skills", "search", "status", "version"]) {
      c.declareReadOnly(name, true);
    }
    for (const name of ["new", "retry", "settings"]) c.declareReadOnly(name, true); // action d'interface seule
    for (const name of ["model", "workspace", "persona", "memory", "budget"]) c.declareReadOnly(name, noArgs);
    c.declareReadOnly("budget", (a) => noArgs(a) || a.trim() === "global");
}
