/**
 * @jarod/plugin-updates — `ctx.updates` (PLAN §2, gap G1).
 *
 * - Dossier local d'installeurs et canaux stable/beta : `updates.ts` porté tel quel ; `updateFolder`,
 *   `updateChannel`, `checkUpdates` = corps de `core.ts:1076-1110` (rév. 2e180305), mêmes noms.
 * - Canal DISTANT (Jarod-cordis, G1) : un `RemoteUpdater` fourni par l'hôte (desktop : electron-updater,
 *   flux generic ou GitHub Releases, sha512 vérifié, Authenticode si le build déclare un éditeur).
 *   `check()` le consulte d'abord ; s'il est injoignable (hors-ligne, flux absent), repli sur le dossier
 *   local. Toute autre erreur (intégrité, signature, flux invalide) remonte : jamais de repli silencieux.
 * - Vérification périodique (source `desktop/src/main/index.ts:430-439` : 15 s puis toutes les 10 min,
 *   si `updates.autoCheck`) : config `timer` ; une nouvelle version émet `update:available`.
 */
import type { KernelEvents } from "@jarod/contracts";
import type { NotificationService, SettingsService } from "@jarod/plugin-storage";
import type {} from "@jarod/plugin-storage";
import type { Context } from "cordis";
import { type Channel, findLocalUpdate, resolveChannel, type UpdateInfo } from "./updates.js";

export * from "./updates.js";

declare module "cordis" {
  interface Context {
    updates: UpdateService;
  }
  interface Events extends KernelEvents {}
}

/** Ce que le canal distant rapporte (electron-updater : `updateInfo`). */
export interface RemoteUpdate {
  version: string;
  releaseNotes?: string | null;
}

/** Le canal distant, fourni par l'hôte (Electron) : le kernel ne charge jamais electron-updater. */
export interface RemoteUpdater {
  /** Nouvelle version sur le flux, ou null. Hors-ligne / flux absent : erreur « injoignable » (`isUnreachable`). */
  check(): Promise<RemoteUpdate | null>;
  /** Télécharge et VÉRIFIE (sha512, signature) la version trouvée. */
  download(onProgress?: (percent: number) => void): Promise<void>;
  /** Quitte et installe la version téléchargée. */
  install(): void;
}

/** La version proposée, et d'où elle vient. */
export type UpdateCandidate =
  | { source: "remote"; version: string; releaseNotes: string | null }
  | { source: "local"; version: string; installer: string; builtAt: number; sha512: string; size: number };

/** Réseau coupé, DNS, refus de connexion, flux non configuré : les cas où le dossier local prend le relais. */
export function isUnreachable(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  const text = `${e?.code ?? ""} ${e?.message ?? String(error)}`;
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|net::ERR_|NO_FEED|app-update\.yml/i.test(text);
}

export interface UpdatesConfig {
  /** Version en cours (`app.getVersion()`) ; défaut : celle de plugin-agent n'est pas lue, dites-la. */
  appVersion?: string;
  /** Dossier par défaut des installeurs (`JAROD_RELEASE_DIR` dans la source) ; le réglage `updates.folder` gagne. */
  updateFolder?: string;
  /** Vérification périodique (desktop) : première après `firstDelayMs`, puis toutes les `intervalMs`. */
  timer?: boolean;
  firstDelayMs?: number;
  intervalMs?: number;
}

export class UpdateService {
  private remote: RemoteUpdater | null = null;
  private candidate: UpdateCandidate | null = null;
  private lastRemoteError: string | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
    private readonly options: { appVersion: string; updateFolder?: string },
    private readonly emit: (c: UpdateCandidate) => void = () => {},
  ) {}

  get appVersion(): string {
    return this.options.appVersion;
  }

  // ---------- core.ts:1076-1110 (corps verbatim) ----------

  /** The folder watched for new installers. */
  updateFolder(): string {
    return this.settings.get("updates").folder || this.options.updateFolder || "";
  }

  /** The channel this installation follows, settings first, running version otherwise. */
  updateChannel(): Channel {
    return resolveChannel(this.settings.get("updates").channel, this.appVersion);
  }

  /** Looks for a newer installer in the update folder; notifies once per new version. */
  checkUpdates(opts: { force?: boolean } = {}): UpdateInfo | null {
    const cfg = this.settings.get("updates");
    const folder = this.updateFolder();
    if (!folder) {
      if (opts.force)
        throw new Error("Choisissez le dossier des installeurs dans Paramètres → Général → Mises à jour.");
      return null;
    }
    // A stable installation is never offered a pre-release, however recent it is.
    const info = findLocalUpdate(this.appVersion, folder, this.updateChannel());
    this.settings.set("updates", { ...cfg, lastChecked: Date.now() });
    if (info && info.version !== cfg.notified) {
      this.notifications.add(
        "info",
        `Jarod-One ${info.version} est prête à installer`,
        "Paramètres → Général → Mises à jour → « Installer et redémarrer ».",
      );
      this.settings.set("updates", { ...this.settings.get("updates"), notified: info.version });
    }
    return info;
  }

  // ---------- Canal distant + repli local (Jarod-cordis, G1) ----------

  /** Branche (ou retire) le canal distant de l'hôte. */
  setRemote(remote: RemoteUpdater | null): void {
    this.remote = remote;
    this.candidate = null;
  }

  hasRemote(): boolean {
    return this.remote !== null;
  }

  /** La dernière version proposée par `check()`. */
  current(): UpdateCandidate | null {
    return this.candidate;
  }

  /** Pourquoi le canal distant n'a pas servi au dernier `check()` (repli local), ou null. */
  remoteError(): string | null {
    return this.lastRemoteError;
  }

  /**
   * Canal distant d'abord ; injoignable → dossier local (sans exiger qu'un dossier soit choisi). Une
   * version distante trouvée ou « rien de neuf » côté flux font foi : le dossier local n'est pas lu.
   */
  async check(): Promise<UpdateCandidate | null> {
    let found: UpdateCandidate | null = null;
    let fallback = !this.remote;
    if (this.remote) {
      try {
        const r = await this.remote.check();
        this.lastRemoteError = null;
        found = r ? { source: "remote", version: r.version, releaseNotes: r.releaseNotes ?? null } : null;
      } catch (e) {
        if (!isUnreachable(e)) throw e;
        this.lastRemoteError = (e as Error).message ?? String(e);
        fallback = true;
      }
    }
    if (fallback) {
      const info = this.checkUpdates();
      found = info ? { source: "local", ...info } : null;
    }
    const isNew = found && found.version !== this.candidate?.version;
    this.candidate = found;
    if (found && isNew) this.emit(found);
    return found;
  }

  /** Télécharge la version distante (vérifiée par l'hôte) ; une version locale est déjà sur le disque. */
  async download(onProgress?: (percent: number) => void): Promise<UpdateCandidate> {
    const c = this.candidate ?? (await this.check());
    if (!c) throw new Error("Aucune nouvelle version à télécharger.");
    if (c.source === "remote") await this.remote!.download(onProgress);
    return c;
  }

  /** Version distante : l'hôte quitte et installe. Version locale : rend l'installeur, que l'hôte lance. */
  install(): { source: "remote" } | { source: "local"; installer: string; sha512: string; size: number } {
    const c = this.candidate;
    if (!c) throw new Error("Aucune nouvelle version : vérifiez d'abord les mises à jour.");
    if (c.source === "remote") {
      this.remote!.install();
      return { source: "remote" };
    }
    // L'hôte DOIT vérifier sha512 + taille sur la copie qu'il lance (`verifyInstaller`) : jamais d'exécution sans cela (AV2-003).
    return { source: "local", installer: c.installer, sha512: c.sha512, size: c.size };
  }
}

export const name = "updates";
export const inject = ["storage"];

export function apply(ctx: Context, config: UpdatesConfig = {}): void {
  const service = new UpdateService(
    ctx.storage.settings,
    ctx.storage.notifications,
    { appVersion: config?.appVersion ?? "0.0.0", ...(config?.updateFolder ? { updateFolder: config.updateFolder } : {}) },
    (c) => ctx.emit("update:available", c),
  );
  ctx.provide("updates", service);
  if (config?.timer) {
    const run = () => {
      if (!ctx.storage.settings.get("updates").autoCheck) return;
      service.check().catch((e: unknown) => {
        ctx.logger("updates").warn(`vérification : ${(e as Error).message}`);
        ctx.emit("update:error", { message: (e as Error).message });
      });
    };
    ctx.effect(() => {
      const first = setTimeout(run, config.firstDelayMs ?? 15_000);
      const every = setInterval(run, config.intervalMs ?? 10 * 60_000);
      return () => {
        clearTimeout(first);
        clearInterval(every);
      };
    }, "updates:timer");
  }
}
