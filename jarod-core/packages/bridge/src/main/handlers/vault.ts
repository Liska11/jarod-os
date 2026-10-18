/**
 * Coffre d'identifiants (SPECS-P5-UI-PARITE.md §3.2) : canaux PROPRES à Jarod `vault-list`, `vault-save`, `vault-remove`.
 * Le coffre (`settings.vault` + secrets chiffrés) servait à l'agent par ses outils `vault_*`, mais ne se remplissait que par `/vault` dans le chat.
 *
 * - une VALEUR ne revient JAMAIS au renderer : `vault-list` dit seulement qu'elle existe (`hasValue`) ; elle part du champ de saisie vers le main
 *   (qui la chiffre) et n'est ni journalisée ni renvoyée, pas même dans une erreur ;
 * - élargir où un secret peut aller — l'autoriser dans les commandes du shell (`allowShell`) ou vers de nouveaux domaines — demande une
 *   confirmation NATIVE qui le nomme ; le restreindre n'en demande aucune ;
 * - supprimer un secret demande aussi une confirmation (irréversible : la valeur est effacée) ;
 * - noms, variables et domaines sont validés ; rien n'est écrit si une valeur est invalide.
 */
import type { VaultEntry, VaultKind } from "@jarod/contracts";
import type { HandlerContext } from "./context.js";

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Un domaine, ou `*.domaine` : minuscules, chiffres, tirets, points ; ni schéma, ni chemin, ni port. */
const DOMAIN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost$/;
const MAX_ENTRIES = 100;
const MAX_VALUE = 20_000;

export interface VaultView {
  name: string;
  description: string;
  envVar: string;
  domains: string[];
  allowShell: boolean;
  createdAt: number;
  /** Une valeur est enregistrée (jamais la valeur). */
  hasValue: boolean;
  kind: VaultKind;
  /** En mémoire seulement, pour cette exécution du moteur. */
  temporary: boolean;
}

const KINDS: VaultKind[] = ["api_key", "token", "password", "other"];

/**
 * Comment le coffre est protégé sur ce disque, lu dans ce que le storage a VRAIMENT fait à l'ouverture de la base
 * (jamais deviné d'après les fichiers présents) :
 * - `os-key` : base chiffrée, clé protégée par le compte (DPAPI sous Windows, trousseau ailleurs) ; l'état normal ;
 * - `weak` : base chiffrée, mais la clé est dans un fichier à côté de la base (repli quand DPAPI a échoué) ;
 * - `plain` : base en clair ;
 * - `unknown` : le storage ne dit rien (port absent, magasin non reconnu).
 * Ni clé, ni chemin, ni valeur n'y figurent.
 */
export type VaultProtection = "os-key" | "weak" | "plain" | "unknown";
export interface VaultStatus {
  protection: VaultProtection;
  /** null : inconnu. */
  encrypted: boolean | null;
  /** Le magasin qui a rendu la clé (`dpapi`, `keychain`, `libsecret`, `file`…) ; null si base en clair ou inconnu. */
  keyStore: string | null;
}

const OS_STORES = ["dpapi", "keychain", "libsecret"];

export function vaultStatusOf(enc: { encrypted: boolean; keyStoreId?: string | null; weak: boolean } | undefined): VaultStatus {
  if (!enc || typeof enc.encrypted !== "boolean") return { protection: "unknown", encrypted: null, keyStore: null };
  if (!enc.encrypted) return { protection: "plain", encrypted: false, keyStore: null };
  const keyStore = typeof enc.keyStoreId === "string" ? enc.keyStoreId : null;
  if (enc.weak || keyStore === "file") return { protection: "weak", encrypted: true, keyStore: "file" };
  if (keyStore && OS_STORES.includes(keyStore)) return { protection: "os-key", encrypted: true, keyStore };
  return { protection: "unknown", encrypted: true, keyStore };
}

const bad = (why: string): never => {
  throw new Error(`[oneai] coffre : ${why}`);
};

export function createVaultHandlers(ctx: HandlerContext) {
  const vault = () => ctx.kernel().agent.vault;
  const views = (): VaultView[] =>
    vault()
      .list()
      .map((e: VaultEntry) => ({ name: e.name, description: e.description, envVar: e.envVar, domains: [...e.domains], allowShell: e.allowShell, createdAt: e.createdAt, hasValue: vault().hasValue(e.name), kind: e.kind ?? "other", temporary: Boolean(e.temporary) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const sure = async (message: string, detail: string, action: string): Promise<void> => {
    if (!ctx.shell.confirm) bad("confirmation native indisponible, refusé");
    if (!(await ctx.shell.confirm!(message, detail, action))) bad("refusé par l'utilisateur");
  };

  return {
    "vault-list": (): VaultView[] => views(),

    "vault-status": (): VaultStatus => vaultStatusOf(ctx.kernel().storage?.dbEncryption),

    /** Retire toute portée (domaines, commandes du shell) sans effacer la valeur : restreindre ne demande pas d'accord. */
    "vault-revoke": (name: unknown): VaultView[] => {
      const e = typeof name === "string" ? vault().get(name) : undefined;
      if (!e) bad("secret inconnu");
      vault().save({ ...(e as VaultEntry), domains: [], allowShell: false });
      return views();
    },

    /** `value` absent ou vide : la valeur enregistrée est gardée (modifier la description, les domaines…). Rend la liste relue. */
    "vault-save": async (entry: unknown, value?: unknown): Promise<VaultView[]> => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) bad("entrée attendue");
      const e = entry as Record<string, unknown>;
      const extra = Object.keys(e).filter((k) => !["name", "description", "envVar", "domains", "allowShell", "kind", "temporary"].includes(k));
      if (extra.length) bad(`champ(s) inconnu(s) : ${extra.join(", ")}`);
      if (typeof e.name !== "string" || !NAME.test(e.name.trim())) bad("nom invalide : une lettre, puis lettres, chiffres ou « _ » (64 au plus)");
      const name = (e.name as string).trim();
      const description = e.description === undefined ? "" : typeof e.description === "string" ? e.description.trim() : bad("description : texte attendu");
      if (description.length > 300) bad("description : 300 caractères au plus");
      if (/[\u0000-\u001f]/.test(description)) bad("description : caractère de contrôle refusé");
      const envVar = e.envVar === undefined ? "" : typeof e.envVar === "string" ? e.envVar.trim() : bad("variable : texte attendu");
      if (envVar && !ENV.test(envVar)) bad(`nom de variable d'environnement invalide : ${envVar.slice(0, 40)}`);
      if (!Array.isArray(e.domains ?? [])) bad("domaines : liste attendue");
      const domains = [...new Set(((e.domains ?? []) as unknown[]).map((d) => (typeof d === "string" ? d.trim().toLowerCase() : bad("domaine : texte attendu"))).filter(Boolean))];
      if (domains.length > 20) bad("20 domaines au plus");
      for (const d of domains) if (!DOMAIN.test(d)) bad(`domaine invalide : ${d.slice(0, 80)} (sans schéma, chemin ni port ; « *.exemple.org » permis)`);
      const allowShell = e.allowShell === undefined ? false : typeof e.allowShell === "boolean" ? e.allowShell : bad("allowShell : booléen attendu");
      const kind = e.kind === undefined ? undefined : KINDS.includes(e.kind as VaultKind) ? (e.kind as VaultKind) : bad("type de secret inconnu");
      const temporary = e.temporary === undefined ? undefined : typeof e.temporary === "boolean" ? e.temporary : bad("temporary : booléen attendu");
      if (value !== undefined && (typeof value !== "string" || value.length > MAX_VALUE)) bad(`valeur : texte de ${MAX_VALUE} caractères au plus`);
      const existing = vault().get(name);
      if (!existing && !value) bad("un nouveau secret a besoin d'une valeur");
      if (!existing && vault().list().length >= MAX_ENTRIES) bad(`${MAX_ENTRIES} secrets au plus`);

      // Élargir où le secret peut aller : domaines ajoutés, commandes du shell.
      const addedDomains = domains.filter((d) => !(existing?.domains ?? []).includes(d));
      const widensShell = allowShell && !existing?.allowShell;
      if (addedDomains.length || widensShell) {
        await sure(
          `Autoriser le secret « ${name} » ${widensShell ? "dans les commandes du shell" : ""}${widensShell && addedDomains.length ? " et " : ""}${addedDomains.length ? "vers de nouveaux domaines" : ""} ?`,
          [
            ...(addedDomains.length ? [`Domaines où l'agent pourra l'envoyer : ${addedDomains.join(", ")}`] : []),
            ...(widensShell ? ["Disponible comme variable d'environnement dans les commandes que l'agent lance : une commande peut le lire."] : []),
            "",
            "L'agent n'en voit jamais la valeur, mais ce qu'il envoie ou lance avec peut l'utiliser. N'autorisez que ce que vous reconnaissez.",
          ].join("\n"),
          "Autoriser",
        );
      }
      vault().save({ name, description, domains, allowShell, ...(envVar ? { envVar } : {}), ...(kind ? { kind } : {}), ...(temporary !== undefined ? { temporary } : {}) }, value ? (value as string) : undefined);
      return views();
    },

    "vault-remove": async (name: unknown): Promise<VaultView[]> => {
      if (typeof name !== "string" || !vault().get(name)) bad("secret inconnu");
      await sure(`Supprimer le secret « ${name as string} » ?`, "La valeur est effacée définitivement. L'agent ne pourra plus l'utiliser.", "Supprimer");
      vault().remove(name as string);
      return views();
    },
  };
}
