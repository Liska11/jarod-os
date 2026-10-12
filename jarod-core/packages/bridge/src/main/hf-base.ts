/**
 * `JAROD_TEST_HF_BASE` (SPECS-P5-MODELS.md § 3.9 (d) et § 3.10 (g)) : l'URL de base de Hugging Face pour l'e2e Electron sur le serveur FACTICE. Triple garde, calquée sur
 * `JAROD_TEST_TELEGRAM_API` : `JAROD_TEST_MODE=1` ET application non empaquetée ET origine de boucle locale (`http://127.0.0.1:<port>` ou `http://[::1]:<port>`).
 *
 * Hors de ce cas la variable est IGNORÉE (et le dit) : ni réglage, ni canal IPC, ni champ d'entrée ne peut rediriger l'application vers un autre hôte en production.
 * Ce module est le SEUL endroit du code qui nomme la variable (contrôle du dépôt dans `hf-base.test.ts`) ; `index.ts` lui passe l'environnement entier.
 */
export interface TestHfBase {
  /** L'origine acceptée, ou `null` : la base de production (`https://huggingface.co`) reste celle du service. */
  baseUrl: string | null;
  /** Pourquoi une variable posée a été ignorée ; `null` quand elle est absente ou acceptée. */
  ignoredReason: string | null;
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);

export function resolveTestHfBase(o: { env: Record<string, string | undefined>; packaged: boolean }): TestHfBase {
  const raw = o.env.JAROD_TEST_HF_BASE;
  if (raw === undefined || raw === "") return { baseUrl: null, ignoredReason: null };
  const ignore = (why: string): TestHfBase => ({ baseUrl: null, ignoredReason: `JAROD_TEST_HF_BASE ignorée : ${why}` });
  if (o.env.JAROD_TEST_MODE !== "1") return ignore("hors mode test (JAROD_TEST_MODE=1 requis)");
  if (o.packaged) return ignore("application empaquetée");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ignore("adresse illisible");
  }
  if (url.protocol !== "http:") return ignore("seul http est accepté (serveur factice local)");
  if (url.username !== "" || url.password !== "") return ignore("identifiants dans l'adresse");
  if (!LOOPBACK.has(url.hostname)) return ignore("seuls 127.0.0.1 et [::1] sont acceptés");
  if (url.port === "") return ignore("un port explicite est requis");
  return { baseUrl: url.origin, ignoredReason: null };
}
