// Portage de packages/core/src/services/vault.ts (rév. 2e180305).
import type { SettingsService } from "@jarod/plugin-storage";
import { type VaultEntry } from "@jarod/contracts";
export type { VaultEntry };

/**
 * The credential vault: the agent logs in without ever seeing a password or a key.
 *
 * The model only knows names (`github_token`) and what each one is for. A value leaves the vault at
 * the last moment and only into places its owner allowed: as an environment variable of a shell
 * command (when `allowShell`), or inside a `{{secret:NAME}}` placeholder of an HTTP request to one
 * of its domains. Whatever comes back (command output, response body) has the values replaced by
 * `[secret:NAME]` before the model reads it — an API that echoes a token does not leak it either.
 *
 * Values live in the encrypted `secrets` table (never in the settings, which can be exported);
 * names, descriptions and domains are settings.
 */

// VaultEntry : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

export const VAULT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const vaultKey = (name: string) => `vault:${name}`;
const PLACEHOLDER = /\{\{secret:([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;

export interface UsedSecret {
  name: string;
  value: string;
}

/** True when `host` is one of `domains` (a `*.` entry covers the subdomains, not the domain itself). */
export function hostAllowed(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((raw) => {
    const d = raw.trim().toLowerCase();
    if (!d) return false;
    if (d.startsWith("*.")) return h.endsWith(d.slice(1));
    return h === d;
  });
}

export class VaultService {
  /**
   * Temporary entries (Jarod-OS « usage temporaire ») : the entry AND its value live only in this map, for this run of the core.
   * Never in the settings, never in the `secrets` table, so never in a backup; gone at the next start.
   */
  private readonly temporary = new Map<string, { entry: VaultEntry; value: string }>();

  constructor(private readonly settings: SettingsService) {}

  private stored(): VaultEntry[] {
    return this.settings.get("vault") ?? [];
  }

  list(): VaultEntry[] {
    return [...this.stored(), ...[...this.temporary.values()].map((t) => t.entry)];
  }

  get(name: string): VaultEntry | undefined {
    return this.list().find((e) => e.name === name);
  }

  hasValue(name: string): boolean {
    return this.temporary.has(name) || Boolean(this.settings.getSecret(vaultKey(name)));
  }

  /** Adds or updates an entry. `value` undefined keeps the stored one (editing the description). */
  save(input: Omit<VaultEntry, "createdAt" | "envVar"> & { envVar?: string }, value?: string): VaultEntry {
    const name = input.name.trim();
    if (!VAULT_NAME.test(name)) {
      throw new Error("Nom de secret invalide : une lettre, puis lettres, chiffres ou « _ » (64 au plus).");
    }
    const envVar = (input.envVar ?? "").trim() || name.toUpperCase();
    if (!ENV_NAME.test(envVar)) throw new Error(`Nom de variable d'environnement invalide : ${envVar}`);
    const existing = this.get(name);
    if (!existing && !value) throw new Error("Un nouveau secret a besoin d'une valeur.");
    const temporary = existing ? Boolean(existing.temporary) : Boolean(input.temporary);
    if (existing && input.temporary !== undefined && Boolean(input.temporary) !== temporary) {
      throw new Error("Un secret ne passe pas de temporaire à enregistré (ni l'inverse) : supprimez-le et recréez-le.");
    }
    const entry: VaultEntry = {
      name,
      description: input.description.trim().slice(0, 300),
      envVar,
      domains: [...new Set(input.domains.map((d) => d.trim().toLowerCase()).filter(Boolean))],
      allowShell: Boolean(input.allowShell),
      createdAt: existing?.createdAt ?? Date.now(),
      ...(input.kind && input.kind !== "other" ? { kind: input.kind } : {}),
      ...(temporary ? { temporary: true } : {}),
    };
    if (temporary) {
      const previous = this.temporary.get(name);
      this.temporary.set(name, { entry, value: value || previous?.value || "" });
      return entry;
    }
    if (value) this.settings.setSecret(vaultKey(name), value);
    this.settings.set("vault", [...this.stored().filter((e) => e.name !== name), entry]);
    return entry;
  }

  remove(name: string): void {
    if (this.temporary.delete(name)) return;
    this.settings.setSecret(vaultKey(name), "");
    this.settings.set(
      "vault",
      this.stored().filter((e) => e.name !== name),
    );
  }

  private value(name: string): string {
    const entry = this.get(name);
    const value = this.temporary.get(name)?.value ?? this.settings.getSecret(vaultKey(name));
    if (!entry || !value) throw new Error(`Secret inconnu dans le coffre : ${name}`);
    return value;
  }

  /** Environment variables for a shell command; refuses a secret not allowed in the shell. */
  shellEnv(names: string[]): { env: Record<string, string>; used: UsedSecret[] } {
    const env: Record<string, string> = {};
    const used: UsedSecret[] = [];
    for (const name of [...new Set(names)]) {
      const entry = this.get(name);
      if (!entry) throw new Error(`Secret inconnu dans le coffre : ${name}`);
      if (!entry.allowShell) {
        throw new Error(`Le secret « ${name} » n'est pas autorisé dans les commandes shell (réglage du coffre).`);
      }
      const value = this.value(name);
      env[entry.envVar] = value;
      used.push({ name, value });
    }
    return { env, used };
  }

  /**
   * Replaces the `{{secret:NAME}}` placeholders of a request bound for `url`, refusing any secret
   * whose domains do not include the request's host — a key for GitHub never goes to another site.
   */
  fillRequest(url: URL, parts: string[]): { parts: string[]; used: UsedSecret[] } {
    const used = new Map<string, UsedSecret>();
    const filled = parts.map((part) =>
      part.replace(PLACEHOLDER, (_m, name: string) => {
        const entry = this.get(name);
        if (!entry) throw new Error(`Secret inconnu dans le coffre : ${name}`);
        if (url.protocol !== "https:") throw new Error(`Le secret « ${name} » ne part qu'en https.`);
        if (!hostAllowed(url.hostname, entry.domains)) {
          throw new Error(
            `Le secret « ${name} » n'est pas autorisé pour ${url.hostname} (domaines permis : ${entry.domains.join(", ") || "aucun"}).`,
          );
        }
        const value = this.value(name);
        used.set(name, { name, value });
        return value;
      }),
    );
    return { parts: filled, used: [...used.values()] };
  }

  /** The text with every used value replaced by `[secret:NAME]`. */
  static redact(text: string, used: UsedSecret[]): string {
    let out = text;
    // Longest first: a value that contains another is replaced whole.
    for (const s of [...used].sort((a, b) => b.value.length - a.value.length)) {
      if (s.value.length < 4) continue;
      // The value as sent, and the forms a server commonly echoes it back in.
      for (const form of new Set([s.value, encodeURIComponent(s.value), Buffer.from(s.value).toString("base64")])) {
        out = out.split(form).join(`[secret:${s.name}]`);
      }
    }
    return out;
  }
}
