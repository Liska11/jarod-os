/**
 * @jarod/plugin-permissions — `ctx.permissions` : garde unifié (fail-closed, first-match-wins) +
 * garde du shell et bac à sable Docker (`services/shell-guard.ts`, `docker-sandbox.ts`), scan des
 * skills (`skill-guard.ts`).
 *
 * Les règles de l'UTILISATEUR vivent dans les réglages (`settings.permissionsRules`, écrits par
 * `set-jarod-settings` après confirmation native) : le plugin les charge LUI-MÊME au démarrage (`storage`
 * injecté) puis les relit À CHAUD à chaque écriture — les portails déjà distribués à l'agent suivent, sans
 * redémarrage. Aucun hôte n'a besoin d'appeler `initStorage` : un hôte qui l'oubliait (CLI, `jarod serve`,
 * `acp`, `headless`) laissait le garde à ZÉRO règle et les règles du bureau étaient ignorées. Tant qu'aucune
 * règle ne couvre un outil, la chaîne est « déclaré au registre → allow », puis `* → deny` : les règles ne
 * servent qu'à déroger, jamais à ouvrir par défaut.
 */
import { type PermissionRule, PermissionsConfig } from "@jarod/contracts";
import { type Context, Service } from "cordis";
import { type CallScope, loadRulesFromStorage, PermissionGuard, RULES_SETTINGS_KEY, type Resolution, resolveWith, type ToolGate } from "./guard.js";
import type { SettingsService } from "@jarod/plugin-storage";

export * from "./admin.js";
export * from "./docker-sandbox.js";
export * from "./guard.js";
export * from "./shell-guard.js";
export * from "./skill-guard.js";

declare module "cordis" {
  interface Context {
    permissions: PermissionsService;
  }
}

export class PermissionsService extends Service {
  static readonly Config = PermissionsConfig;
  /** `storage` est INJECTÉ : le plugin lit `settings.permissionsRules` lui-même (aucun hôte à modifier). */
  static readonly inject = ["storage"];
  readonly guard: PermissionGuard;
  /**
   * Règles venues de la config du plugin (politique de déploiement), évaluées AVANT celles de l'utilisateur.
   * Jamais écrasées par `refresh` : la politique du déploiement est un plancher, pas un remplacement.
   */
  private readonly configRules: readonly PermissionRule[];
  private settings?: SettingsService;
  private unsub?: () => void;

  constructor(ctx: Context, input: PermissionsConfig = {}) {
    super(ctx, "permissions");
    this.configRules = [...PermissionsConfig.parse(input ?? {}).rules];
    this.guard = new PermissionGuard(this.configRules);
    // H1 : branchement PAR LE PLUGIN. Un hôte qui n'appelle pas `initStorage` (CLI, serve, acp, headless,
    // e2e) obtenait sinon un garde vide : « deny run_shell » écrit dans le bureau était ignoré.
    this.initStorage(ctx.storage.settings);
  }

  /**
   * Branche le garde sur le storage : charge les règles de l'utilisateur, puis les relit à chaque
   * écriture de `permissionsRules` (callback SYNCHRONE de `SettingsService.onChange`, donc la
   * relecture est effective avant que `set` ne rende la main). Idempotent : un second appel remplace
   * l'abonnement, il ne s'y ajoute pas. Reste public pour les hôtes qui branchent explicitement.
   */
  initStorage(settings: SettingsService): void {
    this.unsub?.();
    this.settings = settings;
    this.refresh();
    this.unsub = settings.onChange("permissionsRules", () => this.refresh());
  }

  /** Relit les règles du storage et CONCATÈNE : config du plugin d'abord, règles de l'utilisateur ensuite. */
  refresh(): void {
    if (this.settings) this.guard.setRules([...this.configRules, ...loadRulesFromStorage(this.settings)]);
  }

  /**
   * Le portail de l'agent pour un registre donné (`declared` = l'outil y est enregistré). Chaque décision RELIT les règles : un changement
   * écrit par un autre processus sur le même profil (la commande `jarod permissions`) vaut pour l'appel suivant, sans redémarrage.
   */
  gate(declared: (toolName: string) => boolean): ToolGate {
    return {
      decide: (name, target) => {
        this.refresh();
        return this.guard.match(name, target) ?? (declared(name) ? "allow" : "deny");
      },
      resolve: (name: string, call: CallScope): Resolution => {
        this.refresh();
        return resolveWith(this.guard, declared, name, call);
      },
      consume: (rule) => this.consume(rule),
    };
  }

  /**
   * Retire une utilisation à une règle bornée en nombre (`uses`), AVANT l'exécution qu'elle accorde : deux appels simultanés ne passent pas
   * sur la même dernière utilisation. Seules les règles de l'utilisateur portent un compteur ; une règle introuvable (révoquée entre-temps) ne
   * change rien. Ne fait que restreindre : aucune confirmation n'est nécessaire.
   */
  consume(rule: PermissionRule): void {
    if (rule.uses === undefined || !this.settings) return;
    const rules = [...loadRulesFromStorage(this.settings)];
    const i = rules.findIndex((r) => (rule.id !== undefined ? r.id === rule.id : JSON.stringify(r) === JSON.stringify(rule)));
    const r = rules[i];
    if (!r || r.uses === undefined) return;
    rules[i] = { ...r, uses: Math.max(0, r.uses - 1) };
    this.settings.set(RULES_SETTINGS_KEY, rules as never);
  }

  onDispose(): void {
    this.unsub?.();
    this.unsub = undefined;
  }
}

export default PermissionsService;
