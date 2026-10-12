// Point d'entrée de l'essai : `pnpm --filter @jarod/cli exec tsx src/gateway/main.ts`.
// Ouvre le noyau de Jarod sur un profil ISOLÉ (`JAROD_HOME` obligatoire : l'essai n'écrit jamais dans le profil réel sans `--real-profile`)
// et le sert comme un `hermes serve`. Écrit `HERMES_BACKEND_READY port=N` (la ligne que le shell sait lire) et un fichier
// `gateway.json` (url + jeton, 0600) dans le dossier du profil ; Ctrl-C affiche ce que le shell a demandé sans l'obtenir.
import { chmodSync, existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertOneaiChannel, bindLocalModelsEvents, bindUpdateEvents, bindVoiceEvents, createHandlers, desktopKernelOf, HERMES_REGISTRY, RegistryClient } from "@jarod/bridge";
import { ProfileManager } from "@jarod/plugin-persona";
import { defaultDataRoot, openCore } from "../context.js";
import { createBridgePort } from "./bridge.js";
import { createBridgeShell } from "./bridge-shell.js";
import { createGateway } from "./server.js";

const env = process.env;
if (!env.JAROD_HOME && !process.argv.includes("--real-profile")) {
  console.error("JAROD_HOME manquant : l'essai refuse de toucher au profil réel (passer --real-profile pour le faire exprès).");
  process.exit(2);
}

// Le dossier de travail de TOUTES les conversations (Jarod-OS : `D:\JAROD-OS`). Les outils fichiers de Jarod s'y confinent ; le dossier
// courant que Herald envoie (le dossier personnel) est ignoré, sauf s'il désigne un sous-dossier de celui-ci.
const wsIndex = process.argv.indexOf("--workspace");
const wsRaw = (wsIndex >= 0 ? process.argv[wsIndex + 1] : undefined) ?? env.JAROD_WORKSPACE;
let workspace: string | undefined;
if (wsRaw) {
  if (!isAbsolute(wsRaw) || !existsSync(wsRaw) || !statSync(wsRaw).isDirectory()) {
    console.error(`Dossier de travail invalide (absolu et existant attendu) : ${wsRaw}`);
    process.exit(2);
  }
  workspace = realpathSync(wsRaw);
}

// `--init` : le cœur complet (verrou du profil, tick du planificateur, MCP, passerelles de messagerie), pour une application qui reste ouverte ;
// sans lui, le noyau minimal de l'essai (les planifications ne tirent que par « Run now »).
const init = process.argv.includes("--init");
const { core, dataDir, profile } = await openCore({ env, ...(init ? { init: true } : {}) });
if (init) await core.init();
await core.skills.reload();
const gatewayVersion = "0.1.5-gateway-spike";
const gateway = createGateway({
  core,
  ...(workspace ? { workspace } : {}),
  version: gatewayVersion,
  ...(env.JAROD_GATEWAY_TOKEN ? { token: env.JAROD_GATEWAY_TOKEN } : {}),
  log: (line) => console.error(`[passerelle] ${line}`),
});
// Les canaux de pilotage (fournisseurs, modèles locaux, skills…) : les handlers de jarod-cordis sur ce noyau, les gestes natifs demandés à la fenêtre.
const kernel = desktopKernelOf(core.app as never, { profile, dataRoot: defaultDataRoot(env) });
// Changer de profil = ouvrir le noyau sur un autre profil : on pose le profil actif puis la fenêtre relance la passerelle (un noyau = un profil). Sans fenêtre pour la relancer, on revient en arrière.
const switchProfile = async (name: string): Promise<void> => {
  const profiles = new ProfileManager(defaultDataRoot(env));
  const previous = profiles.active();
  profiles.setActive(name);
  if ((await gateway.link.ask("restartBackend")) !== true) {
    profiles.setActive(previous);
    throw new Error("changement de profil impossible : aucune fenêtre pour relancer le moteur");
  }
};
const shell = createBridgeShell({ version: gatewayVersion, dataDir, link: gateway.link });
gateway.attachBridge(createBridgePort(createHandlers({ kernel: () => kernel, shell, registry: new RegistryClient(HERMES_REGISTRY), switchProfile }), (channel) => assertOneaiChannel("invoke", channel)));
const pushEvent = (channel: string, ...args: unknown[]) => gateway.link.send(channel, args);
const unbindEvents = [bindLocalModelsEvents(kernel.localEngine?.models, pushEvent), bindUpdateEvents(core.app as never, pushEvent), bindVoiceEvents(core.app as never, pushEvent)];
const port = await gateway.listen(env.JAROD_GATEWAY_PORT ? Number(env.JAROD_GATEWAY_PORT) : 0);
const file = join(dataDir, "gateway.json");
writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: gateway.token }), { mode: 0o600 });
try {
  chmodSync(file, 0o600);
} catch {
  // Windows : les droits POSIX n'y ont pas de sens.
}
console.log(`HERMES_BACKEND_READY port=${port}`);
// Où lire l'adresse et le jeton : le jeton n'est jamais imprimé, il est dans ce fichier (réservé à l'utilisateur).
console.log(`JAROD_GATEWAY_FILE ${file}`);
console.error(`[passerelle] profil ${dataDir} ; url+jeton dans ${file} ; dossier de travail ${workspace ?? "(celui du shell)"}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.error("[passerelle] non servi :", JSON.stringify(gateway.unhandled()));
  console.error("[passerelle] événements de Jarod sans équivalent :", JSON.stringify(gateway.ignoredEvents()));
  for (const off of unbindEvents) off();
  await gateway.close();
  await core.dispose().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
// Sous Windows `kill()` ne laisse aucune chance de se fermer proprement : le lanceur garde l'entrée standard ouverte et la ferme pour demander l'arrêt
// (elle se ferme aussi si le lanceur meurt : la passerelle ne reste jamais orpheline). Seulement sur demande : sans `--exit-on-stdin-close`, une entrée
// absente ne doit pas arrêter le serveur.
if (process.argv.includes("--exit-on-stdin-close")) {
  process.stdin.resume();
  process.stdin.on("end", () => void stop());
  process.stdin.on("close", () => void stop());
}
