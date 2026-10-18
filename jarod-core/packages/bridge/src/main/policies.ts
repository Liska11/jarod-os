/**
 * Règles du processus main, sans Electron (U4 : testables en unitaire). Extraites telles quelles de
 * `index.ts` : chiffrement des secrets (source Jarod-one index.ts:77-88), permission micro (:295-301),
 * navigation et liens externes (:321-330), reprise bornée du renderer (U3).
 */
import type { Cipher } from "@jarod/contracts";

/** Ce que le main utilise de `safeStorage`. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Clés d'API chiffrées par le trousseau de l'OS (DPAPI sous Windows) ; échec franc si aucun trousseau. */
export function safeStorageCipher(safe: SafeStorageLike): Cipher {
  return {
    encrypt(plain) {
      // Échec franc À L'ÉCRITURE : le chiffreur est construit au chargement du module (avant « ready »), le lancer là
      // ferait planter toute l'application au démarrage, sans message, au lieu de refuser l'enregistrement d'un secret.
      if (!safe.isEncryptionAvailable()) {
        throw new Error("[policies] safeStorage indisponible : impossible de chiffrer les secrets sans trousseau OS");
      }
      return `ss:${safe.encryptString(plain).toString("base64")}`;
    },
    decrypt(encoded) {
      if (encoded.startsWith("ss:")) return safe.decryptString(Buffer.from(encoded.slice(3), "base64"));
      // Anciennes valeurs sans préfixe (compatibilité) : on refuse net.
      throw new Error("[policies] secret non chiffré par safeStorage (préfixe manquant) : refus");
    },
  };
}

/** Micro pour la dictée : notre fenêtre seule, permission « media », et l'audio seul. */
export function allowMediaRequest(fromOurWindow: boolean, permission: string, mediaTypes: readonly string[] | undefined): boolean {
  return fromOurWindow && permission === "media" && (mediaTypes ?? []).every((t) => t === "audio");
}

/**
 * Navigation de la fenêtre : `stay` (serveur de dev), sinon jamais ailleurs — `external` (http/https ouverts
 * dans le navigateur) ou `block`.
 */
export function navigationDecision(url: string, devUrl?: string): "stay" | "external" | "block" {
  if (devUrl && url.startsWith(devUrl)) return "stay";
  return /^https?:\/\//.test(url) ? "external" : "block";
}

/** Renderer tombé : rechargé au plus `max` fois par fenêtre de `windowMs`, ensuite on le dit. */
export const RENDERER_MAX_RELOADS = 3;

export function rendererRecovery(max = RENDERER_MAX_RELOADS, windowMs = 60_000, now: () => number = Date.now) {
  let crashes: number[] = [];
  return {
    /** Décision pour un arrêt du renderer ; `count` = arrêts dans la fenêtre glissante. */
    onGone(reason: string): { action: "ignore" | "reload" | "give-up"; count: number } {
      if (reason === "clean-exit") return { action: "ignore", count: crashes.length };
      const t = now();
      crashes = crashes.filter((c) => t - c < windowMs);
      crashes.push(t);
      return { action: crashes.length > max ? "give-up" : "reload", count: crashes.length };
    },
    get count(): number {
      return crashes.length;
    },
  };
}

/**
 * Le mode test (`JAROD_TEST_MODE=1`) n'existe PAS dans l'application installée (AV2-010) : une variable d'environnement posée par
 * n'importe quel processus ne doit pas pouvoir y brancher un fournisseur de test, un micro simulé, un registre de test ou un mode smoke.
 */
export function testModeEnabled(env: Record<string, string | undefined>, packaged: boolean): boolean {
  return !packaged && env.JAROD_TEST_MODE === "1";
}

/**
 * Menu d'application. En développement : celui d'Electron (rechargement, DevTools). Installé : AUCUN menu sous Windows et Linux
 * (les raccourcis d'édition restent ceux de la page), et sous macOS seulement les rôles standard — jamais « Affichage »
 * (rechargement, DevTools, zoom de la page). `"default"` = ne rien changer.
 */
/** The subset of Electron's `MenuItemConstructorOptions` used here; this package does not depend on Electron. */
export type MenuRoleItem = { role: "appMenu" | "editMenu" | "windowMenu" };

export function applicationMenuTemplate(platform: string, packaged: boolean): MenuRoleItem[] | null | "default" {
  if (!packaged) return "default";
  if (platform === "darwin") return [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }];
  return null;
}
