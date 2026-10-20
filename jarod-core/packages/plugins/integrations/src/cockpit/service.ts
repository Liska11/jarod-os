/**
 * Le registre vivant : le catalogue du code (jamais un document), les outils du registre existant, et l'état mesuré par les sondes.
 * Lecture seule : rien ici n'exécute une capacité, rien n'en ajoute à partir d'un texte.
 */
import { COCKPIT_ADAPTERS, COCKPIT_INTEGRATIONS, type Probe, type ProbeContext } from "./catalog.js";
import type { ProbeHost } from "./probe.js";
import type { CapabilityManifest, CapabilityState, CapabilityView, ProbeResult } from "./types.js";

/** Ce que le cockpit lit du service d'outils (une vue, pour ne pas dépendre de plugin-tools). */
export interface ToolsView {
  info(): { name: string; description: string; dangerous: boolean; source: string; enabled: boolean }[];
  spec(name: string): { name: string; description: string; parameters: Record<string, unknown> } | undefined;
}

export interface CapabilityDeps {
  host: ProbeHost;
  tools: ToolsView;
  skills: () => string[];
  mcpServers: () => ProbeContext["mcpServers"];
  /** La porte de permissions existante, pour un nom d'outil. */
  decide: (tool: string) => "allow" | "ask" | "deny";
  now?: () => number;
}

export const PROBE_TTL_MS = 30_000;

export const STATE_LABELS: Record<CapabilityState, string> = {
  unknown: "inconnue",
  "not-installed": "non installée",
  "installed-unconfigured": "installée, non configurée",
  available: "disponible",
  degraded: "dégradée",
  "blocked-permission": "bloquée (permission)",
  error: "en erreur",
};

type Entry = CapabilityManifest & { probe: Probe };

const STOP = new Set(["un", "une", "des", "les", "le", "la", "de", "du", "et", "ou", "a", "au", "aux", "en", "mon", "ma", "mes", "pour", "sur", "par", "avec", "l", "d"]);
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

export class CapabilityService {
  private readonly entries: Entry[] = COCKPIT_INTEGRATIONS.flatMap((i) => i.capabilities);
  private readonly cache = new Map<string, { at: number; result: ProbeResult }>();
  private readonly now: () => number;

  constructor(private readonly deps: CapabilityDeps) {
    this.now = deps.now ?? Date.now;
  }

  async list(): Promise<CapabilityView[]> {
    const own = await Promise.all(this.entries.map((e) => this.view(e, false)));
    return [...own, ...this.toolViews()];
  }

  /** Recherche par intention dans le catalogue : rend seulement ce qui correspond, le plus pertinent d'abord. */
  async search(query: string): Promise<CapabilityView[]> {
    const q = words(query);
    if (!q.length) return [];
    const scored = (await this.list())
      .map((c) => {
        const hay = words([c.name, c.description, ...c.intents, ...c.categories].join(" "));
        const intents = c.intents.map(words);
        let score = 0;
        for (const w of q) {
          if (hay.some((h) => near(h, w))) score += 1;
          if (intents.some((i) => i.some((h) => near(h, w)))) score += 1;
        }
        return { c, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((x) => x.c);
  }

  async describe(id: string): Promise<CapabilityView | null> {
    const e = this.entries.find((x) => x.id === id);
    if (e) return this.view(e, false);
    return this.toolViews().find((t) => t.id === id) ?? null;
  }

  /** Relance la sonde, sans cache. Une capacité inconnue rend l'état `unknown`. */
  async check(id: string): Promise<CapabilityView> {
    const e = this.entries.find((x) => x.id === id);
    if (e) return this.view(e, true);
    const tool = this.toolViews().find((t) => t.id === id);
    if (tool) return tool;
    return { ...UNKNOWN, id, name: id, detail: "capacité inconnue du catalogue", checkedAt: null };
  }

  private async probe(e: Entry, force: boolean): Promise<{ at: number; result: ProbeResult }> {
    const hit = this.cache.get(e.id);
    if (!force && hit && this.now() - hit.at < PROBE_TTL_MS) return hit;
    let result: ProbeResult;
    try {
      result = await e.probe(this.deps.host, { skills: this.deps.skills(), mcpServers: this.deps.mcpServers() });
    } catch (err) {
      result = { state: "error", detail: `la sonde a échoué : ${(err as Error).message}` };
    }
    const fresh = { at: this.now(), result };
    this.cache.set(e.id, fresh);
    return fresh;
  }

  private async view(e: Entry, force: boolean): Promise<CapabilityView> {
    const { probe: _probe, ...manifest } = e;
    const { at, result } = await this.probe(e, force);
    const permissions = Object.fromEntries(e.tools.map((t) => [t, this.deps.decide(t)]));
    const blocked = Object.values(permissions).includes("deny");
    const a = COCKPIT_ADAPTERS.find((x) => x.id === e.owner);
    return {
      ...manifest,
      ...result,
      state: blocked && result.state === "available" ? "blocked-permission" : result.state,
      permissions,
      checkedAt: at,
      ...(a ? { provenance: { repo: a.repo, license: a.license, pinned: a.pinned, status: a.status } } : {}),
    };
  }

  /** Les outils du registre existant, vus comme des capacités : leur état vient du réglage et de la porte de permissions. */
  private toolViews(): CapabilityView[] {
    return this.deps.tools.info().map((t) => {
      const decision = this.deps.decide(t.name);
      const state: CapabilityState = !t.enabled || decision === "deny" ? "blocked-permission" : "available";
      const input = this.deps.tools.spec(t.name)?.parameters;
      return {
        id: `tool.${t.name}`,
        name: t.name,
        description: t.description,
        categories: ["outil"],
        intents: [t.description],
        owner: t.source,
        tools: [t.name],
        integration: "agent-tool",
        ...(input ? { input } : {}),
        output: "texte rendu par l'outil",
        risk: t.dangerous ? "act" : "read",
        sideEffects: t.dangerous ? "effets de bord : accord demandé" : "lecture",
        locality: "local",
        requires: [],
        timeoutMs: 0,
        cancel: "signal d'arrêt de la session",
        verification: "résultat de l'outil, derrière la porte unique",
        artifacts: [],
        limits: ["exécuté seulement par executeGuardedTool"],
        state,
        detail: !t.enabled ? "désactivé dans les réglages" : decision === "deny" ? "refusé par la porte de permissions" : `permission : ${decision}`,
        permissions: { [t.name]: decision },
        checkedAt: this.now(),
      };
    });
  }
}

const UNKNOWN: Omit<CapabilityView, "id" | "name" | "detail" | "checkedAt"> = {
  description: "",
  categories: [],
  intents: [],
  owner: "",
  tools: [],
  integration: "detection-only",
  output: "",
  risk: "read",
  sideEffects: "",
  locality: "local",
  requires: [],
  timeoutMs: 0,
  cancel: "",
  verification: "",
  artifacts: [],
  limits: [],
  state: "unknown",
  permissions: {},
};
