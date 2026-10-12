/**
 * @jarod/plugin-tools — `ctx.tools` : registre d'outils (noms inchangés : compatibilité skills
 * Hermes), recherche d'outils, SSH. Enregistre les familles sans dépendance à l'agent, dans l'ordre
 * de `core.ts:458,521-522,552`. Les familles liées à l'agent (délégation, sessions, tool_search,
 * cron, present) sont enregistrées par plugin-agent.
 */
import type {} from "@jarod/plugin-llm";
import type {} from "@jarod/plugin-memory";
import type {} from "@jarod/plugin-rag";
import type {} from "@jarod/plugin-skills";
import type {} from "@jarod/plugin-storage";
import type { ShellApprover } from "@jarod/plugin-permissions";
import { type Context, Service } from "cordis";
import { annotationTools } from "./annotations-tools.js";
import { builtinTools, webSearchTool } from "./builtin.js";
import { type BrowserPort, browserTools } from "./browser-tools.js";
import { profileTools } from "./profile-tools.js";
import { ragTools } from "./rag-tools.js";
import { systemActTools } from "./system/act.js";
import { systemDestroyTools } from "./system/destroy.js";
import { systemReadTools } from "./system/tools.js";
import { ToolRegistry } from "./registry.js";
import { searchTools } from "./search.js";
import { skillHubTools } from "./skills-hub-tools.js";
import { SshService } from "./ssh.js";
import { SshHostsService } from "./ssh-hosts.js";
import { ToolSearchService } from "./tool-search.js";
import { vaultTools } from "./vault-tools.js";
import { LspManager, lspTools } from "./lsp.js";

export * from "./annotations-tools.js";
export * from "./browser-tools.js";
export * from "./builtin.js";
export * from "./console-text.js";
export * from "./lsp.js";
export * from "./present.js";
export * from "./profile-tools.js";
export * from "./rag-tools.js";
export * from "./registry.js";
export * from "./search.js";
export * from "./skills-hub-tools.js";
export * from "./skills-tools.js";
export * from "./ssh.js";
export * from "./ssh-hosts.js";
export { systemReadTools, type SystemToolDeps } from "./system/tools.js";
export { systemActTools, type Launcher, type SystemActDeps } from "./system/act.js";
export { systemDestroyTools, type SystemDestroyDeps } from "./system/destroy.js";
export * from "./tool-search.js";
export * from "./tool-search-tools.js";
export * from "./vault-tools.js";

declare module "cordis" {
  interface Context {
    tools: ToolsService;
  }
}

export class ToolsService extends Service {
  static readonly inject = ["storage", "memory", "llm", "skills", "skillsHub", "rag"];
  readonly registry = new ToolRegistry();
  readonly toolSearch = new ToolSearchService();
  /**
   * Exécution de commandes sur une machine distante par SSH. Rien n'est lancé tant qu'aucune
   * session n'est ouverte ; la vérification des clés d'hôte reste active et aucun secret n'y entre.
   */
  readonly ssh = new SshService();
  readonly sshHosts: SshHostsService;
  private browserPort: BrowserPort | null = null;

  readonly lsp: LspManager;

  constructor(ctx: Context) {
    super(ctx, "tools");
    this.sshHosts = new SshHostsService(ctx.storage.settings, this.ssh);
    const approve = (ctx.get("approve") as { approve: ShellApprover } | undefined)?.approve ?? null;
    this.lsp = new LspManager(ctx.storage.settings, approve);
    const r = this.registry;
    for (const t of vaultTools()) r.register(t);
    for (const t of builtinTools(ctx.memory.memory, ctx.llm.localServer)) r.register(t);
    for (const t of searchTools()) r.register(t);
    // Registered even when the feature is off, but OFFERED to the model only while it is on (`available`, relu à chaque étape : allumer
    // l'interrupteur ne demande aucun redémarrage ; SPECS-P5-UI-PARITE.md § 19). Un appel quand même reçoit le refus du service. (core.ts:525-527)
    for (const t of ragTools(ctx.rag.rag)) r.register(t);
    r.register(webSearchTool);
    for (const t of annotationTools(ctx.memory.annotations)) r.register(t);
    // `skillTools(skills, curator)` (core.ts:573) : enregistré par plugin-agent, qui porte le curator.
    for (const t of skillHubTools(ctx.skillsHub)) r.register(t);
    for (const t of profileTools(ctx.memory.userProfile)) r.register(t);
    // SPECS-P5-LSP.md : outils LSP enregistrés, serveurs ne démarrent que sur accord (G1)
    for (const t of lspTools(this.lsp)) r.register(t);
    // Outils système, phase 1 (lecture seule, Windows) : sans accord par appel, mais chaque appel est audité (`audited`).
    for (const t of systemReadTools()) r.register(t);
    // Phase 2 (actions réversibles) : `dangerous`, donc un accord à chaque appel ; `system_state` seul est une lecture.
    for (const t of systemActTools()) r.register(t);
    // Phase 3 (modification et destruction) : `dangerous`, refus des emplacements protégés AVANT toute demande (`precheck`).
    for (const t of systemDestroyTools()) r.register(t);
  }

  /**
   * Branche le navigateur de l'agent (SPECS-P5-UI-PARITE.md §6). L'hôte qui a une fenêtre le fait ; sans cet appel (CLI, sans fenêtre), les
   * outils `browser_*` n'existent pas. Rend le détachement : les outils disparaissent et le port est fermé.
   */
  attachBrowser(port: BrowserPort): () => void {
    this.detachBrowser();
    this.browserPort = port;
    const offs = browserTools(() => this.browserPort).map((t) => this.registry.register(t));
    return () => {
      for (const off of offs) off();
      if (this.browserPort === port) {
        this.browserPort = null;
        void port.close().catch(() => {});
      }
    };
  }

  private detachBrowser(): void {
    const old = this.browserPort;
    if (!old) return;
    this.registry.unregisterWhere((t) => t.name.startsWith("browser_") && t.source === "builtin");
    this.browserPort = null;
    void old.close().catch(() => {});
  }

  /** SPECS-P5-LSP.md § 2.1 : arrêt des serveurs de langage à la fermeture du noyau. */
  async dispose(): Promise<void> {
    await this.lsp.stopAll();
  }
}

export default ToolsService;
