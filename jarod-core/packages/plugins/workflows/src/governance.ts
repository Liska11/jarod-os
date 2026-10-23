/**
 * V-06 — la plateforme de plugins (plugin-platform : manifeste signé, permissions accordées, dépendances, mise à jour annulée si elle échoue,
 * quarantaine, retour arrière) branchée sur l'hôte réel des plugins utilisateur (`PluginHost`, un processus isolé par plugin).
 *
 * Règle : un plugin ne TOURNE que si la plateforme l'a installé et activé, avec un manifeste signé par une clé de confiance — un éditeur, ou la
 * clé locale du profil quand la personne l'approuve elle-même — qui fixe son identifiant, sa version, ses permissions et l'EMPREINTE de son
 * contenu. Un dossier déposé dans `plugins/` n'est plus lancé tout seul ; un plugin modifié après son approbation ne tourne plus jusqu'à une
 * nouvelle approbation. Chaque version approuvée est gardée (`plugin-versions/`) : le retour arrière remet son contenu en place.
 *
 * Ce module ne demande rien à la personne : l'approbation (`approve`) n'est appelée qu'après la confirmation native (bridge) ; le canal
 * d'accord des permissions qu'il attache à la plateforme n'accorde que l'approbation EN COURS, une fois.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { digestOf, type PluginHost, type PluginPermission, restoreVersion, saveVersion } from "./plugins.js";

/** Un manifeste de la plateforme (plugin-platform `PluginManifest`, vu par sa forme : ce paquet n'en dépend pas). */
export interface PlatformManifest {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  permissions: string[];
  quotas: { memoryMb: number; diskMb: number; vramMb: number };
  payloadSha256: string;
  signature?: { keyId: string; value: string };
}

export interface PlatformRecordView {
  manifest: PlatformManifest;
  status: "installed" | "enabled" | "disabled" | "quarantined";
  previous?: PlatformManifest;
  reason?: string;
}

/** Ce que la gouvernance utilise de `ctx.plugins` (plugin-platform `PlatformService`). */
export interface PlatformPort {
  list(): PlatformRecordView[];
  install(manifest: PlatformManifest): Promise<unknown>;
  update(manifest: PlatformManifest): Promise<unknown>;
  enable(name: string): Promise<void>;
  disable(name: string, cascade?: boolean): Promise<void>;
  rollback(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  release(name: string): void;
  verifies(manifest: PlatformManifest): boolean;
  signLocal(manifest: PlatformManifest): PlatformManifest;
  attachHost(host: { activate(m: PlatformManifest): Promise<void>; deactivate(name: string): Promise<void>; health(name: string): Promise<boolean> }): void;
  attachApprover(approve: (request: { name: string; version: string; permissions: string[] }) => Promise<boolean>): void;
}

/** Ce que l'écran et `/plugin` disent de l'approbation d'un plugin. */
export interface PluginApproval {
  status: "approved" | "unapproved" | "modified" | "disabled" | "quarantined";
  /** La version approuvée, et celle d'avant (retour arrière possible) s'il y en a une. */
  version?: string;
  previous?: string;
  /** `local-n` : approuvé par la personne ; un autre identifiant : un éditeur de confiance. */
  signer?: string;
  reason?: string;
}

/** Ce qu'un plugin utilisateur déclare comme ressources quand son `plugin.json` n'en dit rien (bornes de la plateforme). */
export const DEFAULT_QUOTAS = { memoryMb: 256, diskMb: 200, vramMb: 0 } as const;

const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

const samePermissions = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export class PluginGovernance {
  /** Les plugins que la plateforme laisse tourner : son état « activé », et l'activation en cours (avant que la plateforme ne l'inscrive). */
  private readonly allowed = new Map<string, PlatformManifest>();
  /** L'approbation en cours : la seule demande de permissions que le canal d'accord accorde. */
  private pending: string | null = null;

  constructor(
    private readonly host: PluginHost,
    private readonly platform: PlatformPort,
    private readonly versions: string,
  ) {
    for (const r of platform.list()) if (r.status === "enabled") this.allowed.set(r.manifest.name, r.manifest);
    platform.attachHost({
      activate: (m) => this.activate(m),
      deactivate: (name) => this.deactivate(name),
      health: async (name) => this.host.list().find((p) => p.id === name)?.state === "active",
    });
    platform.attachApprover(async (request) => {
      const ok = this.pending === request.name;
      this.pending = null;
      return ok;
    });
  }

  /** L'admission de `PluginHost.reload` : `null` = ce contenu exact est approuvé, signé, activé ; sinon la raison, dite à la personne. */
  readonly admit = (p: { id: string; version: string; permissions: PluginPermission[]; digest: string }): string | null => {
    const m = this.allowed.get(p.id);
    const record = this.platform.list().find((r) => r.manifest.name === p.id);
    if (!m) {
      if (record?.status === "quarantined") return `en quarantaine : ${record.reason ?? "contrôles de santé échoués"}`;
      if (record) return `approuvé (${record.manifest.version}) mais désactivé`;
      return "non approuvé : un plugin ne tourne qu'après votre approbation (Réglages › Plugins), qui signe son contenu";
    }
    if (!this.platform.verifies(m)) return "signature invalide : approbation à refaire";
    if (m.payloadSha256 !== p.digest) return `contenu modifié depuis l'approbation de la version ${m.version} : approuvez la nouvelle version, ou revenez à l'ancienne`;
    if (m.version !== p.version) return `version ${p.version} différente de la version approuvée ${m.version}`;
    if (!samePermissions(m.permissions, p.permissions)) return "permissions différentes de celles approuvées";
    return null;
  };

  private async activate(m: PlatformManifest): Promise<void> {
    const root = this.host.rootOf(m.name);
    if (!existsSync(root)) throw new Error(`dossier du plugin introuvable : ${m.name}`);
    // Le retour arrière, et l'annulation d'une mise à jour qui échoue, passent par ici avec l'ANCIEN manifeste : son contenu est remis en place.
    if ((await digestOf(root)) !== m.payloadSha256 && !(await restoreVersion(root, join(this.versions, m.name), m.payloadSha256))) {
      throw new Error(`le contenu de ${m.name} ${m.version} n'est plus disponible`);
    }
    this.allowed.set(m.name, m);
    const info = (await this.host.refresh(m.name)).find((p) => p.id === m.name);
    // Un échec d'activation garde l'erreur du plugin à l'écran (état `error`) ; la plateforme, elle, le laisse non activé, et une mise à jour
    // qui échoue la fait revenir à l'ancienne version (deactivate puis activate de l'ancien manifeste).
    if (info?.state !== "active") throw new Error(info?.error || `${m.name} ne s'est pas activé`);
  }

  private async deactivate(name: string): Promise<void> {
    this.allowed.delete(name);
    await this.host.refresh(name);
  }

  status(id: string): PluginApproval {
    const record = this.platform.list().find((r) => r.manifest.name === id);
    const info = this.host.list().find((p) => p.id === id);
    if (!record) return { status: "unapproved" };
    const base = { version: record.manifest.version, ...(record.previous ? { previous: record.previous.version } : {}), ...(record.manifest.signature ? { signer: record.manifest.signature.keyId } : {}) };
    if (record.status === "quarantined") return { status: "quarantined", ...base, ...(record.reason ? { reason: record.reason } : {}) };
    if (info?.digest && info.digest !== record.manifest.payloadSha256) return { status: "modified", ...base };
    if (record.status !== "enabled") return { status: "disabled", ...base };
    return { status: "approved", ...base };
  }

  /**
   * Approuve le contenu ACTUEL du plugin (après la confirmation native) : signé par la clé locale, gardé, puis installé — ou mis à jour, ce qui
   * exige une version plus haute et s'annule tout seul si la nouvelle version échoue — et activé.
   */
  async approve(id: string, shown?: string): Promise<PluginApproval> {
    // Le dossier tel qu'il est MAINTENANT (manifeste, permissions, empreinte) : c'est ce contenu-là que la personne approuve.
    const info = (await this.host.refresh(id)).find((p) => p.id === id);
    if (!info || info.state === "error") throw new Error(info?.error ?? `plugin inconnu : ${id}`);
    if (!NAME.test(id)) throw new Error(`identifiant « ${id} » : une lettre minuscule d'abord, 41 caractères au plus, pour être signé`);
    if (!VERSION.test(info.version)) throw new Error(`version « ${info.version} » : x.y.z attendu pour être signé`);
    const root = this.host.rootOf(id);
    const digest = await digestOf(root);
    // `shown` : l'empreinte que la boîte de confirmation a montrée. Un contenu changé entre-temps n'est pas celui que la personne a approuvé.
    if (shown !== undefined && shown !== digest) throw new Error("le contenu du plugin a changé pendant la confirmation : rien n'a été approuvé, recommencez");
    // Approuver, c'est aussi vouloir qu'il tourne.
    this.host.markEnabled(id, true);
    const signed = this.platform.signLocal({ name: id, version: info.version, dependencies: {}, permissions: [...info.permissions], quotas: { ...DEFAULT_QUOTAS }, payloadSha256: digest });
    await saveVersion(root, join(this.versions, id), digest);
    const record = this.platform.list().find((r) => r.manifest.name === id);
    // Une nouvelle approbation sort de quarantaine (geste explicite de la personne), avant tout le reste.
    if (record?.status === "quarantined") this.platform.release(id);
    this.pending = id;
    try {
      if (!record) await this.platform.install(signed);
      else if (record.manifest.payloadSha256 !== digest) {
        if (record.manifest.version === info.version) {
          throw new Error(`le contenu a changé mais la version est toujours ${info.version} : montez la version dans plugin.json pour approuver une mise à jour (le retour arrière en dépend)`);
        }
        await this.platform.update(signed);
      }
    } finally {
      this.pending = null;
    }
    const now = this.platform.list().find((r) => r.manifest.name === id);
    if (now && now.status !== "enabled") await this.platform.enable(id);
    // Déjà activé (mise à jour faite, ou même contenu) mais pas encore admis par l'hôte : on le lance.
    else if (now && !this.allowed.has(id)) await this.activate(now.manifest);
    return this.status(id);
  }

  /** Revient à la version approuvée précédente (son contenu gardé est remis en place). */
  async rollback(id: string): Promise<PluginApproval> {
    await this.platform.rollback(id);
    const record = this.platform.list().find((r) => r.manifest.name === id);
    // Désactivé, la plateforme ne fait que changer de manifeste : le contenu est remis tout de suite, pour que le dossier dise la vérité.
    if (record && record.status !== "enabled") await restoreVersion(this.host.rootOf(id), join(this.versions, id), record.manifest.payloadSha256);
    return this.status(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = this.platform.list().find((r) => r.manifest.name === id);
    if (!record) {
      if (enabled) throw new Error(`« ${id} » n'est pas approuvé : approuvez-le d'abord`);
      return;
    }
    this.host.markEnabled(id, enabled);
    if (enabled) await this.platform.enable(id);
    else await this.platform.disable(id, true);
  }

  /** Retire l'approbation : le plugin s'arrête et redevient « non approuvé » (ses versions gardées restent pour une nouvelle approbation). */
  async revoke(id: string): Promise<void> {
    await this.platform.remove(id);
    this.allowed.delete(id);
    await this.host.refresh(id);
  }

  /** Le plugin d'exemple que Jarod pose lui-même au premier lancement : approuvé d'office, comme il était activé d'office avant V-06. */
  async approveSeeded(id: string): Promise<void> {
    if (!this.platform.list().some((r) => r.manifest.name === id)) await this.approve(id);
  }
}
