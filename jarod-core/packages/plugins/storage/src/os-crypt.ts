import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cipher } from "@jarod/contracts";

/**
 * Jarod-cordis (B3) : lecture HORS Electron (CLI `jarod serve`, gates) des secrets que le desktop chiffre par
 * `safeStorage` (préfixe `ss:`, `desktop/src/main/policies.ts`). Sous Windows, `safeStorage` est l'os_crypt de
 * Chromium : une clé AES-256 rangée dans `<userData>/Local State` (`os_crypt.encrypted_key` = « DPAPI » + blob
 * DPAPI du compte, sans entropie), puis chaque valeur = « v10 » + nonce (12 o) + chiffré + étiquette GCM (16 o).
 * Même utilisateur Windows que le desktop exigé (DPAPI) ; rien n'est écrit, aucune valeur n'est journalisée.
 */

/** Dossier `userData` du desktop (`app.setPath("userData", …)`, `desktop/src/main/index.ts`) : là où est `Local State`. */
export function electronUserDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (env.JAROD_USER_DATA) return env.JAROD_USER_DATA;
  const appData =
    platform === "win32"
      ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return join(appData, "Jarod-One");
}

const V10 = Buffer.from("v10", "latin1");
const DPAPI_PREFIX = Buffer.from("DPAPI", "latin1");

const powershell = (script: string, input: Buffer): Buffer =>
  Buffer.from(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: input.toString("base64"),
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 20_000,
    }).trim(),
    "base64",
  );

/** DPAPI du compte courant, sans entropie (comme Chromium). */
export function dpapiUnprotect(blob: Buffer): Buffer {
  return powershell(
    "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'))",
    blob,
  );
}

export function dpapiProtect(data: Buffer): Buffer {
  return powershell(
    "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser'))",
    data,
  );
}

/** Clé os_crypt (32 o) de `<userDataDir>/Local State`. */
export function readOsCryptKey(userDataDir: string, unprotect: (blob: Buffer) => Buffer = dpapiUnprotect): Buffer {
  const file = join(userDataDir, "Local State");
  let encoded: unknown;
  try {
    encoded = (JSON.parse(readFileSync(file, "utf8")) as { os_crypt?: { encrypted_key?: unknown } }).os_crypt?.encrypted_key;
  } catch (e) {
    throw new Error(`safeStorage : « Local State » illisible (${file}) : ${(e as Error).message}`);
  }
  if (typeof encoded !== "string") throw new Error(`safeStorage : aucune clé os_crypt dans ${file}`);
  const blob = Buffer.from(encoded, "base64");
  if (!blob.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) throw new Error("safeStorage : clé os_crypt de format inconnu");
  const key = unprotect(blob.subarray(DPAPI_PREFIX.length));
  if (key.length !== 32) throw new Error("safeStorage : clé os_crypt de taille inattendue");
  return key;
}

/** Valeur os_crypt « v10 » (AES-256-GCM), comme `safeStorage.encryptString` sous Windows. */
export function osCryptEncrypt(key: Buffer, plain: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([V10, nonce, body, c.getAuthTag()]);
}

export function osCryptDecrypt(key: Buffer, data: Buffer): string {
  if (!data.subarray(0, 3).equals(V10) || data.length < 3 + 12 + 16) throw new Error("safeStorage : valeur de format inconnu (v10 attendu)");
  const d = createDecipheriv("aes-256-gcm", key, data.subarray(3, 15));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(15, data.length - 16)), d.final()]).toString("utf8");
}

/**
 * Chiffrement des secrets hors Electron : lit `ss:` (desktop, Windows — clé chargée à la première lecture, une
 * fois) et `pl:` (écrit sans trousseau) ; écrit `pl:` (comme avant). Toute autre valeur, ou `ss:` hors Windows :
 * erreur, que `SettingsService.getSecret` rend en « absent ».
 */
export function electronSecretsCipher(
  userDataDir: string,
  opts: { platform?: NodeJS.Platform; unprotect?: (blob: Buffer) => Buffer } = {},
): Cipher {
  const platform = opts.platform ?? process.platform;
  let key: Buffer | null = null;
  return {
    encrypt: (s) => `pl:${Buffer.from(s, "utf8").toString("base64")}`,
    decrypt: (s) => {
      if (s.startsWith("pl:")) return Buffer.from(s.slice(3), "base64").toString("utf8");
      if (!s.startsWith("ss:")) throw new Error("secret de format inconnu");
      if (platform !== "win32") throw new Error("safeStorage : lecture hors Electron prise en charge sous Windows seulement");
      const data = Buffer.from(s.slice(3), "base64");
      if (!data.subarray(0, 3).equals(V10)) throw new Error("safeStorage : valeur de format inconnu (v10 attendu)");
      key ??= readOsCryptKey(userDataDir, opts.unprotect);
      return osCryptDecrypt(key, data);
    },
  };
}
