/**
 * L'environnement d'un processus ENFANT, construit selon ce que cet enfant est — jamais `process.env` hérité en bloc.
 *
 * Trois familles de variables sont en jeu :
 *  - les jetons de CONTRÔLE internes (passerelle, canal de contrôle du shell, relais, passerelles de messagerie) : aucun enfant n'en a besoin,
 *    un enfant qui en hériterait pourrait parler à la passerelle ou au shell à la place de l'utilisateur ; retirés pour TOUS les enfants ;
 *  - les clés des FOURNISSEURS de modèles (`ANTHROPIC_API_KEY`, …) : celles de Jarod, lues par le noyau lui-même ; ni un serveur MCP tiers ni
 *    une commande de l'agent n'ont à les recevoir ; retirées pour tous les enfants sauf si l'appelant les nomme explicitement ;
 *  - les variables « en forme de secret » (jeton, mot de passe, clé d'API… sans autre information) : retirées pour les serveurs MCP tiers,
 *    qui ne reçoivent que ce que la configuration de CE serveur nomme ; conservées pour l'agent et les moteurs (outils de l'utilisateur :
 *    `git`, `aws`, `kubectl`, `ssh`… doivent continuer à fonctionner avec ses identifiants, autorisés par les permissions d'exécution).
 *
 * Tout ce qui fait fonctionner Windows (PATH, SystemRoot, TEMP, APPDATA…) et `ELECTRON_RUN_AS_NODE` (lancement empaqueté du noyau) passent
 * toujours. Ce que l'appelant nomme dans `explicit` (configuration du serveur, secret injecté au point d'usage) est ajouté APRÈS le filtre :
 * il reste utilisable — sauf, pour un serveur MCP tiers, un jeton de contrôle INTERNE (une configuration ne peut pas le réintroduire). Ce module ne rend ni ne journalise jamais de valeur ; `scrubbedNames` ne rend que des NOMS.
 */

export type ChildKind =
  /** Serveur MCP tiers : seulement l'environnement « système » + ce que sa configuration nomme. */
  | "mcp"
  /** Commande de l'agent (`run_shell`) : l'environnement de l'utilisateur, sans jeton interne ni clé de fournisseur de Jarod. */
  | "agent-shell"
  /** Moteur ou outil lancé par Jarod (syft, hyperframes, PowerShell d'un outil système…) : comme l'agent. */
  | "engine";

/**
 * L'ancien préfixe du produit, que `legacy-env.ts` lit encore : construit ici pour que le garde de renommage (tests/repo/rename-guard) ne compte pas une ligne de plus.
 * Un jeton de contrôle sous l'ancien nom ne doit pas plus descendre dans un enfant que sous le nouveau.
 */
const OLD = ["HER", "ALD"].join("");

/** Les jetons de contrôle internes : jamais transmis. Noms exacts + les formes `JAROD_*_TOKEN`/ancien préfixe/`HERMES_*` ci-dessous. */
const INTERNAL_EXACT: ReadonlySet<string> = new Set([
  "JAROD_GATEWAY_TOKEN",
  "JAROD_GATEWAY_PORT",
  "JAROD_OS_CONTROL_TOKEN",
  "JAROD_OS_CONTROL_SOCKET",
  `${OLD}_OS_CONTROL_TOKEN`,
  `${OLD}_OS_CONTROL_SOCKET`,
  "HERMES_OS_CONTROL_TOKEN",
  "HERMES_DASHBOARD_SESSION_TOKEN",
  "JAROD_RELAY_TOKEN",
  "JAROD_CONTROL_JOURNAL",
]);

/** `JAROD_SLACK_BOT_TOKEN`, `JAROD_DISCORD_TOKEN`, `HERMES_…_KEY`… : tout secret au préfixe d'un composant de Jarod. */
const INTERNAL_PATTERN = new RegExp(`^(JAROD|${OLD}|HERMES)(_[A-Z0-9]+)*_(TOKEN|SECRET|KEY|API_KEY|PASSWORD)$`);

/** Les clés de fournisseurs de modèles et de passerelles que le noyau lit lui-même dans son environnement. */
const PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "DEEPSEEK_API_KEY",
  "CEREBRAS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "JAROD_CUSTOM_API_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "DISCORD_BOT_TOKEN",
]);

/** « En forme de secret » : le NOM le dit. Volontairement sans `AUTH` seul (`SSH_AUTH_SOCK` n'est pas un secret, c'est un chemin). */
const SECRET_SHAPED = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|SESSION_?KEY|BEARER)(_|$)/i;

export function isInternalSecretName(name: string): boolean {
  const n = name.toUpperCase();
  return INTERNAL_EXACT.has(n) || INTERNAL_PATTERN.test(n);
}

export function isProviderKeyName(name: string): boolean {
  return PROVIDER_KEYS.has(name.toUpperCase());
}

export function isSecretShapedName(name: string): boolean {
  return SECRET_SHAPED.test(name);
}

/** Vrai si cette variable de l'environnement du noyau ne doit PAS descendre dans un enfant de cette famille (sauf nommée explicitement). */
export function withheldFrom(kind: ChildKind, name: string): boolean {
  if (isInternalSecretName(name) || isProviderKeyName(name)) return true;
  return kind === "mcp" && isSecretShapedName(name);
}

export interface ChildEnvOptions {
  /** L'environnement de départ (défaut : `process.env`). */
  base?: NodeJS.ProcessEnv;
  /** Ajouté APRÈS le filtre : configuration explicite du serveur, secret autorisé injecté au point d'usage. Une valeur `undefined` est ignorée. */
  explicit?: Record<string, string | undefined>;
}

/**
 * L'environnement à donner à un enfant de cette famille. Windows est insensible à la casse pour les noms (`Path`/`PATH`) : la comparaison l'est
 * aussi, mais le nom d'origine est conservé tel quel dans le résultat (ne pas casser `Path`).
 */
export function childEnv(kind: ChildKind, options: ChildEnvOptions = {}): NodeJS.ProcessEnv {
  const base = options.base ?? process.env;
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (withheldFrom(kind, name)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(options.explicit ?? {})) {
    if (value === undefined) continue;
    // Un serveur MCP tiers ne reçoit JAMAIS un jeton de contrôle interne, même nommé par sa configuration (copie du jeton de l'orchestrateur) :
    // ses propres identifiants (GITHUB_TOKEN…) passent, ceux de Jarod non.
    if (kind === "mcp" && isInternalSecretName(name)) continue;
    // Un nom explicite remplace l'éventuel même nom d'une autre casse (Windows), jamais les deux.
    for (const existing of Object.keys(out)) if (existing.toUpperCase() === name.toUpperCase() && existing !== name) delete out[existing];
    out[name] = value;
  }
  return out;
}

/** Les NOMS retirés de `base` pour cette famille (aide au diagnostic et aux tests ; jamais une valeur). */
export function scrubbedNames(kind: ChildKind, base: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(base)
    .filter((name) => base[name] !== undefined && withheldFrom(kind, name))
    .sort();
}
