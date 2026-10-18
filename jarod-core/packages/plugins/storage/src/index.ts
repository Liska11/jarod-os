/**
 * @jarod/plugin-storage — `ctx.storage` : base SQLite (WAL, chiffrée chacha20), journal
 * d'événements, points de reprise de fichiers. Ouverture reprise de `core.ts:331-355,377`.
 */
import { hkdfSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { plainCipher, StorageConfig } from "@jarod/contracts";
import { type Context, Service } from "cordis";
import { CheckpointService } from "./checkpoints.js";
import { checkDbFile, Db, isEncryptedDb } from "./db.js";
import { DbKeyError, defaultKeyStores, type KeyStore, resolveDbKey } from "./dbkey.js";
import { EventStoreService } from "./eventstore.js";
import { NotificationService } from "./notifications.js";
import { SettingsService } from "./settings.js";

export * from "./checkpoints.js";
export * from "./db.js";
export * from "./dbkey.js";
export * from "./eventstore.js";
export * from "./os-crypt.js";

declare module "cordis" {
  interface Context {
    storage: StorageService;
  }
}

export interface DbEncryption {
  encrypted: boolean;
  keyStore: string | null;
  /** Le magasin qui a VRAIMENT rendu la clé à l'ouverture (null : base en clair). */
  keyStoreId: KeyStore["id"] | null;
  /** Clé dans un simple fichier (aucun trousseau disponible). */
  weak: boolean;
}

export class StorageService extends Service {
  static override readonly name = "storage";
  static readonly Config = StorageConfig;

  readonly dataDir: string;
  readonly dbPath: string;
  readonly db: Db;
  readonly dbEncryption: DbEncryption;
  readonly events: EventStoreService;
  readonly checkpoints: CheckpointService;
  readonly settings: SettingsService;
  readonly notifications: NotificationService;
  /** Clé des pièces jointes, dérivée de celle de la base (`core.ts:341-342`) ; null si base en clair. */
  readonly fileKey: Buffer | null;
  /** Magasins de clés de ce compte (les mêmes pour tous les profils) ; vide si base en clair. */
  private readonly keyStores: KeyStore[];
  private readonly nativeBinding: string | undefined;

  constructor(ctx: Context, input: StorageConfig) {
    super(ctx, "storage");
    const options = StorageConfig.parse(input);
    this.dataDir = options.dataDir;
    mkdirSync(options.dataDir, { recursive: true });
    this.dbPath = join(options.dataDir, "jarod.db");
    const native = options.nativeBinding ? { nativeBinding: options.nativeBinding } : {};
    this.nativeBinding = options.nativeBinding;
    this.keyStores = options.encryptDb ? ((options.keyStores as KeyStore[] | undefined) ?? defaultKeyStores()) : [];
    if (options.encryptDb) {
      const { key, store } = resolveDbKey(options.dataDir, this.keyStores, isEncryptedDb(this.dbPath));
      // Attachments get their own key, derived from the database key.
      this.fileKey = Buffer.from(hkdfSync("sha256", Buffer.from(key, "utf8"), Buffer.alloc(0), "jarod-one attachments", 32));
      this.db = new Db(this.dbPath, { key, ...native });
      this.dbEncryption = { encrypted: true, keyStore: store.label, keyStoreId: store.id, weak: store.id === "file" };
    } else {
      this.fileKey = null;
      this.db = new Db(this.dbPath, native);
      this.dbEncryption = { encrypted: false, keyStore: null, keyStoreId: null, weak: false };
    }
    this.events = new EventStoreService(this.db, options.eventsKeep ? { keep: options.eventsKeep } : {});
    this.checkpoints = new CheckpointService(this.db);
    this.settings = new SettingsService(this.db, options.cipher ?? plainCipher);
    this.notifications = new NotificationService(this.db);
    const db = this.db;
    ctx.effect(() => () => db.close(), "storage:db");
  }

  /**
   * Q14 (restauration dans un profil neuf) : clé DÉJÀ enregistrée pour le dossier d'un profil de ce compte ;
   * null si aucune. Ne crée jamais de clé. Reste dans le main (jamais transmise au renderer).
   */
  findKey(dataDir: string): string | null {
    for (const store of this.keyStores) {
      try {
        const key = store.load(dataDir);
        if (key) return key;
      } catch {
        /* magasin indisponible : le suivant */
      }
    }
    return null;
  }

  /**
   * Q14 : enregistre une clé EXISTANTE (celle du profil d'origine) pour le dossier d'un profil neuf, dans le
   * premier magasin qui la rend telle quelle — les pièces jointes, chiffrées par une clé dérivée de celle de la
   * base, restent lisibles. Refus si ce dossier a déjà une clé (jamais d'écrasement). Rend le libellé du magasin.
   */
  adoptKey(dataDir: string, key: string): string {
    if (this.keyStores.length === 0) throw new DbKeyError("Profil non chiffré : aucune clé à enregistrer.");
    if (this.findKey(dataDir)) throw new DbKeyError(`Ce profil a déjà une clé : ${dataDir}`);
    for (const store of this.keyStores) {
      try {
        store.save(dataDir, key);
        if (store.load(dataDir) === key) return store.label;
      } catch {
        /* magasin suivant */
      }
    }
    throw new DbKeyError("Impossible d'enregistrer la clé du profil restauré.");
  }

  /** Q14 : fichier de base isolé ouvert avec cette clé, intègre (`quick_check`) ; rend sa version. */
  checkDatabaseFile(path: string, key: string | null): { userVersion: number } {
    return checkDbFile(path, key, this.nativeBinding);
  }
}

export default StorageService;
export * from "./settings.js";
export * from "./notifications.js";
