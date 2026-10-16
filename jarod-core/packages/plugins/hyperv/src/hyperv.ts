/**
 * Hyper-V pour les bacs lourds : modèles VHDX, disques différentiels, machines, points de contrôle, réseau
 * virtuel isolé, retour arrière.
 *
 * Ce que ce module garantit, et ce qu'il ne prouve pas :
 *  - GARANTI (testé) : aucune donnée de l'appelant n'est collée dans le texte d'un script PowerShell. Les
 *    scripts sont des constantes ; les paramètres voyagent en JSON dans une variable d'environnement et sont
 *    typés à l'arrivée. Les noms de machines et de commutateurs commencent par `jarod-` (validé ici ET dans le
 *    script) : le service ne peut ni voir ni toucher les machines de l'utilisateur. Les disques ne vivent que
 *    sous la racine gérée, sans lien, en `.vhdx`. Le réseau créé est de type Private : ni l'hôte ni l'extérieur.
 *  - NON PROUVÉ ICI : l'effet réel sur Hyper-V. Les cmdlets existent sur cette machine, mais les piloter exige un
 *    compte administrateur ou « Hyper-V Administrators », ce que la session de développement n'a pas. Les tests
 *    vérifient donc les scripts et les paramètres envoyés à un exécuteur simulé, jamais un résultat Hyper-V.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class HyperVError extends Error {}

export interface PsResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Lance un script PowerShell CONSTANT avec des paramètres JSON. */
export type PsExecutor = (script: string, params: Record<string, unknown>) => Promise<PsResult>;

export interface HyperVEvent {
  at: number;
  action: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface HyperVDeps {
  /** Racine gérée des disques. */
  root: string;
  exec?: PsExecutor;
  onEvent?: (e: HyperVEvent) => void;
}

const NAME = /^jarod-[a-z0-9][a-z0-9_.-]{0,48}$/;
const CHECKPOINT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** L'exécuteur réel : `powershell.exe`, scripts constants, paramètres par l'environnement. */
export const powershellExecutor: PsExecutor = (script, params) =>
  new Promise((done) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      env: { ...process.env, JAROD_HV: JSON.stringify(params) },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });

// Chaque script commence par lire ses paramètres et par REVÉRIFIER le préfixe des noms : une faute du côté
// TypeScript ne suffit pas à atteindre une machine de l'utilisateur.
const HEAD = `$ErrorActionPreference='Stop'; $p = $env:JAROD_HV | ConvertFrom-Json;`;
const GUARD_VM = `if (-not ([string]$p.vm).StartsWith('jarod-')) { throw 'machine hors périmètre' };`;

export const SCRIPTS = {
  probe: `${HEAD} [pscustomobject]@{ cmdlets = [bool](Get-Command Get-VM -ErrorAction SilentlyContinue); admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress`,
  markTemplate: `${HEAD} Set-ItemProperty -LiteralPath ([string]$p.path) -Name IsReadOnly -Value $true`,
  newDifferencing: `${HEAD} New-VHD -Differencing -ParentPath ([string]$p.parent) -Path ([string]$p.path) | Out-Null`,
  newSwitch: `${HEAD} if (-not ([string]$p.name).StartsWith('jarod-')) { throw 'commutateur hors périmètre' }; New-VMSwitch -Name ([string]$p.name) -SwitchType Private | Out-Null`,
  newVm: `${HEAD} ${GUARD_VM} New-VM -Name ([string]$p.vm) -Generation 2 -MemoryStartupBytes ([int64]$p.memoryBytes) -VHDPath ([string]$p.disk) -SwitchName ([string]$p.switch) | Out-Null; Set-VM -Name ([string]$p.vm) -CheckpointType Standard -AutomaticCheckpointsEnabled $false; Disable-VMIntegrationService -VMName ([string]$p.vm) -Name 'Guest Service Interface'`,
  start: `${HEAD} ${GUARD_VM} Start-VM -Name ([string]$p.vm)`,
  stop: `${HEAD} ${GUARD_VM} Stop-VM -Name ([string]$p.vm) -TurnOff -Force`,
  checkpoint: `${HEAD} ${GUARD_VM} Checkpoint-VM -Name ([string]$p.vm) -SnapshotName ([string]$p.checkpoint)`,
  rollback: `${HEAD} ${GUARD_VM} Restore-VMSnapshot -VMName ([string]$p.vm) -Name ([string]$p.checkpoint) -Confirm:$false`,
  remove: `${HEAD} ${GUARD_VM} $vm = Get-VM -Name ([string]$p.vm); if ($vm.State -ne 'Off') { Stop-VM -Name ([string]$p.vm) -TurnOff -Force }; Remove-VM -Name ([string]$p.vm) -Force`,
} as const;

export interface HyperVStatus {
  cmdlets: boolean;
  admin: boolean;
  detail: string;
}

export class HyperVService {
  private readonly exec: PsExecutor;

  constructor(private readonly d: HyperVDeps) {
    this.exec = d.exec ?? powershellExecutor;
  }

  private emit(action: string, detail: HyperVEvent["detail"] = {}): void {
    this.d.onEvent?.({ at: Date.now(), action, detail });
  }

  private async run(action: keyof typeof SCRIPTS, params: Record<string, unknown>): Promise<string> {
    const result = await this.exec(SCRIPTS[action], params);
    const ok = result.code === 0;
    this.emit(action, { ok, code: result.code });
    if (!ok) throw new HyperVError(`${action} : ${result.stderr.trim().slice(0, 400) || `code ${result.code}`}`);
    return result.stdout;
  }

  private vm(name: string): string {
    if (!NAME.test(name)) throw new HyperVError(`nom de machine refusé (attendu « jarod-… », minuscules, chiffres, . _ -) : ${name}`);
    return name;
  }

  /** Un disque : sous la racine gérée, directement dedans, en `.vhdx`, sans lien. */
  private disk(path: string): string {
    const root = resolve(this.d.root);
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new HyperVError("la racine des disques est un lien : refusée");
    const real = realpathSync.native(root);
    const full = resolve(path);
    if (dirname(full).toLowerCase() !== real.toLowerCase() && dirname(full).toLowerCase() !== root.toLowerCase()) {
      throw new HyperVError(`disque hors de la racine gérée : ${path}`);
    }
    if (!/^[\w.-]+\.vhdx$/i.test(basename(full))) throw new HyperVError(`nom de disque refusé (un .vhdx simple est attendu) : ${basename(full)}`);
    if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new HyperVError("le disque est un lien : refusé");
    return join(real, basename(full));
  }

  /** Ce que la machine permet. Ne modifie rien. */
  async status(): Promise<HyperVStatus> {
    const result = await this.exec(SCRIPTS.probe, {});
    if (result.code !== 0) return { cmdlets: false, admin: false, detail: result.stderr.trim().slice(0, 300) || `code ${result.code}` };
    try {
      const parsed = JSON.parse(result.stdout) as { cmdlets: boolean; admin: boolean };
      const detail = !parsed.cmdlets ? "les cmdlets Hyper-V sont absentes" : parsed.admin ? "prêt" : "cmdlets présentes, mais la session n'est pas administrateur : piloter Hyper-V sera refusé";
      return { cmdlets: parsed.cmdlets, admin: parsed.admin, detail };
    } catch {
      return { cmdlets: false, admin: false, detail: "réponse illisible de PowerShell" };
    }
  }

  /** Un disque modèle devient en lecture seule : les différentiels en héritent sans pouvoir l'altérer. */
  async registerTemplate(disk: string): Promise<string> {
    const path = this.disk(disk);
    if (!existsSync(path)) throw new HyperVError(`modèle introuvable : ${path}`);
    await this.run("markTemplate", { path });
    return path;
  }

  async createDifferencing(template: string, child: string): Promise<string> {
    const parent = this.disk(template);
    const path = this.disk(child);
    if (parent.toLowerCase() === path.toLowerCase()) throw new HyperVError("le différentiel ne peut pas être son propre parent");
    if (existsSync(path)) throw new HyperVError("le différentiel existe déjà : rien n'est écrasé");
    await this.run("newDifferencing", { parent, path });
    return path;
  }

  /** Réseau virtuel isolé : type Private, ni l'hôte ni l'extérieur. */
  async createIsolatedNetwork(name: string): Promise<string> {
    this.vm(name);
    await this.run("newSwitch", { name });
    return name;
  }

  async createVm(input: { name: string; disk: string; network: string; memoryMb?: number }): Promise<string> {
    const vm = this.vm(input.name);
    const switchName = this.vm(input.network);
    const memoryMb = input.memoryMb ?? 2048;
    if (!Number.isInteger(memoryMb) || memoryMb < 512 || memoryMb > 65_536) throw new HyperVError("mémoire hors bornes (512 Mo à 64 Go)");
    await this.run("newVm", { vm, disk: this.disk(input.disk), switch: switchName, memoryBytes: memoryMb * 1024 * 1024 });
    return vm;
  }

  async start(name: string): Promise<void> {
    await this.run("start", { vm: this.vm(name) });
  }

  async stop(name: string): Promise<void> {
    await this.run("stop", { vm: this.vm(name) });
  }

  async checkpoint(name: string, checkpoint: string): Promise<void> {
    if (!CHECKPOINT.test(checkpoint)) throw new HyperVError(`nom de point de contrôle refusé : ${checkpoint}`);
    await this.run("checkpoint", { vm: this.vm(name), checkpoint });
  }

  /** Retour arrière à un point de contrôle nommé : l'état du disque revient à celui du point. */
  async rollback(name: string, checkpoint: string): Promise<void> {
    if (!CHECKPOINT.test(checkpoint)) throw new HyperVError(`nom de point de contrôle refusé : ${checkpoint}`);
    await this.run("rollback", { vm: this.vm(name), checkpoint });
  }

  async remove(name: string): Promise<void> {
    await this.run("remove", { vm: this.vm(name) });
  }
}
