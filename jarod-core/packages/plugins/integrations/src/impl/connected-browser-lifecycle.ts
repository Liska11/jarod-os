/**
 * E2 — le CYCLE DE VIE dans l'application. L'application (la passerelle) appelle `startConnectedBrowserLifecycle` UNE fois au démarrage :
 *  - rien n'est branché et aucun navigateur ne démarre tant que le réglage de l'utilisateur n'est pas activé avec au moins un domaine ET que le moteur
 *    n'est pas trouvé (par défaut : éteint, vide, donc l'outil `connected_browser` n'existe pas) ;
 *  - un changement de réglage (écran, import, fichier) rebranche ou débranche l'outil SANS redémarrage, et révoque aussitôt la session qui n'est plus permise ;
 *  - à l'arrêt de l'application, la session est révoquée (navigateur et profil détruits) ;
 *  - au démarrage, les sessions abandonnées par un plantage de CETTE application sont retirées (voir `sweepStaleSessions` : marqueur de propriété exigé).
 *
 * Le moteur n'est cherché que dans la racine désignée par l'hôte (jamais ailleurs) ; sans racine, E2 reste « moteur absent ».
 */
import { discoverEnginePaths, type EnginePaths, type Preparation, prepareConnectedBrowser, type ConnectedBrowserHost, type ConnectedBrowserHostDeps, type HostStatus } from "./connected-browser-host.js";
import { sweepStaleSessions } from "./browser-engine.js";
import type { BrowserAuditEntry } from "./browser.js";

export interface LifecycleDeps {
  /** `ToolsService` (structurel). */
  tools: { attachConnectedBrowser(port: ConnectedBrowserHost): () => void; approveConnectedBrowser: ConnectedBrowserHostDeps["approve"] };
  /** Le magasin de réglages du noyau. */
  settings: { get(key: "connectedBrowser"): unknown; onChange(key: "connectedBrowser", cb: () => void): () => void };
  /** Racine qui contient `engines/browser-harness` et `jarod-core/sidecars/browser-bridge` ; absente = moteur absent. */
  engineRoot?: string;
  engine?: () => EnginePaths | null;
  audit?: (entry: BrowserAuditEntry) => void;
  log?: (line: string) => void;
  /** Pour les essais. */
  hostOverrides?: Partial<ConnectedBrowserHostDeps>;
}

export interface Lifecycle {
  /** Ce que l'hôte voit : « désactivé », « moteur absent », « prêt », « en cours »… */
  status(): HostStatus;
  /** Rejoue la décision (le réglage vient de changer) et attend qu'elle soit appliquée. */
  sync(): Promise<void>;
  stop(): Promise<void>;
}

export function startConnectedBrowserLifecycle(d: LifecycleDeps): Lifecycle {
  const engine = d.engine ?? (() => (d.engineRoot ? discoverEnginePaths({ root: d.engineRoot }) : null));
  const log = d.log ?? (() => undefined);
  try {
    const swept = sweepStaleSessions();
    if (swept.length) log(`navigateur connecté : ${swept.length} session(s) abandonnée(s) par un arrêt brutal retirée(s)`);
  } catch {
    /* le balayage n'est jamais bloquant */
  }
  const hostDeps: ConnectedBrowserHostDeps = {
    settings: () => d.settings.get("connectedBrowser"),
    engine,
    approve: d.tools.approveConnectedBrowser,
    audit: (e) => {
      d.audit?.(e);
      log(`navigateur connecté : ${e.op} ${e.host ?? "-"} ${e.ok ? "ok" : `refusé (${e.reason ?? "?"})`}${e.closedTabs ? ` · ${e.closedTabs} onglet(s) fermé(s)` : ""}`);
    },
    ...d.hostOverrides,
  };
  let prep: Preparation | null = null;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();

  const apply = async (): Promise<void> => {
    if (stopped) return;
    const probe = prepareProbe(hostDeps);
    if (probe === "ready" && !prep) {
      prep = prepareConnectedBrowser(d.tools, hostDeps);
      if (!prep.attached) prep = null;
      else log("navigateur connecté : outil branché (aucun navigateur lancé avant le premier accord)");
    } else if (probe !== "ready" && prep) {
      const old = prep;
      prep = null;
      await old.detach();
      log(`navigateur connecté : outil retiré, session révoquée (${probe})`);
    } else if (prep?.host) {
      await prep.host.reconcile();
    }
  };
  const sync = (): Promise<void> => {
    chain = chain.then(apply, apply);
    return chain;
  };

  const off = d.settings.onChange("connectedBrowser", () => void sync());
  void sync();

  return {
    status: () => prep?.host?.status() ?? statusWithoutHost(hostDeps),
    sync,
    stop: async () => {
      stopped = true;
      off();
      await chain.catch(() => undefined);
      const old = prep;
      prep = null;
      await old?.detach();
    },
  };
}

type Probe = "ready" | "désactivé" | "aucun domaine" | "moteur absent";

function prepareProbe(deps: ConnectedBrowserHostDeps): Probe {
  const probe = { attachConnectedBrowser: () => () => undefined };
  const p = prepareConnectedBrowser(probe, { ...deps, engine: deps.engine });
  if (p.attached) return "ready";
  return p.reason.includes("moteur") ? "moteur absent" : p.reason.includes("domaine") ? "aucun domaine" : "désactivé";
}

function statusWithoutHost(deps: ConnectedBrowserHostDeps): HostStatus {
  const probe = prepareProbe(deps);
  return { state: probe === "moteur absent" ? "no-engine" : "disabled", reason: probe === "moteur absent" ? "moteur ou navigateur d'essai non installé" : probe, blocked: 0 };
}
