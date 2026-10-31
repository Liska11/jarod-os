// L'interface de Jarod-OS vue par l'agent (31/10). Le shell (la fenêtre) tient un registre d'environ 150 commandes — ouvrir une page web dans une fenêtre
// de Jarod, lancer une application, régler le volume ou le Wi-Fi, prendre une capture, ouvrir Pinokio, les Missions, la Mémoire, les Réglages, le thème,
// la voix… — que la palette et la voix utilisent. L'agent du cœur n'en voyait que deux (pinokio.*) : il répondait « je ne peux pas » pour tout le reste.
// Deux outils : `os_ui_list` (lecture) donne le catalogue vivant, `os_ui_run` (accord demandé) exécute une commande par son identifiant. Le shell refuse
// lui-même ce que son niveau de sécurité n'autorise pas à l'agent ; ces outils n'existent que si un shell est joignable (son socket de contrôle).
import type { ToolDef } from "./registry.js";
import { askShellRequest, shellAvailable } from "./pinokio/client.js";

interface CommandRow {
  id: string;
  title: string;
  description: string;
  tier: string;
  args: { name: string; type?: string; description?: string; required?: boolean }[];
  hidden?: boolean;
}

export interface ShellUiDeps {
  env?: NodeJS.ProcessEnv;
  /** Remplaçable dans les tests : une requête au socket de contrôle. */
  ask?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const words = (s: string): string[] =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter(Boolean);

/** Une ligne par commande : « id [niveau] titre — description (arguments ; * = obligatoire) ». */
export function commandLine(c: CommandRow): string {
  const args = c.args.map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ");
  return `${c.id} [${c.tier}] ${c.title} — ${c.description}${args ? ` (${args})` : ""}`;
}

/** Les commandes visibles dont l'identifiant, le titre ou la description contiennent tous les mots demandés ; tout le catalogue sans filtre. */
export function filterCommands(rows: readonly CommandRow[], filter: string): CommandRow[] {
  const q = words(filter);
  return rows.filter((c) => !c.hidden).filter((c) => q.every((w) => words(`${c.id} ${c.title} ${c.description}`).join(" ").includes(w)));
}

export function shellUiTools(deps: ShellUiDeps = {}): ToolDef[] {
  const env = deps.env ?? process.env;
  const ask = deps.ask ?? ((request: Record<string, unknown>) => askShellRequest(request, env, 30_000));
  const available = () => shellAvailable(env);

  const list: ToolDef = {
    name: "os_ui_list",
    source: "builtin",
    dangerous: false,
    audited: true,
    available,
    description:
      "Liste ce que l'INTERFACE de Jarod-OS sait faire (une centaine de commandes) : ouvrir une page web dans une fenêtre de Jarod (web.open), lancer une application (native.launch), volume / Wi-Fi / Bluetooth / luminosité, captures d'écran et enregistrement, Pinokio, Missions, Mémoire, Fichiers, Réglages, thème et fond d'écran, voix et dictée, fenêtres, discussions. À appeler dès que l'utilisateur demande quelque chose que tes autres outils ne font pas, AVANT de répondre « je ne peux pas ». filter : mots-clés (ex. « web », « volume », « capture »). Exécuter : os_ui_run.",
    parameters: { type: "object", properties: { filter: { type: "string", description: "Mots-clés, tous requis (identifiant, titre ou description)." } } },
    async run(args) {
      const reply = await ask({ cmd: "ui-list" });
      if (reply.ok === false) throw new Error(String(reply.error ?? "Jarod-OS n'a pas rendu sa liste de commandes"));
      const rows = (Array.isArray(reply.result) ? reply.result : []) as CommandRow[];
      const filter = typeof args.filter === "string" ? args.filter.trim() : "";
      const found = filterCommands(rows, filter);
      if (found.length === 0) return `Aucune commande ne correspond à « ${filter} ». Essaie d'autres mots, ou appelle sans filter pour tout voir (${rows.filter((c) => !c.hidden).length} commandes).`;
      const shown = found.slice(0, 80);
      return `${found.length} commande(s)${found.length > shown.length ? ` (80 premières ; précise avec filter)` : ""} — os_ui_run command=<id> args={…} :\n${shown.map(commandLine).join("\n")}`;
    },
  };

  const run: ToolDef = {
    name: "os_ui_run",
    source: "builtin",
    dangerous: true,
    available,
    targetOf: (args) => (typeof args.command === "string" ? args.command : undefined),
    description:
      "Exécute une commande de l'interface de Jarod-OS par son identifiant (os_ui_list les donne avec leurs arguments), ex. command=\"web.open\" args={\"url\":\"https://…\"} pour montrer une page dans une fenêtre de Jarod. Un accord est demandé à chaque fois. Le shell peut refuser ce que son niveau de sécurité n'autorise pas à l'agent : le refus est dit tel quel.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "Identifiant, ex. web.open." }, args: { type: "object", description: "Arguments de la commande." } },
      required: ["command"],
    },
    async run(args) {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!/^[a-z][a-z0-9._-]{0,80}$/i.test(command)) throw new Error("command : un identifiant comme web.open (os_ui_list les donne)");
      const given = args.args && typeof args.args === "object" && !Array.isArray(args.args) ? (args.args as Record<string, unknown>) : {};
      const reply = await ask({ cmd: "ui", command, args: given, source: "agent" });
      if (reply.ok === false) throw new Error(String(reply.error ?? reply.summary ?? `${command} a échoué`));
      return JSON.stringify({ command, ok: true, summary: reply.summary ?? "fait", ...(reply.data !== undefined ? { data: reply.data } : {}) });
    },
  };

  return [list, run];
}
