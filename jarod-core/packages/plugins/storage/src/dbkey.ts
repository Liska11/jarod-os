import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Where the database encryption key lives. The key itself is random (32 bytes, hex); stores only
 * protect it at rest. The OS stores (DPAPI, Keychain, libsecret) are reachable from both the desktop
 * app and the CLI running as the same user, unlike Electron's safeStorage.
 */
export interface KeyStore {
  readonly id: "dpapi" | "keychain" | "libsecret" | "file" | "memory";
  /** Human-readable name for the settings screen. */
  readonly label: string;
  load(dataDir: string): string | null;
  save(dataDir: string, key: string): void;
}

const run = (cmd: string, args: string[], input?: string): string =>
  execFileSync(cmd, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 20_000,
  }).trim();

/** Stable, non-reversible account name for a profile folder in OS keychains. */
const accountFor = (dataDir: string) =>
  `jarod-${createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 24)}`;

// Windows: DPAPI bound to the current user, through PowerShell (no extra native module).
const DPAPI_ENTROPY = "[Text.Encoding]::UTF8.GetBytes('Jarod-One db key')";
const dpapi: KeyStore = {
  id: "dpapi",
  label: "Windows DPAPI (compte utilisateur)",
  load(dataDir) {
    const file = join(dataDir, "db.key.dpapi");
    if (!existsSync(file)) return null;
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, ${DPAPI_ENTROPY}, 'CurrentUser'))`;
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], readFileSync(file, "utf8"));
  },
  save(dataDir, key) {
    const script = `Add-Type -AssemblyName System.Security; $k=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($k, ${DPAPI_ENTROPY}, 'CurrentUser'))`;
    writeFileSync(
      join(dataDir, "db.key.dpapi"),
      run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], key),
      "utf8",
    );
  },
};

const keychain: KeyStore = {
  id: "keychain",
  label: "Trousseau macOS",
  load(dataDir) {
    try {
      return (
        run("security", ["find-generic-password", "-s", "Jarod-One database", "-a", accountFor(dataDir), "-w"]) || null
      );
    } catch {
      return null;
    }
  },
  save(dataDir, key) {
    run("security", ["add-generic-password", "-U", "-s", "Jarod-One database", "-a", accountFor(dataDir), "-w", key]);
  },
};

const libsecret: KeyStore = {
  id: "libsecret",
  label: "Trousseau du système (libsecret)",
  load(dataDir) {
    try {
      return run("secret-tool", ["lookup", "service", "jarod-one", "account", accountFor(dataDir)]) || null;
    } catch {
      return null;
    }
  },
  save(dataDir, key) {
    run(
      "secret-tool",
      ["store", "--label=Jarod-One database", "service", "jarod-one", "account", accountFor(dataDir)],
      key,
    );
  },
};

/** Last resort when no OS store works: a key file readable by the owner only. */
export const fileKeyStore: KeyStore = {
  id: "file",
  label: "Fichier local (aucun trousseau disponible)",
  load(dataDir) {
    const file = join(dataDir, "db.key");
    return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
  },
  save(dataDir, key) {
    const file = join(dataDir, "db.key");
    writeFileSync(file, key, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* not supported on every filesystem */
    }
  },
};

/** In-memory store (tests). */
export function memoryKeyStore(): KeyStore {
  const keys = new Map<string, string>();
  return {
    id: "memory",
    label: "Mémoire (tests)",
    load: (dir) => keys.get(resolve(dir)) ?? null,
    save: (dir, key) => void keys.set(resolve(dir), key),
  };
}

/** Preferred stores for this platform, most secure first; the file store is always the fallback. */
export function defaultKeyStores(platform = process.platform): KeyStore[] {
  const native = platform === "win32" ? [dpapi] : platform === "darwin" ? [keychain] : [libsecret];
  return [...native, fileKeyStore];
}

export class DbKeyError extends Error {}

/**
 * Returns the key for a profile's database, creating one on first use. Never creates a new key for
 * a database that is already encrypted: that would make it unreadable.
 */
export function resolveDbKey(
  dataDir: string,
  stores: KeyStore[],
  dbIsEncrypted: boolean,
): { key: string; store: KeyStore } {
  const errors: string[] = [];
  for (const store of stores) {
    try {
      const key = store.load(dataDir);
      if (key) return { key, store };
    } catch (e) {
      errors.push(`${store.label} : ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (dbIsEncrypted) {
    throw new DbKeyError(
      `La base de ce profil est chiffrée mais sa clé est introuvable pour ce compte utilisateur${errors.length ? ` (${errors.join(" ; ")})` : ""}. Restaurez plutôt une sauvegarde protégée par mot de passe.`,
    );
  }
  const key = randomBytes(32).toString("hex");
  for (const store of stores) {
    try {
      store.save(dataDir, key);
      // Only trust a store that gives the key back.
      if (store.load(dataDir) === key) return { key, store };
    } catch {
      /* try the next store */
    }
  }
  throw new DbKeyError("Impossible d'enregistrer la clé de chiffrement de la base.");
}
