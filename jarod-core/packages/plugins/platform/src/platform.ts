/**
 * Cycle de vie des plugins : installer, activer, désactiver, mettre à jour, retirer, avec retour arrière,
 * quarantaine, budgets et contrôles de santé.
 *
 * Règles tenues (chacune testée) :
 *  - rien n'est installé sans manifeste signé par une clé de confiance, ni sans que l'empreinte du contenu
 *    fourni corresponde à celle du manifeste signé ;
 *  - les permissions déclarées passent par un accord explicite ; sans canal d'accord, l'installation est
 *    refusée. Un plugin n'a jamais d'autre permission que celles qu'il a déclarées ;
 *  - les dépendances sont résolues avant d'agir : un cycle, un manque, une version hors plage, ou un retrait
 *    qui casserait un dépendant, sont des refus qui ne changent rien ;
 *  - une mise à jour qui échoue (activation ou santé) est ANNULÉE : l'ancienne version est réactivée ;
 *  - un plugin malade (échecs répétés) ou qui dépasse son quota est mis en quarantaine, désactivé avec ses
 *    dépendants, et n'en sort que par un geste explicite ;
 *  - l'état est écrit atomiquement ; l'audit ne contient que des noms, versions, statuts et raisons.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { activationOrder, dependents, GraphError, satisfies } from "./graph.js";
import { type Permission, type PluginManifest, type Quotas, type TrustedKeys, verifyManifest } from "./manifest.js";

export class PlatformError extends Error {}

export type PluginStatus = "installed" | "enabled" | "disabled" | "quarantined";

export interface PluginRecord {
  manifest: PluginManifest;
  status: PluginStatus;
  previous?: PluginManifest;
  failures: number;
  reason?: string;
}

/** Ce que le gestionnaire demande à l'hôte : charger, décharger, et dire si le plugin se porte bien. */
export interface PluginHost {
  activate(manifest: PluginManifest): Promise<void>;
  deactivate(name: string): Promise<void>;
  health(name: string): Promise<boolean>;
}

export type PermissionApprover = (request: { name: string; version: string; permissions: Permission[] }) => Promise<boolean>;

export interface PlatformEvent {
  at: number;
  name: string;
  action: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface PlatformDeps {
  stateFile: string;
  trusted: TrustedKeys;
  host: PluginHost;
  approve?: PermissionApprover | null;
  onEvent?: (e: PlatformEvent) => void;
  /** Échecs de santé consécutifs avant la quarantaine. */
  maxFailures?: number;
  /** Plafonds de la zone, sommes des quotas des plugins installés. Absent : pas de plafond sur cette ressource. */
  budgets?: Partial<Quotas>;
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export class PluginPlatform {
  private records = new Map<string, PluginRecord>();

  constructor(private readonly d: PlatformDeps) {
    if (existsSync(d.stateFile)) {
      const raw = JSON.parse(readFileSync(d.stateFile, "utf8")) as Record<string, PluginRecord>;
      this.records = new Map(Object.entries(raw));
    }
  }

  private emit(name: string, action: string, detail: PlatformEvent["detail"] = {}): void {
    this.d.onEvent?.({ at: Date.now(), name, action, detail });
  }

  private persist(): void {
    mkdirSync(dirname(this.d.stateFile), { recursive: true });
    const tmp = `${this.d.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.records), null, 2));
    renameSync(tmp, this.d.stateFile);
  }

  list(): PluginRecord[] {
    return [...this.records.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  get(name: string): PluginRecord {
    const r = this.records.get(name);
    if (!r) throw new PlatformError(`plugin inconnu : ${name}`);
    return r;
  }

  private manifests(): Map<string, PluginManifest> {
    return new Map([...this.records].map(([n, r]) => [n, r.manifest]));
  }

  private withStatus(...statuses: PluginStatus[]): string[] {
    return [...this.records].filter(([, r]) => statuses.includes(r.status)).map(([n]) => n);
  }

  /** Un plugin n'a que les permissions qu'il a déclarées, et seulement tant qu'il est actif. */
  allowed(name: string, permission: Permission): boolean {
    const r = this.records.get(name);
    return !!r && r.status === "enabled" && r.manifest.permissions.includes(permission);
  }

  private checkBudgets(candidate: PluginManifest, replacing?: string): void {
    const budgets = this.d.budgets;
    if (!budgets) return;
    const sums: Quotas = { memoryMb: 0, diskMb: 0, vramMb: 0 };
    for (const [n, r] of this.records) {
      if (n === replacing) continue;
      sums.memoryMb += r.manifest.quotas.memoryMb;
      sums.diskMb += r.manifest.quotas.diskMb;
      sums.vramMb += r.manifest.quotas.vramMb;
    }
    for (const key of ["memoryMb", "diskMb", "vramMb"] as const) {
      const cap = budgets[key];
      if (cap !== undefined && sums[key] + candidate.quotas[key] > cap) {
        throw new PlatformError(`budget ${key} dépassé : ${sums[key]} + ${candidate.quotas[key]} > ${cap}`);
      }
    }
  }

  private verify(manifest: PluginManifest, payload?: Buffer): void {
    verifyManifest(manifest, this.d.trusted);
    if (payload && sha256(payload) !== manifest.payloadSha256) {
      throw new PlatformError(`${manifest.name} : le contenu ne correspond pas à l'empreinte signée`);
    }
  }

  private checkDependencies(manifest: PluginManifest, among: Map<string, PluginManifest>): void {
    const next = new Map(among).set(manifest.name, manifest);
    try {
      activationOrder(next, [manifest.name]);
    } catch (e) {
      throw new PlatformError((e as GraphError).message);
    }
  }

  async install(manifest: PluginManifest, payload?: Buffer): Promise<PluginRecord> {
    if (this.records.has(manifest.name)) throw new PlatformError(`${manifest.name} est déjà installé (utiliser update)`);
    this.verify(manifest, payload);
    this.checkDependencies(manifest, this.manifests());
    this.checkBudgets(manifest);
    if (manifest.permissions.length) {
      if (!this.d.approve) throw new PlatformError(`${manifest.name} déclare des permissions et aucun canal d'accord n'est branché`);
      const ok = await this.d.approve({ name: manifest.name, version: manifest.version, permissions: manifest.permissions }).catch(() => false);
      if (!ok) throw new PlatformError(`${manifest.name} : permissions refusées par l'utilisateur`);
    }
    const record: PluginRecord = { manifest, status: "installed", failures: 0 };
    this.records.set(manifest.name, record);
    this.persist();
    this.emit(manifest.name, "install", { version: manifest.version });
    return record;
  }

  /** Active le plugin et, avant lui, ses dépendances. Si l'un échoue, tout ce qui vient d'être activé est défait. */
  async enable(name: string): Promise<void> {
    const rec = this.get(name);
    if (rec.status === "quarantined") throw new PlatformError(`${name} est en quarantaine : ${rec.reason ?? ""}`);
    const order = (() => {
      try {
        return activationOrder(this.manifests(), [name]);
      } catch (e) {
        throw new PlatformError((e as GraphError).message);
      }
    })();
    for (const n of order) {
      if (this.get(n).status === "quarantined") throw new PlatformError(`${name} dépend de ${n}, qui est en quarantaine`);
    }
    const started: string[] = [];
    for (const n of order) {
      const r = this.get(n);
      if (r.status === "enabled") continue;
      try {
        await this.d.host.activate(r.manifest);
        started.push(n);
        if (!(await this.d.host.health(n))) throw new PlatformError(`${n} : contrôle de santé échoué à l'activation`);
      } catch (e) {
        for (const s of started.reverse()) await this.d.host.deactivate(s).catch(() => undefined);
        r.failures += 1;
        this.persist();
        this.emit(n, "enable-failed", { error: (e as Error).message.slice(0, 200) });
        throw e instanceof PlatformError ? e : new PlatformError(`${n} : activation échouée (${(e as Error).message})`);
      }
    }
    for (const n of started) {
      const r = this.get(n);
      r.status = "enabled";
      r.failures = 0;
      delete r.reason;
      this.emit(n, "enable", { version: r.manifest.version });
    }
    this.persist();
  }

  async disable(name: string, cascade = false): Promise<void> {
    const rec = this.get(name);
    const active = dependents(this.manifests(), this.withStatus("enabled"), name);
    if (active.length && !cascade) throw new PlatformError(`${name} est nécessaire à : ${active.join(", ")}`);
    for (const dep of active.reverse()) await this.stop(dep, "disabled", `dépendance ${name} désactivée`);
    if (rec.status === "enabled") await this.stop(name, "disabled");
    else if (rec.status === "installed") rec.status = "disabled";
    this.persist();
  }

  private async stop(name: string, status: PluginStatus, reason?: string): Promise<void> {
    const r = this.get(name);
    await this.d.host.deactivate(name).catch(() => undefined);
    r.status = status;
    if (reason) r.reason = reason;
    this.emit(name, status === "quarantined" ? "quarantine" : "disable", reason ? { reason } : {});
  }

  /**
   * Met à jour. La version doit monter, les dépendances être satisfaites, les dépendants ne pas être cassés.
   * Si le plugin était actif et que la nouvelle version échoue, l'ancienne est réactivée.
   */
  async update(manifest: PluginManifest, payload?: Buffer): Promise<PluginRecord> {
    const rec = this.get(manifest.name);
    this.verify(manifest, payload);
    const old = rec.manifest;
    const [a, b] = [old.version, manifest.version].map((v) => v.split(".").map(Number));
    if ((b![0]! - a![0]! || b![1]! - a![1]! || b![2]! - a![2]!) <= 0) throw new PlatformError(`${manifest.name} : ${manifest.version} ne dépasse pas ${old.version}`);
    for (const dep of dependents(this.manifests(), this.records.keys(), manifest.name)) {
      const range = this.get(dep).manifest.dependencies[manifest.name];
      if (range && !satisfies(manifest.version, range)) throw new PlatformError(`${dep} exige ${manifest.name} ${range} : ${manifest.version} le casserait`);
    }
    this.checkDependencies(manifest, new Map([...this.manifests()].filter(([n]) => n !== manifest.name)));
    this.checkBudgets(manifest, manifest.name);
    const added = manifest.permissions.filter((p) => !old.permissions.includes(p));
    if (added.length) {
      const ok = this.d.approve ? await this.d.approve({ name: manifest.name, version: manifest.version, permissions: added }).catch(() => false) : false;
      if (!ok) throw new PlatformError(`${manifest.name} : les nouvelles permissions (${added.join(", ")}) ne sont pas accordées`);
    }
    const wasEnabled = rec.status === "enabled";
    if (wasEnabled) await this.d.host.deactivate(manifest.name);
    rec.previous = old;
    rec.manifest = manifest;
    if (wasEnabled) {
      try {
        await this.d.host.activate(manifest);
        if (!(await this.d.host.health(manifest.name))) throw new PlatformError("contrôle de santé échoué");
      } catch (e) {
        await this.d.host.deactivate(manifest.name).catch(() => undefined);
        rec.manifest = old;
        delete rec.previous;
        await this.d.host.activate(old);
        this.persist();
        this.emit(manifest.name, "update-rolled-back", { from: old.version, to: manifest.version, error: (e as Error).message.slice(0, 200) });
        throw new PlatformError(`${manifest.name} ${manifest.version} a échoué (${(e as Error).message}) : ${old.version} est rétabli`);
      }
    }
    this.persist();
    this.emit(manifest.name, "update", { from: old.version, to: manifest.version });
    return rec;
  }

  /** Retour manuel à la version précédente. */
  async rollback(name: string): Promise<void> {
    const rec = this.get(name);
    if (!rec.previous) throw new PlatformError(`${name} : aucune version précédente`);
    const wasEnabled = rec.status === "enabled";
    if (wasEnabled) await this.d.host.deactivate(name);
    const from = rec.manifest.version;
    rec.manifest = rec.previous;
    delete rec.previous;
    if (wasEnabled) await this.d.host.activate(rec.manifest);
    this.persist();
    this.emit(name, "rollback", { from, to: rec.manifest.version });
  }

  async remove(name: string): Promise<void> {
    this.get(name);
    const users = dependents(this.manifests(), this.records.keys(), name);
    if (users.length) throw new PlatformError(`${name} est nécessaire à : ${users.join(", ")}`);
    if (this.get(name).status === "enabled") await this.d.host.deactivate(name).catch(() => undefined);
    this.records.delete(name);
    this.persist();
    this.emit(name, "remove");
  }

  /** Une quarantaine : le plugin et ses dépendants actifs sont désactivés. Seul `release` l'en sort. */
  private async quarantine(name: string, reason: string): Promise<void> {
    const deps = dependents(this.manifests(), this.withStatus("enabled"), name).reverse();
    for (const dep of deps) await this.stop(dep, "disabled", `dépendance ${name} en quarantaine`);
    await this.stop(name, "quarantined", reason);
    this.persist();
  }

  /** Un contrôle de santé. `maxFailures` échecs de suite : quarantaine. Rend vrai si le plugin va bien. */
  async checkHealth(name: string): Promise<boolean> {
    const rec = this.get(name);
    if (rec.status !== "enabled") return false;
    let ok = false;
    try {
      ok = await this.d.host.health(name);
    } catch {
      ok = false;
    }
    if (ok) {
      rec.failures = 0;
      this.persist();
      return true;
    }
    rec.failures += 1;
    this.emit(name, "health-failed", { failures: rec.failures });
    if (rec.failures >= (this.d.maxFailures ?? 3)) await this.quarantine(name, `${rec.failures} contrôles de santé échoués de suite`);
    else this.persist();
    return false;
  }

  /** Un relevé de consommation. Au-delà du quota déclaré : quarantaine tout de suite. */
  async reportUsage(name: string, usage: Partial<Quotas>): Promise<void> {
    const rec = this.get(name);
    for (const key of ["memoryMb", "diskMb", "vramMb"] as const) {
      const used = usage[key];
      if (used !== undefined && used > rec.manifest.quotas[key]) {
        await this.quarantine(name, `quota ${key} dépassé : ${used} > ${rec.manifest.quotas[key]}`);
        return;
      }
    }
  }

  /** Sortie de quarantaine, à la demande explicite de l'utilisateur : le plugin redevient « désactivé ». */
  release(name: string): void {
    const rec = this.get(name);
    if (rec.status !== "quarantined") throw new PlatformError(`${name} n'est pas en quarantaine`);
    rec.status = "disabled";
    rec.failures = 0;
    delete rec.reason;
    this.persist();
    this.emit(name, "release");
  }
}
