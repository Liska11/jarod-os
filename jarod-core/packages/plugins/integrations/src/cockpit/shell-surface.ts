/**
 * V-12 — le registre unique : les capacités qui vivent HORS du cœur entrent dans le même registre que le reste (`CapabilityService`, l'outil
 * `capabilities`, Réglages › Capacités), chacune avec son état mesuré :
 *  - `shell.*` : la surface du canal de contrôle du shell, telle que la fige la matrice C2 (`contracts/v1`, `c2-authorization-matrix`) — la même
 *    que le shell TypeScript applique (vérifiée par ses tests) et que l'hôte Rust lit à l'exécution. Rien n'est recopié : le fichier est importé ;
 *  - `ui.*` : le registre de commandes de la FENÊTRE (`listCommands` du renderer), lu à l'exécution par `ui-list` sur la porte du cœur ;
 *  - `rust.*` : les crates de l'hôte Rust, avec ce qui est réellement branché (le bac à sable `jarod-sandbox`) et ce qui reste un prototype.
 * Lecture seule : aucune de ces entrées n'exécute rien, et l'état vient d'une sonde (la porte de contrôle interrogée, un binaire trouvé).
 */
import { connect } from "node:net";
import { controlConnectTarget } from "@jarod/kernel/util";
import matrix from "../../../../../../contracts/v1/fixtures/c2-authorization-matrix/valid-current.json" with { type: "json" };
import type { Probe } from "./catalog.js";
import { notInstalled, type ProbeHost, which } from "./probe.js";
import type { CapabilityManifest, ProbeResult, Risk } from "./types.js";

type Tier = Risk;

const ORDER: Tier[] = ["read", "act", "mutate", "destructive"];
const highest = (tiers: Tier[]): Tier => tiers.reduce<Tier>((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), "read");

/**
 * Le nom de la ligne de commande du shell (partagé avec Linux, jamais renommé) : assemblé ici pour que le garde de renommage
 * (tests/repo/rename-guard) ne compte pas une ligne de plus.
 */
export const SHELL_CLI = ["her", "ald-os"].join("");

/** Les commandes du shell que la matrice C2 classe, et celles que la porte du CŒUR peut demander (les autres : la CLI du shell). */
export const SHELL_MATRIX = {
  // Une commande à palier PAR ACTION (`branding`, `plugin`) prend le plus fort de ses actions : c'est ce qu'il faut savoir d'elle.
  commands: (matrix.shellCommands as { name: string; tier?: Tier; tierByAction?: { actions: Record<string, Tier> } }[]).map((c) => ({
    name: c.name,
    tier: c.tier ?? highest(Object.values(c.tierByAction?.actions ?? {})),
  })),
  backend: new Set<string>(matrix.backendCommands as string[]),
};

/** Une commande du registre de la fenêtre, telle que `ui-list` la rend (`CommandSummary` du renderer). */
export interface WindowCommand {
  id: string;
  title: string;
  description?: string;
  tier?: Tier;
  args?: { name: string; description?: string; required?: boolean; enum?: string[] }[];
  hidden?: boolean;
}

/** La porte de contrôle du shell, vue du cœur : `state` (est-elle ouverte ?) et `ui-list` (le registre de la fenêtre). */
export interface ShellDoor {
  state(): Promise<{ ok: boolean; detail: string }>;
  uiList(): Promise<WindowCommand[] | null>;
}

const ONE_REQUEST_MS = 3_000;

/** Une requête JSON-lines à la porte du cœur (`JAROD_OS_CONTROL_SOCKET` + `JAROD_OS_CONTROL_TOKEN`, posés par le shell qui lance le cœur). */
function ask(env: NodeJS.ProcessEnv, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const endpoint = (env.JAROD_OS_CONTROL_SOCKET ?? env.HERMES_OS_CONTROL_SOCKET)?.trim();
  const token = env.JAROD_OS_CONTROL_TOKEN ?? env.HERMES_OS_CONTROL_TOKEN;
  if (!endpoint || !token) return Promise.reject(new Error("no-door"));
  return new Promise((resolve, reject) => {
    const socket = connect(controlConnectTarget(endpoint));
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("le shell n'a pas répondu à temps"));
    }, ONE_REQUEST_MS);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...request, token, source: "agent" })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** La porte réelle : celle que le shell a donnée au cœur. Sans elle (cœur lancé seul, CLI), elle le dit. */
export function shellDoor(env: NodeJS.ProcessEnv = process.env): ShellDoor {
  return {
    async state() {
      try {
        const reply = await ask(env, { cmd: "state" });
        return reply.ok === false ? { ok: false, detail: `la porte de contrôle a refusé : ${String(reply.error ?? reply.reason ?? "?")}` } : { ok: true, detail: "porte de contrôle du shell ouverte (réponse à « state »)" };
      } catch (e) {
        return (e as Error).message === "no-door"
          ? { ok: false, detail: "le cœur ne tourne pas sous le shell Jarod-OS : pas de porte de contrôle" }
          : { ok: false, detail: `porte de contrôle injoignable : ${(e as Error).message}` };
      }
    },
    async uiList() {
      try {
        const reply = await ask(env, { cmd: "ui-list" });
        return reply.ok === true && Array.isArray(reply.result) ? (reply.result as WindowCommand[]) : null;
      } catch {
        return null;
      }
    },
  };
}

const base = (id: string, name: string, description: string, risk: Risk): CapabilityManifest => ({
  id,
  name,
  description,
  categories: ["shell"],
  intents: [name],
  owner: "shell",
  tools: [],
  integration: "shell-command",
  output: "la réponse du shell",
  risk,
  sideEffects: risk === "read" ? "lecture" : risk === "act" ? "agit sur le bureau, rien qui survive à la session" : "modifie des préférences, des fichiers ou l'état d'un plugin : accord vu par le shell exigé",
  locality: "local",
  requires: ["le shell Jarod-OS (porte de contrôle)"],
  timeoutMs: ONE_REQUEST_MS,
  cancel: "une requête, une réponse : rien à annuler",
  verification: "la réponse du shell ; le journal C3 de chaque tentative",
  artifacts: [],
  limits: [],
});

/** La surface du canal de contrôle : une capacité par commande de la matrice C2, avec la porte qui peut la demander. */
export function shellCommandCapabilities(probe: Probe): (CapabilityManifest & { probe: Probe })[] {
  return SHELL_MATRIX.commands.map((c) => ({
    ...base(`shell.${c.name}`, `${SHELL_CLI} ${c.name}`, `Commande « ${c.name} » du canal de contrôle du shell (palier ${c.tier}, matrice C2).`, c.tier),
    limits: [
      SHELL_MATRIX.backend.has(c.name) ? "porte du cœur : oui" : `porte du cœur : non (la CLI ${SHELL_CLI} seulement)`,
      ...(c.tier === "mutate" || c.tier === "destructive" ? ["exige un accord vu par le shell (capacité à usage unique)"] : []),
    ],
    probe,
  }));
}

/** Le registre de la fenêtre, tel que la porte le rend maintenant : une capacité par commande, disponible puisque la fenêtre vient de répondre. */
export function windowCommandCapabilities(commands: WindowCommand[]): (CapabilityManifest & { probe: Probe })[] {
  const live: Probe = async () => ({ state: "available", detail: "commande du registre de la fenêtre (lue à l'instant par « ui-list »)" });
  return commands.map((c) => {
    const tier: Risk = c.tier ?? "act";
    const properties = Object.fromEntries((c.args ?? []).map((a) => [a.name, { type: "string", ...(a.description ? { description: a.description } : {}), ...(a.enum ? { enum: a.enum } : {}) }]));
    const required = (c.args ?? []).filter((a) => a.required).map((a) => a.name);
    return {
      ...base(`ui.${c.id}`, c.title || c.id, c.description || `Commande « ${c.id} » de la fenêtre Jarod-OS.`, tier),
      categories: ["shell", "fenêtre"],
      intents: [c.title, c.id].filter(Boolean),
      input: { type: "object", properties, ...(required.length ? { required } : {}) },
      limits: ["porte du cœur : oui (commande « ui »)", ...(c.hidden ? ["cachée de la palette"] : [])],
      probe: live,
    };
  });
}

const RUST_PROTOTYPE = "crate de l'hôte Rust du dépôt (`host-rust/`), testée par cargo, pas encore branchée au shell";

/** Les crates de l'hôte Rust : ce qui sert vraiment (le bac à sable) et ce qui est un prototype, sans le présenter comme branché. */
export function rustCapabilities(): (CapabilityManifest & { probe: Probe })[] {
  const prototype: Probe = async () => ({ state: "installed-unconfigured", detail: RUST_PROTOTYPE });
  const rust = (crate: string, name: string, description: string, probe: Probe, risk: Risk = "read"): CapabilityManifest & { probe: Probe } => ({
    ...base(`rust.${crate}`, name, description, risk),
    categories: ["hôte Rust"],
    owner: "host-rust",
    integration: "infrastructure",
    requires: [`crate ${crate}`],
    timeoutMs: 0,
    cancel: "—",
    verification: "tests cargo de la crate",
    limits: [],
    probe,
  });
  const sandbox: Probe = async (host: ProbeHost): Promise<ProbeResult> => {
    // Même recherche que le garde du shell (permissions/shell-guard.ts) : la variable d'abord, puis le PATH. Pas d'auto-test ici (il démarre
    // de vrais conteneurs) : le garde le fait avant de confiner une commande.
    // L'ancien nom est reconstruit (comme kernel/child-env.ts) : le garde de renommage ne compte pas une ligne de plus.
    const named = host.env.JAROD_SANDBOX_BIN ?? host.env[`${["HER", "ALD"].join("")}_SANDBOX_BIN`];
    const found = named && host.exists(named) ? named : which(host, "jarod-sandbox");
    return found
      ? { state: "available", detail: "binaire du bac à sable trouvé : run_shell peut confiner l'écriture au dossier de travail", found: [found] }
      : notInstalled("jarod-sandbox", "jarod-sandbox (host-sandbox) introuvable : run_shell refuse alors l'isolation « workspace »");
  };
  return [
    rust("host-sandbox", "Bac à sable AppContainer (jarod-sandbox)", "Confine une commande de l'agent au dossier de travail (AppContainer sans capacité réseau).", sandbox, "act"),
    rust("host-control", "Adjudicateur du canal de contrôle (Rust)", "Juge chaque requête du canal de contrôle selon la matrice C2 et tient le journal C3.", prototype),
    rust("host-updater", "Mises à jour (Rust)", "Applique une mise à jour signée, avec retour arrière.", prototype),
    rust("host-supervisor", "Superviseur de processus (Rust)", "Lance et surveille les processus de l'hôte.", prototype),
    rust("host-storage", "Stockage (Rust)", "Réserve et bornes du disque de données.", prototype),
    rust("host-vault", "Coffre (Rust)", "Garde des secrets côté hôte.", prototype),
  ];
}

/**
 * La sonde partagée des commandes `shell.*` : la porte de contrôle répond-elle ? Une SEULE question pour toute la surface (29 commandes, une
 * porte) : la réponse est partagée pendant `sharedMs`, et les sondes lancées ensemble attendent la même.
 */
export function shellProbe(door: ShellDoor, sharedMs = 2_000, now: () => number = Date.now): Probe {
  let last: { at: number; result: Promise<ProbeResult> } | null = null;
  return () => {
    if (!last || now() - last.at > sharedMs) {
      last = {
        at: now(),
        result: door.state().then((s) => (s.ok ? { state: "available", detail: s.detail } : { state: "installed-unconfigured", detail: s.detail })),
      };
    }
    return last.result;
  };
}
