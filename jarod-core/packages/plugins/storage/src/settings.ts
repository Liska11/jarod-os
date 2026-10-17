// Portage de packages/core/src/services/settings.ts:340-403 (rév. 2e180305).
// Les types et DEFAULT_SETTINGS vivent dans @jarod/contracts/settings (DTO partagé).
import { type Cipher, DEFAULT_SETTINGS, type Settings } from "@jarod/contracts";
import { parseJson } from "@jarod/kernel/util";
import type { Db } from "./db.js";

// Les importeurs de `services/settings.js` y trouvaient aussi les types : même surface ici.
export * from "@jarod/contracts/settings";

export class SettingsService {
  /** Abonnements par clé : `{ clé: callbacks }`, retirés par la fonction rendue. */
  private readonly listeners = new Map<keyof Settings, Set<() => void>>();

  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}

  /**
   * S'abonne à l'écriture d'une clé. Le callback est appelé APRÈS l'écriture (donc il lit la
   * valeur nouvelle) et de façon SYNCHRONE dans `set`/`patch` — c'est ce qui rend l'effet
   * immédiat (SPECS-P5-DISABLED-SKILLS DS3 : aucune fenêtre où le réglage est écrit mais pas
   * encore appliqué). Retire l'abonnement.
   */
  onChange(key: keyof Settings, cb: () => void): () => void {
    const set = this.listeners.get(key) ?? new Set<() => void>();
    this.listeners.set(key, set);
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  getAll(): Settings {
    const rows = this.db.all<{ key: string; value: string }>("SELECT key, value FROM settings");
    const stored: Partial<Settings> = {};
    for (const r of rows) (stored as Record<string, unknown>)[r.key] = parseJson(r.value, undefined);
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return row ? parseJson(row.value, DEFAULT_SETTINGS[key]) : DEFAULT_SETTINGS[key];
  }

  /** Le réglage a-t-il été ÉCRIT un jour (par opposition à sa valeur par défaut) ? Un profil vierge n'a encore rien choisi. */
  isSet(key: keyof Settings): boolean {
    return this.db.get<{ key: string }>("SELECT key FROM settings WHERE key = ?", key) !== undefined;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
    // Après l'écriture : l'abonné lit la valeur nouvelle, synchrone (voir onChange).
    const subs = this.listeners.get(key);
    if (subs) for (const cb of [...subs]) cb();
  }

  patch(values: Partial<Settings>): Settings {
    // Une clé absente de DEFAULT_SETTINGS est toujours ÉCARTÉE (un profil exporté par une autre version ne doit pas casser un enregistrement),
    // mais plus EN SILENCE (audit D-09) : les NOMS sont dits, jamais les valeurs. Les clés connues du même lot sont écrites.
    const dropped = Object.keys(values).filter((k) => !Object.hasOwn(DEFAULT_SETTINGS, k));
    if (dropped.length > 0) console.warn(`[settings] clé(s) inconnue(s) ignorée(s) : ${dropped.join(", ")} — à ajouter à DEFAULT_SETTINGS (contracts/src/settings.ts)`);
    this.db.tx(() => {
      for (const [k, v] of Object.entries(values)) {
        if (Object.hasOwn(DEFAULT_SETTINGS, k)) this.set(k as keyof Settings, v as never);
      }
    });
    return this.getAll();
  }

  // --- Secrets (API keys, tokens): encrypted with the injected cipher, never returned to the renderer. ---

  setSecret(key: string, value: string): void {
    if (!value) {
      this.db.run("DELETE FROM secrets WHERE key = ?", key);
      return;
    }
    this.db.run(
      "INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      this.cipher.encrypt(value),
    );
  }

  getSecret(key: string): string | undefined {
    const row = this.db.get<{ value: string }>("SELECT value FROM secrets WHERE key = ?", key);
    if (!row) return undefined;
    try {
      return this.cipher.decrypt(row.value);
    } catch {
      return undefined;
    }
  }

  /**
   * Clés dont la valeur ne peut PLUS être lue (chiffreur absent, valeur non chiffrée par le trousseau de l'OS — refus assumé, AV2-009).
   * Les NOMS seulement, jamais une valeur : la fenêtre les liste et propose la ressaisie (aucune migration automatique).
   */
  unreadableSecrets(): string[] {
    const out: string[] = [];
    for (const r of this.db.all<{ key: string; value: string }>("SELECT key, value FROM secrets ORDER BY key")) {
      try {
        this.cipher.decrypt(r.value);
      } catch {
        out.push(r.key);
      }
    }
    return out;
  }

  secretKeys(): string[] {
    return this.db.all<{ key: string }>("SELECT key FROM secrets").map((r) => r.key);
  }
}
