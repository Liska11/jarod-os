/**
 * V-06 — dans les tests sur un VRAI kernel, un plugin que le test vient de poser ne tourne qu'approuvé, comme pour la personne : ce
 * rechargement approuve (signature locale du profil, plateforme réelle) chaque plugin encore « non approuvé ». Un contenu MODIFIÉ après son
 * approbation reste bloqué : c'est ce que les tests du garde vérifient. Une activation qui échoue garde son erreur (état `error`).
 */
import type { PluginHost, PluginInfo } from "../src/index.js";

export function approveOnReload(host: PluginHost): PluginHost {
  const reload = host.reload.bind(host);
  host.reload = async (): Promise<PluginInfo[]> => {
    const infos = await reload();
    for (const p of infos.filter((i) => i.state === "blocked" && /^non approuvé/.test(i.error ?? ""))) {
      await host.governance!.approve(p.id).catch(() => undefined);
    }
    return host.list();
  };
  return host;
}
