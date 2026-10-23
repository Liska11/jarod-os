/**
 * Plugins utilisateur (SPECS-P5-UI-PARITE.md §3.2) : canaux PROPRES à Jarod `plugins-list`, `plugin-set-enabled`, `plugin-set-trust`.
 * Jusqu'ici ces réglages (`disabledPlugins`, `pluginTrust`) ne se posaient que par `/plugin` dans le chat.
 *
 * Un plugin est du CODE de l'utilisateur lancé dans son propre processus, sous le modèle de permissions de Node ; sa confiance se règle ici :
 * - ACTIVER un plugin le lance : confirmation NATIVE qui montre son nom, sa version, son auteur, les surfaces qu'il demande et l'empreinte de
 *   son contenu ; le désactiver n'en demande aucune ;
 * - CLASSER ses outils « sans accord » (`trust`) retire l'accord à chaque appel : confirmation NATIVE qui nomme les outils et l'empreinte ; le
 *   classement est lié à CETTE empreinte (une modification du plugin le retire, voir `PluginHost.dropStaleTrust`). Le retirer n'en demande aucune ;
 * - le renderer ne désigne un plugin que par son identifiant, jamais par un chemin ;
 * - V-06 : un plugin ne TOURNE qu'approuvé par la plateforme (manifeste signé, contenu figé par son empreinte). APPROUVER (`plugin-approve`)
 *   signe le contenu actuel avec la clé locale du profil, après une confirmation NATIVE qui dit ce qui sera lancé (et, pour une mise à jour, de
 *   quelle version vers laquelle) ; REVENIR à la version précédente (`plugin-rollback`) aussi ; RETIRER l'approbation (`plugin-revoke`) arrête
 *   le plugin et ne demande rien.
 */
import type { PluginApproval, PluginInfo } from "@jarod/plugin-workflows";
import type { HandlerContext } from "./context.js";

/** Ce que l'écran voit d'un plugin : de quoi décider, pas de chemin. */
export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  state: "active" | "disabled" | "error" | "blocked";
  error: string;
  /** V-06 : ce que la plateforme dit de son approbation ; null sans plateforme (aucun plugin ne tourne alors). */
  approval: PluginApproval | null;
  tools: string[];
  trusted: string[];
  permissions: string[];
  /** Début de l'empreinte du contenu (12 caractères) : la confiance y est liée. */
  digest: string;
}

const view = (p: PluginInfo, approval: PluginApproval | null = null): PluginView => ({
  id: p.id,
  name: p.name,
  version: p.version,
  description: p.description ?? "",
  author: p.author ?? "",
  enabled: p.enabled,
  state: p.state,
  error: p.error ?? "",
  tools: [...p.tools],
  trusted: [...p.trusted],
  permissions: p.permissions.map((x) => (typeof x === "string" ? x : JSON.stringify(x))),
  digest: p.digest.slice(0, 12),
  approval,
});

export function createPluginHandlers(ctx: HandlerContext) {
  const host = () => {
    const h = ctx.kernel().pluginHost;
    if (!h) throw new Error("[oneai] plugins utilisateur indisponibles (plugin-workflows désactivé)");
    return h;
  };
  const known = (id: unknown): PluginInfo => {
    if (typeof id !== "string" || !id) throw new Error("[oneai] plugin : identifiant attendu");
    const p = host().list().find((x) => x.id === id);
    if (!p) throw new Error(`[oneai] plugin inconnu : ${id.slice(0, 80)}`);
    return p;
  };
  const governance = () => {
    const g = host().governance;
    if (!g) throw new Error("[oneai] la plateforme de plugins n'est pas chargée : aucun plugin ne peut être approuvé ni lancé");
    return g;
  };
  const views = (): PluginView[] => host().list().map((p) => view(p, host().governance?.status(p.id) ?? null));
  const sure = async (message: string, detail: string, action: string, what: string): Promise<void> => {
    if (!ctx.shell.confirm) throw new Error(`[oneai] ${what} : confirmation native indisponible, refusé`);
    if (!(await ctx.shell.confirm(message, detail, action))) throw new Error(`[oneai] ${what} : refusé par l'utilisateur`);
  };

  return {
    // V-06 : un dossier déposé depuis le dernier chargement apparaît tout de suite (bloqué tant qu'il n'est pas approuvé).
    "plugins-list": async (): Promise<PluginView[]> => {
      if (!ctx.kernel().pluginHost) return [];
      await host().scanNew();
      return views();
    },
    /** Rend la liste relue. Activer = lancer du code : confirmation native. */
    "plugin-set-enabled": async (id: unknown, enabled: unknown): Promise<PluginView[]> => {
      if (typeof enabled !== "boolean") throw new Error("[oneai] plugin-set-enabled : (id: string, enabled: boolean) attendu");
      const p = known(id);
      if (enabled && !p.enabled) {
        await sure(
          `Activer le plugin « ${p.name} » ?`,
          [
            `${p.name} ${p.version}${p.author ? ` — ${p.author}` : ""}`,
            p.description,
            `Surfaces demandées : ${p.permissions.length ? p.permissions.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ") : "aucune"}`,
            `Empreinte du contenu : ${p.digest.slice(0, 12) || "inconnue"}`,
            "",
            "Le plugin est du code lancé dans son propre processus, avec les seules permissions qu'il déclare. Ses outils demandent votre accord à chaque appel tant que vous ne les avez pas classés autrement.",
          ]
            .filter((l, i) => l !== "" || i > 0)
            .join("\n"),
          "Activer",
          "plugin",
        );
      }
      // V-06 : avec la plateforme, c'est elle qui active et désactive (un plugin non approuvé ne s'active pas).
      if (host().governance) await governance().setEnabled(p.id, enabled);
      else await host().setEnabled(p.id, enabled);
      return views();
    },
    /** V-06 : approuver le contenu ACTUEL (installation, ou mise à jour qui s'annule seule si elle échoue). Confirmation native. */
    "plugin-approve": async (id: unknown): Promise<PluginView[]> => {
      // La boîte doit montrer le dossier tel qu'il est MAINTENANT (version, surfaces, empreinte) : c'est ce contenu-là qui sera signé.
      await host().refresh(known(id).id);
      const p = known(id);
      if (p.state === "error" && p.version === "?") throw new Error(`[oneai] plugin « ${p.id} » : ${p.error}`);
      const before = governance().status(p.id);
      const update = before.status !== "unapproved" && before.version !== undefined;
      await sure(
        update ? `Approuver la mise à jour de « ${p.name} » ?` : `Approuver et lancer le plugin « ${p.name} » ?`,
        [
          `${p.name} ${update ? `${before.version} → ` : ""}${p.version}${p.author ? ` — ${p.author}` : ""}`,
          p.description,
          `Surfaces demandées : ${p.permissions.length ? p.permissions.join(", ") : "aucune"}`,
          `Empreinte du contenu : ${p.digest.slice(0, 12) || "inconnue"}`,
          "",
          "Ce contenu exact sera signé par la clé de votre profil et lancé dans son propre processus, avec les seules permissions qu'il déclare. " +
            "S'il change ensuite, il ne tourne plus jusqu'à une nouvelle approbation." +
            (update ? " Si la nouvelle version échoue au démarrage, l'ancienne est remise en place." : ""),
        ]
          .filter(Boolean)
          .join("\n"),
        update ? "Approuver la mise à jour" : "Approuver et lancer",
        "plugin",
      );
      await governance().approve(p.id, p.digest);
      return views();
    },
    /** V-06 : revenir à la version approuvée précédente (son contenu gardé est remis en place). Confirmation native. */
    "plugin-rollback": async (id: unknown): Promise<PluginView[]> => {
      const p = known(id);
      const s = governance().status(p.id);
      if (!s.previous) throw new Error(`[oneai] « ${p.name} » : aucune version précédente`);
      await sure(`Revenir à la version ${s.previous} de « ${p.name} » ?`, `${p.name} ${s.version} → ${s.previous}\n\nLe contenu de la version ${s.previous}, gardé à son approbation, est remis en place et relancé.`, `Revenir à ${s.previous}`, "plugin");
      await governance().rollback(p.id);
      return views();
    },
    /** V-06 : retirer l'approbation — le plugin s'arrête. Durcir : aucune confirmation. */
    "plugin-revoke": async (id: unknown): Promise<PluginView[]> => {
      const p = known(id);
      await governance().revoke(p.id);
      return views();
    },
    /**
     * `trusted: true` classe ces outils (aucun nom = tous) « sans accord » pour l'empreinte ACTUELLE ; `false` redemande l'accord.
     * Confirmation native pour le classement seulement.
     */
    "plugin-set-trust": async (id: unknown, tools: unknown, trusted: unknown): Promise<PluginView[]> => {
      if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string") || typeof trusted !== "boolean") {
        throw new Error("[oneai] plugin-set-trust : (id: string, tools: string[], trusted: boolean) attendu");
      }
      const p = known(id);
      if (p.state !== "active") throw new Error(`[oneai] plugin « ${p.name} » inactif : activez-le d'abord`);
      const names = tools as string[];
      const target = names.length ? names : p.tools;
      if (trusted) {
        await sure(
          `Classer les outils de « ${p.name} » sans accord ?`,
          [
            `Outils : ${target.join(", ") || "aucun"}`,
            `Empreinte du contenu : ${p.digest.slice(0, 12)}`,
            "",
            "Ces outils s'exécuteront SANS vous demander, à chaque appel. Le classement ne vaut que pour CE contenu : si le plugin est modifié, il est retiré et l'accord est redemandé.",
          ].join("\n"),
          "Classer sans accord",
          "plugin",
        );
        host().trustTools(p.id, names);
      } else {
        host().distrustTools(p.id, names);
      }
      return views();
    },
  };
}
