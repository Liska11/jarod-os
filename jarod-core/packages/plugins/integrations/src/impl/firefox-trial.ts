// E2 / Firefox — ESSAI GUIDÉ sur une page NEUTRE locale. Pas une intégration à l'application : un programme d'essai, à lancer à la main, qui
//   1. sert une page sans aucune donnée personnelle sur le bouclage (http://essai.localhost:<port>/, jamais un compte, jamais un site réel) ;
//   2. ouvre le canal de l'extension (code d'appairage affiché à l'utilisateur seulement) ;
//   3. attend le geste de l'utilisateur (clic sur le bouton de l'extension dans l'onglet de la page d'essai) ;
//   4. montre la cible exacte et ne lit qu'APRÈS un « oui » donné par l'utilisateur lui-même (`ask`) ;
//   5. affiche le titre et le texte de l'élément convenu LOCALEMENT, puis ferme tout.
// La liste blanche de l'essai est UNIQUEMENT l'hôte d'essai : aucun réglage permanent n'est touché, et les interdictions de domaines restent actives.
import { createServer, type Server } from "node:http";
import { FirefoxReader, ReaderChannel, type ReaderAuditEntry, type ReaderDisplay } from "./firefox-reader.js";

export const TRIAL_HOST = "essai.localhost";
export const TRIAL_SELECTOR = "#sujet";

export const TRIAL_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Page d'essai JAROD-OS (neutre)</title></head>
<body>
<h1>Page d'essai JAROD-OS</h1>
<p id="sujet">Bonjour : ceci est le texte convenu pour le premier essai de lecture ponctuelle.</p>
<p id="autre">Ce paragraphe n'est pas l'élément convenu : il ne doit jamais être lu.</p>
<form><label>Champ de leurre <input id="leurre" value="valeur-de-leurre-a-ne-jamais-lire"></label></form>
</body></html>`;

export interface TrialIO {
  /** Une ligne pour l'utilisateur (terminal). Jamais de contenu lu, sauf à l'étape d'affichage. */
  out(line: string): void;
  /** Demande à l'UTILISATEUR (pas à un programme) : vrai seulement pour un « oui » explicite. */
  ask(summary: string): Promise<boolean>;
}

export interface TrialOptions extends TrialIO {
  /** Durée maximale de tout l'essai (défaut 10 min). */
  timeoutMs?: number;
  /** Nombre de gestes essayés au plus (défaut 3). */
  attempts?: number;
  /** Intervalle de recherche d'un geste (défaut 400 ms). */
  pollMs?: number;
}

export interface TrialResult {
  read: { host: string; url: string; title: string; text: string } | null;
  audits: ReaderAuditEntry[];
  reason?: string;
}

export async function runTrial(o: TrialOptions): Promise<TrialResult> {
  const audits: ReaderAuditEntry[] = [];
  let read: TrialResult["read"] = null;
  const page: Server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "/").split("?")[0] !== "/") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(TRIAL_PAGE);
  });
  await new Promise<void>((resolve, reject) => {
    page.once("error", reject);
    page.listen(0, "127.0.0.1", () => resolve());
  });
  const pagePort = (page.address() as { port: number }).port;
  const channel = new ReaderChannel({ idleMs: 90_000, pollMs: 5_000 });
  const { port, pairingCode } = await channel.start();
  const reader = new FirefoxReader({
    channel,
    policy: { allowDomains: [TRIAL_HOST] },
    approve: (r) => o.ask(r.summary),
    display: (r: ReaderDisplay) => {
      read = { host: r.host, url: r.url, title: r.title, text: r.text };
    },
    audit: (e) => audits.push(e),
    approvalTimeoutMs: 120_000,
    readTtlMs: 20_000,
  });
  const finish = async (reason?: string): Promise<TrialResult> => {
    await reader.stop().catch(() => undefined);
    await new Promise<void>((r) => {
      page.closeAllConnections();
      page.close(() => r());
    });
    return { read, audits, ...(reason ? { reason } : {}) };
  };

  o.out(`Page d'essai : http://${TRIAL_HOST}:${pagePort}/  (ouvrez-la dans un onglet de Firefox)`);
  o.out(`Canal ouvert sur 127.0.0.1:${port}. Code d'appairage : ${pairingCode}`);
  o.out("→ Collez ce code dans les options de l'extension, puis, sur la page d'essai, cliquez sur le bouton de l'extension.");

  const deadline = Date.now() + (o.timeoutMs ?? 600_000);
  let tries = 0;
  let handledAge = Number.POSITIVE_INFINITY; // âge du geste déjà traité : un geste NEUF a un âge plus petit (la question n'est pas reposée sur le même)
  while (Date.now() < deadline && tries < (o.attempts ?? 3) && !read) {
    const sel = reader.selection();
    if (!sel || sel.ageMs >= handledAge) {
      if (sel) handledAge = sel.ageMs;
      await new Promise((r) => setTimeout(r, o.pollMs ?? 400));
      continue;
    }
    tries++;
    o.out(`Geste reçu : onglet ${sel.tabId}, ${sel.url}`);
    try {
      await reader.readElement(TRIAL_SELECTOR);
    } catch (e) {
      o.out(`Rien n'a été lu : ${(e as Error).message}`);
      o.out("→ Pour réessayer, cliquez de nouveau sur le bouton de l'extension (nouveau geste).");
    }
    handledAge = reader.selection()?.ageMs ?? Number.POSITIVE_INFINITY;
  }
  const r = read as TrialResult["read"];
  if (r) {
    o.out("— Lu (affichage local seulement) —");
    o.out(`Hôte : ${r.host}`);
    o.out(`Titre : ${r.title}`);
    o.out(`Texte : ${r.text}`);
    return finish();
  }
  return finish(Date.now() >= deadline ? "délai de l'essai dépassé" : "aucune lecture");
}
