/**
 * H3 (audit v4 § 1) — garde réseau des outils web : `web_fetch` ne doit pas pouvoir viser la machine locale.
 *
 * Sans ce garde, un contenu non fiable (page web, PDF indexé, corps de webhook, e-mail) fait lire à l'agent
 * `http://127.0.0.1:8080/props` (llama-server), une interface d'admin locale, ou le worker d'embeddings — et
 * une redirection ouverte suffisait à contourner n'importe quel contrôle posé seulement sur l'URL de départ.
 *
 * Deux règles : l'hôte est résolu (DNS inclus, pas seulement l'adresse littérale) et TOUTES ses adresses
 * doivent être publiques ; les redirections ne sont jamais suivies par `fetch` (`redirect: "manual"`) mais
 * une à une par l'appelant, qui repasse par ce garde à chaque saut.
 */
import { lookup as dnsLookup } from "node:dns/promises";

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Résolution à utiliser (injectable : les tests n'ont pas besoin de DNS). */
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

/** Résolution réelle du système, toutes les adresses disponibles. */
export const systemLookup: Lookup = async (hostname) => {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((r) => ({ address: r.address, family: r.family }));
};

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** L'adresse IPv4 encapsulée dans une IPv6 (`::ffff:127.0.0.1`, `::127.0.0.1`), ou null. */
function embeddedV4(ip: string): string | null {
  const m = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip);
  return m ? m[1]! : null;
}

/** Vrai pour toute IPv4 qui n'est pas publique (boucle locale, privée, lien-local, multicast, réservée). */
function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // fail-closed
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // lien-local, dont 169.254.169.254 (métadonnées cloud)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true; // 192.168/16, 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true; // bancs d'essai
  if (a === 203 && b === 0) return true; // 203.0.113/24
  if (a >= 224) return true; // multicast (224/4) + réservé (240/4)
  return false;
}

/** Développe une IPv6 en 8 groupes de 16 bits (`::ffff:7f00:1` → [0,0,0,0,0,0xffff,0x7f00,1]), ou null. */
function expandV6(host: string): number[] | null {
  const [head, tail] = host.split("::") as [string, string?];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const missing = 8 - h.length - t.length;
  if (tail === undefined && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...h, ...Array<string>(missing).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/** Vrai pour toute IPv6 qui n'est pas publique (boucle locale, ULA, lien-local, multicast, IPv4 encapsulée). */
function isPrivateV6(ip: string): boolean {
  const host = ip.toLowerCase().split("%")[0]!; // identifiant de zone retiré
  const dotted = embeddedV4(host);
  if (dotted) return isPrivateV4(dotted);
  const g = expandV6(host);
  if (!g) return true; // forme inattendue : fail-closed
  // IPv4 encapsulée : `::ffff:a.b.c.d` (mappée) ou `::a.b.c.d` (compatible) — Node normalise en hexadécimal,
  // donc `::ffff:127.0.0.1` arrive ici sous la forme `::ffff:7f00:1` : sans ce décodage, la boucle locale
  // passerait pour une adresse publique.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateV4(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`);
  if (g.slice(0, 6).every((x) => x === 0)) return isPrivateV4(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`);
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 (adresses locales uniques)
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 (lien-local)
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 (multicast)
  return false;
}

/**
 * Vrai si l'adresse n'est PAS publique. Une entrée qui n'est pas une adresse IP littérale est refusée
 * (fail-closed) : cette fonction ne reçoit que des adresses déjà résolues.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (addr.includes(":")) return isPrivateV6(addr);
  return isPrivateV4(addr);
}

/** Le nom d'hôte d'une URL, sans les crochets des littéraux IPv6. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/**
 * Refuse une URL dont l'hôte est local ou privé. Lève une `Error` explicite (le modèle doit pouvoir dire
 * pourquoi), jamais une valeur de retour à tester.
 *
 * @param lookup résolution à utiliser (les tests injectent la leur ; `systemLookup` par défaut).
 */
export async function assertPublicUrl(url: URL, lookup: Lookup = systemLookup): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Seuls http et https sont autorisés.");
  const host = hostOf(url);
  if (!host) throw new Error(`URL refusée : hôte vide (${url.href}).`);
  const literal = IPV4.test(host) || host.includes(":");
  const addresses: ResolvedAddress[] = literal ? [{ address: host, family: host.includes(":") ? 6 : 4 }] : await lookup(host);
  if (addresses.length === 0) throw new Error(`URL refusée : « ${host} » ne résout vers aucune adresse.`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address))
      throw new Error(
        `URL refusée : « ${host} » (${address}) est une adresse locale ou privée. Cet outil n'atteint jamais la machine locale ni le réseau interne.`,
      );
  }
}