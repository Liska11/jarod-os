/**
 * L'action `webhook` d'une règle d'automatisation : un POST JSON vers une adresse http(s).
 *
 * C'est un envoi SORTANT, donc cadré comme `web_fetch` (H3) : l'hôte est résolu et toutes ses adresses doivent être publiques
 * (une règle ne vise jamais la machine locale ni le réseau interne), les redirections ne sont pas suivies, la durée et la taille
 * sont bornées. La règle elle-même n'est créée qu'avec l'accord de la personne, qui voit l'adresse (automation_create, `precheck`).
 */
import { assertPublicUrl, type Lookup } from "@jarod/plugin-tools";

export const WEBHOOK_TIMEOUT_MS = 15_000;
export const WEBHOOK_MAX_BYTES = 64 * 1024;

/** Une adresse d'envoi acceptable : http ou https, un hôte, pas d'identifiants dans l'adresse. Lève une erreur dite en clair sinon. */
export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`« ${raw || "(vide)"} » n'est pas une adresse (attendu : https://hôte/chemin).`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("seuls http et https sont autorisés.");
  if (!url.hostname) throw new Error("l'adresse n'a pas d'hôte.");
  if (url.username || url.password) throw new Error("l'adresse ne doit pas porter d'identifiants (utilise un jeton dans le chemin ou un en-tête côté service).");
  return url;
}

export interface WebhookDeps {
  fetch?: typeof fetch;
  lookup?: Lookup;
}

/** Envoie `payload` en JSON ; ne rend rien si le service répond 2xx, lève une erreur dite sinon. */
export async function postWebhook(rawUrl: string, payload: unknown, deps: WebhookDeps = {}): Promise<void> {
  const url = parseWebhookUrl(rawUrl);
  await assertPublicUrl(url, deps.lookup);
  const body = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(body) > WEBHOOK_MAX_BYTES) throw new Error(`Le corps du webhook dépasse ${WEBHOOK_MAX_BYTES / 1024} Ko.`);

  const res = await (deps.fetch ?? fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Jarod-OS-Automation" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  await res.body?.cancel().catch(() => {});
  if (res.status >= 200 && res.status < 300) return;
  if (res.status >= 300 && res.status < 400) throw new Error(`Le webhook a répondu par une redirection (${res.status}) ; elle n'est pas suivie.`);
  throw new Error(`Le webhook a répondu ${res.status}.`);
}
