/**
 * E2 — la GARDE RÉSEAU du navigateur jetable : aucune requête hors politique ne PART.
 *
 * Un client CDP (WebSocket du navigateur, sans dépendance) s'attache à chaque cible (onglet, trame, travailleur, service worker) AVANT
 * sa première requête (`waitForDebuggerOnStart`), active `Fetch` sur `*` et tranche chaque requête, redirections comprises, avec la même
 * règle que le contrôleur (`urlPermitted`). Ce qui n'est pas permis est refusé (`failRequest`) AVANT d'atteindre le réseau.
 *
 * Fail-closed :
 *  - la garde n'existe qu'après une SONDE : une cible-canari vers un hôte interdit doit être vue puis refusée, sinon le démarrage échoue ;
 *  - une cible sur laquelle `Fetch` n'a pas pu être activé est fermée et la garde devient « non saine » : le moteur refuse alors tout ;
 *  - la perte de la connexion CDP rend la garde non saine.
 *
 * Non couvert par `Fetch` (voir `launchDisposableBrowser` pour le filet réseau et `adapters.ts` pour le détail) : WebSocket, préconnexions,
 * WebTransport/QUIC, WebRTC. Le filet : un proxy mort pour tout ce qui n'est pas explicitement dans la liste blanche.
 */
import { AdapterRefused, AdapterUnavailable } from "./common.js";

const A = "E2";
/** Hôte réservé (.invalid ne se résout jamais) : la cible-canari vers lui DOIT être refusée, sinon l'interception ne marche pas. */
export const CANARY_URL = "http://jarod-canary.invalid/";

export interface GuardBlock {
  /** Hôte seulement (jamais le chemin ni la requête de l'adresse). */
  host: string;
  resourceType: string;
}

export interface NetworkGuardOptions {
  /** http://127.0.0.1:<port> du navigateur jetable. */
  cdpUrl: string;
  /** La règle de domaines (la même que celle du contrôleur). */
  permits: (url: string) => boolean;
  /** Pour compter/journaliser les refus (hôte seulement). */
  onBlock?: (b: GuardBlock) => void;
  /** Appelée UNE fois, au moment où la garde cesse d'être saine (perte de la connexion, cible non gardable, révocation). L'hôte y arrête la session. */
  onUnhealthy?: (why: string) => void;
  timeoutMs?: number;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
  sessionId?: string;
}

// Cibles dont une session `Fetch` DOIT être gardée. Un travailleur dédié (« worker ») n'a pas de domaine Fetch : ses requêtes passent par la session
// de la page qui l'a créé (MESURÉ : le témoin n'est jamais atteint par `fetch`/`importScripts` d'un travailleur, voir le test « sous-ressources »).
const NEEDS_FETCH = new Set(["page", "iframe", "shared_worker", "service_worker"]);

export class NetworkGuard {
  readonly stats = { allowed: 0, blocked: 0 };
  private ok = true;
  private why = "";
  private seq = 0;
  private readonly pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private canarySeen = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly o: NetworkGuardOptions,
  ) {
    ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
    ws.addEventListener("close", () => this.fail("connexion CDP de la garde perdue"));
    ws.addEventListener("error", () => this.fail("erreur de la connexion CDP de la garde"));
  }

  /** Vrai tant que l'interception est certainement en place. Le moteur le vérifie avant CHAQUE opération. */
  get healthy(): boolean {
    return this.ok;
  }
  get reason(): string {
    return this.why;
  }

  private fail(why: string): void {
    const first = this.ok;
    if (first) this.why = why;
    this.ok = false;
    if (first) {
      try {
        this.o.onUnhealthy?.(why);
      } catch {
        /* l'arrêt de la session ne doit pas dépendre de ce rappel */
      }
    }
    for (const p of this.pending.values()) p.rej(new Error(why));
    this.pending.clear();
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    return new Promise((res, rej) => {
      if (this.ws.readyState !== 1) return rej(new Error("CDP fermé"));
      const id = ++this.seq;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  private onMessage(raw: string): void {
    let m: CdpMessage;
    try {
      m = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message ?? "erreur CDP"));
      else p.res(m.result);
      return;
    }
    if (m.method === "Fetch.requestPaused") void this.decide(m);
    else if (m.method === "Target.attachedToTarget") void this.adopt(m);
  }

  private async decide(m: CdpMessage): Promise<void> {
    const p = m.params as { requestId: string; request: { url: string; headers?: Record<string, string> }; resourceType?: string };
    const url = p.request.url;
    let allowed = false;
    try {
      allowed = this.ok && this.o.permits(url);
    } catch {
      allowed = false;
    }
    // AUCUN service worker : un travailleur de ce genre survit à la page, redémarre seul et fait ses propres requêtes. On refuse son script
    // (en-tête `Service-Worker: script`) : l'inscription échoue, il n'existe donc jamais de contexte réseau hors de la page à garder.
    const hdr = (n: string) => Object.entries(p.request.headers ?? {}).find(([k]) => k.toLowerCase() === n)?.[1]?.toLowerCase();
    const isServiceWorkerScript = hdr("service-worker") === "script" || hdr("sec-fetch-dest") === "serviceworker";
    if (isServiceWorkerScript) allowed = false;
    if (url === CANARY_URL) {
      this.canarySeen = true;
      allowed = false;
    } else if (!allowed) {
      this.stats.blocked++;
      if (isServiceWorkerScript) p.resourceType = "ServiceWorker";
      let host = "?";
      try {
        host = new URL(url).hostname;
      } catch {
        /* hôte illisible */
      }
      this.o.onBlock?.({ host, resourceType: p.resourceType ?? "?" });
    } else {
      this.stats.allowed++;
    }
    try {
      if (allowed) await this.send("Fetch.continueRequest", { requestId: p.requestId }, m.sessionId);
      else await this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, m.sessionId);
    } catch {
      // Refus impossible à transmettre : la requête reste en pause (elle ne part pas). Autoriser impossible : elle n'avance pas. Dans les deux cas, rien ne sort.
    }
  }

  /** Une cible vient de s'attacher (en pause) : garde d'abord, reprise ensuite. Jamais l'inverse. */
  private async adopt(m: CdpMessage): Promise<void> {
    const p = m.params as { sessionId: string; targetInfo: { targetId: string; type: string }; waitingForDebugger?: boolean };
    const sid = p.sessionId;
    const needs = NEEDS_FETCH.has(p.targetInfo.type);
    let guarded = false;
    let err = "";
    try {
      await this.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sid);
      guarded = true;
    } catch (e) {
      err = (e as Error).message;
      guarded = false;
    }
    // La cible a disparu entre son attachement et notre demande (service worker terminé, onglet fermé) : plus rien à garder, rien ne peut partir.
    if (!guarded && /Session with given id not found|Target closed|No target with given id/i.test(err)) return;
    if (needs && !guarded) {
      this.fail(`interception impossible sur une cible de type ${p.targetInfo.type} (${err})`);
      await this.send("Target.closeTarget", { targetId: p.targetInfo.targetId }).catch(() => undefined);
      return; // la cible reste en pause puis fermée : rien ne part
    }
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => undefined);
    if (p.waitingForDebugger) await this.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => undefined);
  }

  /** Démarre la garde ET prouve qu'elle marche (cible-canari). Échec = AdapterUnavailable : la session E2 ne démarre pas. */
  static async start(o: NetworkGuardOptions): Promise<NetworkGuard> {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(o.cdpUrl)) throw new AdapterRefused(A, "la garde n'accepte qu'un navigateur de bouclage");
    if (o.permits(CANARY_URL)) throw new AdapterRefused(A, "la politique permet l'hôte-canari : la sonde d'interception serait sans valeur");
    const limit = o.timeoutMs ?? 15_000;
    let wsUrl: string;
    try {
      const r = await fetch(`${o.cdpUrl}/json/version`, { signal: AbortSignal.timeout(limit) });
      wsUrl = ((await r.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? "";
    } catch {
      throw new AdapterUnavailable(A, "garde réseau : point d'entrée DevTools injoignable");
    }
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//.test(wsUrl)) throw new AdapterUnavailable(A, "garde réseau : point d'entrée DevTools inattendu");
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new AdapterUnavailable(A, "garde réseau : connexion CDP trop lente")), limit);
      ws.addEventListener("open", () => (clearTimeout(t), res()), { once: true });
      ws.addEventListener("error", () => (clearTimeout(t), rej(new AdapterUnavailable(A, "garde réseau : connexion CDP refusée"))), { once: true });
    });
    const g = new NetworkGuard(ws, o);
    try {
      await g.send("Browser.setDownloadBehavior", { behavior: "deny" });
      await g.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      // Sonde : une cible neuve vers l'hôte-canari doit être VUE puis refusée par Fetch. Pas vue = l'interception n'est pas certaine.
      // Sonde (jusqu'à trois cibles-canaris successives, chacune attendue un tiers du délai) : une machine chargée peut retarder la première.
      // Chaque canari VU puis refusé est une preuve complète ; aucun vu en tout = l'interception n'est pas certaine.
      for (let attempt = 0; attempt < 3 && !g.canarySeen && g.ok; attempt++) {
        const t = (await g.send("Target.createTarget", { url: CANARY_URL })) as { targetId: string };
        const deadline = Date.now() + Math.ceil(limit / 3);
        while (!g.canarySeen && Date.now() < deadline && g.ok) await new Promise((r) => setTimeout(r, 50));
        await g.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
      }
      if (!g.canarySeen) throw new Error("canari non vu");
      if (!g.ok) throw new Error(g.why);
    } catch (e) {
      g.close();
      throw new AdapterUnavailable(A, `garde réseau : l'interception obligatoire n'est pas démontrée (${(e as Error).message})`);
    }
    return g;
  }

  /** Révocation immédiate : plus AUCUNE requête n'est permise (celles déjà en pause sont refusées), puis la session est arrêtée par `onUnhealthy`. */
  revoke(why = "révoquée"): void {
    this.fail(`garde ${why}`);
  }

  close(): void {
    this.fail("garde fermée");
    try {
      this.ws.close();
    } catch {
      /* déjà fermée */
    }
  }
}
