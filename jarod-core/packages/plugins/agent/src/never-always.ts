/**
 * Les outils pour lesquels un accord PERMANENT (« Toujours autoriser ») est refusé (SPECS-P5-UI-PARITE.md § 13.2 et § 23, décision de SÉCURITÉ de l'utilisateur,
 * 2026-10-04). « Autoriser une fois » et « Autoriser pour cette conversation » (mémoire du processus) restent offerts ; la seule porte permanente pour exécuter sans
 * demander est `autoApproveTools` (confirmation native, bandeau). UN SEUL endroit : le courtier d'accord du desktop cache le bouton d'après cette liste, et la boucle
 * d'agent IGNORE une entrée déjà présente dans `alwaysAllowTools` pour ces outils. En retirer un, ou en ajouter un, est une décision explicite de l'utilisateur.
 *
 * La granularité est le NOM de l'outil : `cronjob` perd « Toujours » pour toutes ses actions (create, update, mais aussi pause, reprise, suppression).
 * `write_file` et `edit_file` gardent « Toujours » (bornés par Q12, journalisés), les autres outils sensibles aussi : voir le § 23.1.
 */
export const NEVER_ALWAYS_REASONS: Readonly<Record<string, string>> = {
  run_shell: "exécute des commandes arbitraires sur la machine",
  android_shell: "exécute des commandes arbitraires sur un appareil Android relié",
  skill_hub_install: "installe, depuis le réseau, du contenu que l'agent saura ensuite exécuter (une skill publique)",
  cronjob: "crée et modifie des tâches qui s'exécutent plus tard, sans l'utilisateur présent, et peuvent envoyer vers des passerelles",
  http_request: "peut modifier un serveur (POST, PUT, PATCH, DELETE) et porter un identifiant du coffre",
  // Ajouté le 2026-10-05 (décision de l'utilisateur) : l'URL est choisie par le modèle à chaque appel ; « cette conversation » suffit.
  web_fetch: "télécharge une URL choisie par le modèle, qui peut faire sortir le contenu de la conversation dans l'adresse",
  // Ajoutés le 2026-10-11 (décision de l'utilisateur) avec les outils système Windows : ils déplacent, mettent à la corbeille ou arrêtent ce que le modèle désigne.
  system_files: "déplace, copie et met à la corbeille des fichiers et dossiers choisis par le modèle, n'importe où hors des emplacements protégés",
  system_kill_process: "arrête des processus choisis par le modèle (travail non enregistré perdu avec force)",
  system_quit_app: "ferme ou arrête des applications choisies par le modèle (travail non enregistré perdu avec force)",
};

export const NEVER_ALWAYS: ReadonlySet<string> = new Set(Object.keys(NEVER_ALWAYS_REASONS));
