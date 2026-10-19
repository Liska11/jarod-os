// Point d'entrée de l'essai : `pnpm --filter @jarod/cli exec tsx src/gateway/main.ts`.
// Ouvre le noyau de Jarod sur un profil ISOLÉ (`JAROD_HOME` obligatoire : l'essai n'écrit jamais dans le profil réel sans `--real-profile`)
// et le sert comme un `hermes serve`. Écrit `HERMES_BACKEND_READY port=N` (la ligne que le shell sait lire) et un fichier
// `gateway.json` (url + jeton, 0600 et restriction `icacls` sous Windows, effacé à l'arrêt) dans le dossier du profil ; Ctrl-C affiche ce que le shell a demandé sans l'obtenir.
// Sortie : 2 = arguments invalides, 3 = démarrage refusé (profil déjà servi, port occupé) — jamais une pile Node brute.
// Premier import : les variables encore posées sous leur ancien nom sont adoptées avant toute lecture de process.env (renommage, phase 2).
import "@jarod/kernel/legacy-env-adopt";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertOneaiChannel, bindLocalModelsEvents, bindUpdateEvents, bindVoiceEvents, closeAllApiServers, createHandlers, desktopKernelOf, HERMES_REGISTRY, RegistryClient, startRememberedApiServers } from "@jarod/bridge";
import { ProfileManager } from "@jarod/plugin-persona";
import { defaultDataRoot, openCore } from "../context.js";
import { createBridgePort } from "./bridge.js";
import { createRemoteBrowser } from "./browser.js";
import { startConnectedBrowser } from "./connected-browser.js";
import { createBridgeShell } from "./bridge-shell.js";
import { removeSecretFile, writeSecretFile } from "./secret-file.js";
import { createGateway } from "./server.js";
import { boundedMessage, startupFailure } from "./startup.js";
import { applyNetworkPolicyFromEnv } from "@jarod/kernel/network";
import { maintenanceRequested, runMaintenance } from "./maintenance.js";

const env = process.env;
// Mode maintenance (sauvegarde externe) : une copie de base, puis sortie ; rien d'autre ne démarre.
if (maintenanceRequested(process.argv)) process.exit(runMaintenance(process.argv));
// L'interrupteur Internet du shell, AVANT que le cœur n'ouvre la moindre connexion (fournisseurs, passerelles, MCP).
applyNetworkPolicyFromEnv(env);
/** Refuse de démarrer en le disant clairement : la fenêtre n'affiche que ces lignes (voir `startup.ts`). */
const fail = (e: unknown): never => {
  const failure = startupFailure(e);
  console.error(failure.message);
  process.exit(failure.code);
};
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
    console.error(boundedMessage(`Dossier de travail invalide (absolu et existant attendu) : ${wsRaw}`));
    process.exit(2);
  }
  workspace = realpathSync(wsRaw);
}

// `--init` : le cœur complet (verrou du profil, tick du planificateur, MCP, passerelles de messagerie), pour une application qui reste ouverte ;
// sans lui, le noyau minimal de l'essai (les planifications ne tirent que par « Run now »).
const init = process.argv.includes("--init");
const opened = await openCore({ env, ...(init ? { init: true } : {}) }).catch(fail);
const { core, dataDir, profile } = opened;
if (init) {
  await core.init().catch(async (e: unknown) => {
    await core.dispose().catch(() => {});
    fail(e);
  });
}
await core.skills.reload();
const gatewayVersion = "0.1.5-gateway-spike";
// La voix : transcription par le fournisseur des réglages, synthèse par la voix de la machine (WAV) ; la fenêtre joue le son.
const voiceService = (core.app as unknown as { voice?: { transcribe(audio: Buffer, mime: string): Promise<string>; speech: { synthesize(text: string, opts?: { voice?: string; rate?: number }): Promise<{ wav: Buffer }> } } }).voice;
const voice = voiceService
  ? {
      transcribe: (audio: Buffer, mime: string) => voiceService.transcribe(audio, mime),
      synthesize: async (text: string) => {
        const v = core.settings.get("voice");
        return (await voiceService.speech.synthesize(text, { ...(v.ttsVoice ? { voice: v.ttsVoice } : {}), rate: v.ttsRate })).wav;
      },
    }
  : undefined;
// Les délais d'attente d'un accord : le défaut du noyau (10 min pour un outil, 1 h pour un geste natif) est
// raisonnable mais doit pouvoir être resserré par qui fait tourner la passerelle (service, machine partagée).
const timeoutMs = (raw: string | undefined): number | undefined => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1_000 ? Math.min(n, 24 * 60 * 60_000) : undefined;
};
const approvalTimeoutMs = timeoutMs(env.JAROD_APPROVAL_TIMEOUT_MS);
const shellTimeoutMs = timeoutMs(env.JAROD_SHELL_TIMEOUT_MS);
const gateway = createGateway({
  core,
  ...(workspace ? { workspace } : {}),
  version: gatewayVersion,
  ...(voice ? { voice } : {}),
  ...(env.JAROD_GATEWAY_TOKEN ? { token: env.JAROD_GATEWAY_TOKEN } : {}),
  ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
  ...(shellTimeoutMs === undefined ? {} : { shellTimeoutMs }),
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
// Le navigateur de l'agent : les outils `browser_*` n'existent qu'avec un hôte ; ici c'est la fenêtre de Jarod-OS (sa fenêtre isolée est tenue par son processus principal).
const remoteBrowser = createRemoteBrowser({ link: gateway.link, visible: () => core.settings.get("browserVisible") !== false, persistent: () => core.settings.get("browserPersistent") === true });
const detachBrowser = (core.app as unknown as { tools?: { attachBrowser(port: typeof remoteBrowser): () => void } }).tools?.attachBrowser(remoteBrowser);
// E2 (navigateur connecté) : branché au cycle de vie de la passerelle, ÉTEINT par défaut (voir `connected-browser.ts`).
const connectedBrowser = startConnectedBrowser(core, env, (line) => console.error(`[passerelle] ${line}`));
const shell = createBridgeShell({ version: gatewayVersion, dataDir, link: gateway.link });
gateway.attachBridge(createBridgePort(createHandlers({ kernel: () => kernel, shell, registry: new RegistryClient(HERMES_REGISTRY), switchProfile, agentBrowser: remoteBrowser }), (channel) => assertOneaiChannel("invoke", channel)));
const pushEvent = (channel: string, ...args: unknown[]) => gateway.link.send(channel, args);
const unbindEvents = [bindLocalModelsEvents(kernel.localEngine?.models, pushEvent), bindUpdateEvents(core.app as never, pushEvent), bindVoiceEvents(core.app as never, pushEvent)];
// Le serveur d'API compatible OpenAI que l'utilisateur avait allumé revient avec le noyau.
await startRememberedApiServers().catch((e: unknown) => console.error(boundedMessage(`[passerelle] serveur d'API non rallumé : ${e instanceof Error ? e.message : String(e)}`)));
const port = await gateway.listen(env.JAROD_GATEWAY_PORT ? Number(env.JAROD_GATEWAY_PORT) : 0).catch(fail);
const file = join(dataDir, "gateway.json");
// Le fichier porte le jeton en clair : écrit par `writeSecretFile` (0o600, plus `icacls` sous Windows), effacé à l'arrêt.
const hardened = writeSecretFile(file, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: gateway.token }));
if (hardened.error) console.error(`[passerelle] jeton en clair non restreint : ${hardened.error}`);
console.log(`HERMES_BACKEND_READY port=${port}`);
// Où lire l'adresse et le jeton : le jeton n'est jamais imprimé, il est dans ce fichier (réservé à l'utilisateur).
console.log(`JAROD_GATEWAY_FILE ${file}`);
console.error(`[passerelle] profil ${dataDir} ; url+jeton dans ${file} ; dossier de travail ${workspace ?? "(celui du shell)"}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  // Le contenu vient des outils : il traverse le masque du noyau et reste d'une ligne (un « non servi » n'est pas un dump).
  console.error(boundedMessage(`[passerelle] non servi : ${JSON.stringify(gateway.unhandled())}`));
  console.error(boundedMessage(`[passerelle] événements de Jarod sans équivalent : ${JSON.stringify(gateway.ignoredEvents())}`));
  for (const off of unbindEvents) off();
  await connectedBrowser?.stop().catch(() => {});
  detachBrowser?.();
  closeAllApiServers();
  await gateway.close();
  removeSecretFile(file); // un jeton ne survit pas à la passerelle qui l'a produit
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
