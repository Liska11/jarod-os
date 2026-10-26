/**
 * Registre de clés éditeurs — matrice de confiance des composants (ADR JOS-022 … JOS-024).
 *
 * Porté depuis la reconstruction `D:\Jarod-OS\repo` (Phases 1 à 4), où le module a été testé
 * (`tests/trust.test.mjs`) puis intégré à la plateforme de plugins et exposé par RPC.
 *
 * Règles tenues :
 *  - `official` : seule une clé enregistrée `official` signe ; une clé inconnue est refusée.
 *  - `verified` : une clé `verified` ou `official` ; inconnue refusée.
 *  - `community` : une clé `community` acceptée ; une clé inconnue est acceptée **avec
 *    avertissement** (signature non vérifiée, composant non approuvé).
 *  - `local` : la clé locale `local-1` uniquement.
 *  - une clé **révoquée** est refusée partout, en premier.
 *  - **aucune promotion** : un niveau différent pour un `keyId` existant est un refus ; seul un
 *    changement de clé (rotation) est possible, et il révoque l'ancienne.
 *
 * Le module est volontairement pur (hors lecture/écriture du fichier) : testable directement.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
/** Ce que le registre a besoin de connaître d'un manifeste : sa signature et son niveau déclaré. */
export interface SignedManifestLike {
  name?: string;
  signature?: { keyId?: string };
  trust?: unknown;
  trustLevel?: unknown;
}
/** Clés de confiance au format attendu par `verifyManifest` : keyId -> PEM. */
export type TrustedKeysMap = Record<string, string>;

export const LEVELS = ["official", "verified", "community", "local"] as const;
export type TrustLevel = (typeof LEVELS)[number];
export const RANK: Record<TrustLevel, number> = { official: 3, verified: 2, community: 1, local: 0 };

export interface KeyEntry {
  keyId: string;
  publicPem: string;
  level: TrustLevel;
  label: string;
  addedAt: number;
}
export interface RevokedEntry {
  at: number;
  replacedBy: string;
}
export interface TrustStore {
  version: number;
  keys: Record<string, KeyEntry>;
  revoked: Record<string, RevokedEntry>;
}
export interface Decision {
  ok: boolean;
  level: string;
  keyLevel: TrustLevel | null;
  warning: string | null;
  reason: string | null;
}
export interface TrustStatus {
  keyId: string;
  known: boolean;
  level: TrustLevel | null;
  revoked: boolean;
  replacedBy: string | null;
}

export function emptyStore(): TrustStore {
  return { version: 1, keys: {}, revoked: {} };
}

export function loadStore(file: string): TrustStore {
  if (!existsSync(file)) return emptyStore();
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<TrustStore> | null;
  if (!raw || typeof raw !== "object") throw new Error("registre de clés invalide");
  const store: TrustStore = { version: raw.version ?? 1, keys: raw.keys ?? {}, revoked: raw.revoked ?? {} };
  return store;
}

export function saveStore(file: string, store: TrustStore): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, file);
}

export function seedLocal(store: TrustStore, publicPem: string): void {
  if (!store.keys["local-1"]) {
    store.keys["local-1"] = { keyId: "local-1", publicPem, level: "local", label: "clé locale de cette machine", addedAt: Date.now() };
  }
}

export function addKey(store: TrustStore, input: { keyId: string; publicPem: string; level: TrustLevel; label?: string }): KeyEntry {
  const keyId = String(input.keyId ?? "");
  if (!keyId) throw new Error("keyId requis");
  if (!LEVELS.includes(input.level)) throw new Error(`niveau inconnu : ${String(input.level)}`);
  if (!input.publicPem || !/BEGIN PUBLIC KEY/.test(input.publicPem)) throw new Error("clé publique PEM requise");
  if (store.revoked[keyId]) throw new Error(`${keyId} est révoquée`);
  const existing = store.keys[keyId];
  if (existing) {
    if (existing.level !== input.level) throw new Error(`rotation requise : ${keyId} est déjà au niveau ${existing.level}`);
    return existing;
  }
  store.keys[keyId] = { keyId, publicPem: input.publicPem, level: input.level, label: input.label ?? "", addedAt: Date.now() };
  return store.keys[keyId];
}

/** Rotation : révoque l'ancienne clé et enregistre la nouvelle au même niveau. */
export function rotateKey(store: TrustStore, oldKeyId: string, input: { newKeyId: string; publicPem: string; label?: string }): { revoked: string; added: string; level: TrustLevel } {
  const old = store.keys[oldKeyId];
  if (!old) throw new Error(`clé inconnue : ${oldKeyId}`);
  if (!input.newKeyId || input.newKeyId === oldKeyId) throw new Error("nouvelle clé distincte requise");
  addKey(store, { keyId: input.newKeyId, publicPem: input.publicPem, level: old.level, label: input.label ?? "" });
  store.revoked[oldKeyId] = { at: Date.now(), replacedBy: input.newKeyId };
  return { revoked: oldKeyId, added: input.newKeyId, level: old.level };
}

export function statusOf(store: TrustStore, keyId: string): TrustStatus {
  const key = store.keys[keyId];
  const revoked = store.revoked[keyId];
  return {
    keyId,
    known: Boolean(key),
    level: key ? key.level : null,
    revoked: Boolean(revoked),
    replacedBy: revoked ? revoked.replacedBy : null,
  };
}

/**
 * Décision d'acceptation. `declared` : niveau revendiqué par le composant.
 */
export function decide(store: TrustStore, input: { keyId: string | null | undefined; declared: string }): Decision {
  const declared = String(input.declared ?? "");
  const keyId = String(input.keyId ?? "");
  if (!LEVELS.includes(declared as TrustLevel)) {
    return { ok: false, level: declared, keyLevel: null, warning: null, reason: `niveau déclaré inconnu : ${declared}` };
  }
  const st = statusOf(store, keyId);
  if (st.revoked) return { ok: false, level: declared, keyLevel: st.level, warning: null, reason: `clé révoquée : ${keyId}` };
  if (declared === "official" || declared === "verified") {
    if (!st.known) return { ok: false, level: declared, keyLevel: null, warning: null, reason: `clé inconnue refusée pour le niveau ${declared}` };
    if (declared === "official" && st.level !== "official") {
      return { ok: false, level: declared, keyLevel: st.level, warning: null, reason: `niveau ${st.level} insuffisant pour official` };
    }
    if (declared === "verified" && !["verified", "official"].includes(String(st.level))) {
      return { ok: false, level: declared, keyLevel: st.level, warning: null, reason: `niveau ${st.level} insuffisant pour verified` };
    }
    return { ok: true, level: declared, keyLevel: st.level, warning: null, reason: null };
  }
  if (declared === "local") {
    if (st.known && st.level === "local") return { ok: true, level: declared, keyLevel: st.level, warning: null, reason: null };
    return { ok: false, level: declared, keyLevel: st.level, warning: null, reason: "seule la clé locale (local-1) peut signer un composant local" };
  }
  // community
  if (!st.known) {
    return { ok: true, level: "community", keyLevel: null, warning: "clé inconnue : signature non vérifiée, composant community non approuvé", reason: null };
  }
  if (st.level !== "community") {
    return { ok: false, level: "community", keyLevel: st.level, warning: null, reason: `clé ${st.level} ne peut pas signer community sans rotation` };
  }
  return { ok: true, level: "community", keyLevel: st.level, warning: null, reason: null };
}

/** Le niveau déclaré par un manifeste (`trust`, sinon `trustLevel`, sinon `local`). */
export function declaredLevelOf(manifest: SignedManifestLike | null | undefined): string {
  const m = manifest as { trust?: unknown; trustLevel?: unknown } | null | undefined;
  const declared = m?.trust ?? m?.trustLevel ?? "local";
  return String(declared);
}

/** Ce que la plateforme demande au registre : une décision, un état, les clés de confiance. */
export interface TrustService {
  store(): TrustStore;
  file(): string;
  check(manifest: SignedManifestLike): Decision & { declared: string };
  status(manifest: SignedManifestLike): { keyId: string; level: string; keyLevel: TrustLevel | null; revoked: boolean; ok: boolean };
  pems(): TrustedKeysMap;
  note?(manifest: SignedManifestLike, decision: Decision, ok: boolean): void;
}

/** Registre adossé au fichier : chaque lecture relit le disque (une clé ajoutée après le démarrage compte). */
export function createTrustService(file: string, localPublicPem?: string | null): TrustService {
  const initial = loadStore(file);
  if (localPublicPem) {
    seedLocal(initial, localPublicPem);
    saveStore(file, initial);
  }
  const fresh = () => loadStore(file);
  return {
    store: fresh,
    file: () => file,
    check(manifest) {
      const declared = declaredLevelOf(manifest);
      return { ...decide(fresh(), { keyId: (manifest as { signature?: { keyId?: string } } | null)?.signature?.keyId, declared }), declared };
    },
    status(manifest) {
      const s = fresh();
      const keyId = (manifest as { signature?: { keyId?: string } } | null)?.signature?.keyId ?? "";
      const declared = declaredLevelOf(manifest);
      const d = decide(s, { keyId, declared });
      return { keyId, level: d.ok ? d.level : (d.keyLevel ?? declared), keyLevel: d.keyLevel, revoked: Boolean(s.revoked[keyId]), ok: d.ok };
    },
    pems() {
      const s = fresh();
      return Object.fromEntries(
        Object.values(s.keys)
          .filter((k) => !statusOf(s, k.keyId).revoked)
          .map((k) => [k.keyId, k.publicPem]),
      );
    },
  };
}
