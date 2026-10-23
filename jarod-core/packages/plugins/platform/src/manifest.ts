/**
 * Manifeste de plugin : identité, version, dépendances, permissions DÉCLARÉES, quotas, empreinte du contenu,
 * signature. Tout ce que le gestionnaire accepte a passé par `parseManifest` (forme) puis `verifyManifest`
 * (signature d'une clé de confiance) : un manifeste mal formé ou non signé n'est jamais installé.
 *
 * La signature est un Ed25519 sur la forme canonique du manifeste SANS le champ `signature` (clés triées,
 * pas d'espace) : l'empreinte du contenu en fait partie, donc changer un octet du plugin invalide la signature.
 */
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";

export class ManifestError extends Error {}

/** Les permissions qu'un plugin peut déclarer. Liste fermée : une permission inconnue est une erreur. */
export const PERMISSIONS = [
  "fs.workspace.read",
  "fs.workspace.write",
  "net.http",
  "net.local",
  "process.spawn",
  "secrets.read",
  "agent.tools",
  "ui.panel",
  "gpu",
  // V-06 : les surfaces des plugins utilisateur (plugin-workflows, `PLUGIN_PERMISSIONS`), signées telles quelles.
  "tools",
  "commands",
  "hooks",
  "routes",
  "pages",
  "notify",
  "network",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface Quotas {
  /** Mémoire de travail déclarée, en Mo. */
  memoryMb: number;
  /** Disque dans la zone du plugin, en Mo. */
  diskMb: number;
  /** Mémoire vidéo, en Mo (0 : aucun GPU). */
  vramMb: number;
}

export interface PluginManifest {
  name: string;
  version: string;
  /** nom → plage (`^1.2.0`, `~1.2.0`, `>=1.0.0`, `1.2.3`). */
  dependencies: Record<string, string>;
  permissions: Permission[];
  quotas: Quotas;
  /** SHA-256 hexadécimal du contenu du plugin. */
  payloadSha256: string;
  /** Identifiant de la clé qui a signé, et la signature en base64. */
  signature?: { keyId: string; value: string };
}

const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function num(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ManifestError(`quotas.${field} : entier entre 0 et ${max} attendu`);
  }
  return value;
}

export function parseManifest(input: unknown): PluginManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ManifestError("manifeste : un objet est attendu");
  const m = input as Record<string, unknown>;
  const known = new Set(["name", "version", "dependencies", "permissions", "quotas", "payloadSha256", "signature"]);
  for (const key of Object.keys(m)) if (!known.has(key)) throw new ManifestError(`champ inconnu : ${key}`);

  if (typeof m.name !== "string" || !NAME.test(m.name)) throw new ManifestError("name : minuscules, chiffres et tirets");
  if (typeof m.version !== "string" || !VERSION.test(m.version)) throw new ManifestError("version : x.y.z attendu");
  if (typeof m.payloadSha256 !== "string" || !HEX64.test(m.payloadSha256)) throw new ManifestError("payloadSha256 : 64 caractères hexadécimaux");

  const deps = (m.dependencies ?? {}) as Record<string, unknown>;
  if (typeof deps !== "object" || Array.isArray(deps)) throw new ManifestError("dependencies : un objet est attendu");
  const dependencies: Record<string, string> = {};
  for (const [name, range] of Object.entries(deps)) {
    if (!NAME.test(name)) throw new ManifestError(`dépendance : nom invalide « ${name} »`);
    if (typeof range !== "string" || !/^(\^|~|>=)?\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(range)) throw new ManifestError(`dépendance ${name} : plage invalide`);
    dependencies[name] = range;
  }

  const perms = m.permissions ?? [];
  if (!Array.isArray(perms)) throw new ManifestError("permissions : une liste est attendue");
  for (const p of perms) {
    if (!(PERMISSIONS as readonly unknown[]).includes(p)) throw new ManifestError(`permission inconnue : ${String(p)}`);
  }

  const q = m.quotas as Record<string, unknown> | undefined;
  if (!q || typeof q !== "object") throw new ManifestError("quotas : obligatoires (mémoire, disque, vram)");
  const quotas: Quotas = { memoryMb: num(q.memoryMb, "memoryMb", 262_144), diskMb: num(q.diskMb, "diskMb", 10_485_760), vramMb: num(q.vramMb, "vramMb", 262_144) };
  if (quotas.vramMb > 0 && !(perms as unknown[]).includes("gpu")) throw new ManifestError("quotas.vramMb > 0 sans la permission « gpu »");

  let signature: PluginManifest["signature"];
  if (m.signature !== undefined) {
    const s = m.signature as Record<string, unknown>;
    if (!s || typeof s.keyId !== "string" || typeof s.value !== "string" || !/^[\w.-]{1,64}$/.test(s.keyId)) throw new ManifestError("signature : { keyId, value } attendu");
    signature = { keyId: s.keyId, value: s.value };
  }

  return { name: m.name, version: m.version, dependencies, permissions: [...new Set(perms as Permission[])], quotas, payloadSha256: m.payloadSha256, ...(signature ? { signature } : {}) };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Les octets signés : le manifeste canonique sans sa signature. */
export function signedBytes(manifest: PluginManifest): Buffer {
  const { signature: _ignored, ...rest } = manifest;
  void _ignored;
  return Buffer.from(canonical(rest), "utf8");
}

/** Signe (outil de publication et de test). La clé privée n'entre jamais dans ce module hors de cet appel. */
export function signManifest(manifest: PluginManifest, keyId: string, privateKey: KeyObject): PluginManifest {
  const value = cryptoSign(null, signedBytes(manifest), privateKey).toString("base64");
  return { ...manifest, signature: { keyId, value } };
}

/** Clés de confiance : identifiant → clé publique (PEM). Aucune clé = aucun plugin signé accepté. */
export type TrustedKeys = Record<string, string>;

export function verifyManifest(manifest: PluginManifest, trusted: TrustedKeys): void {
  if (!manifest.signature) throw new ManifestError(`${manifest.name} : manifeste non signé`);
  const pem = trusted[manifest.signature.keyId];
  if (!pem) throw new ManifestError(`${manifest.name} : clé « ${manifest.signature.keyId} » inconnue`);
  let ok = false;
  try {
    ok = cryptoVerify(null, signedBytes(manifest), createPublicKey(pem), Buffer.from(manifest.signature.value, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new ManifestError(`${manifest.name} : signature invalide`);
}
