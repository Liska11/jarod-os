/**
 * @jarod/plugin-integrations — registre des intégrations externes (adaptateurs versionnés, licences vérifiées,
 * politique appliquée par les tests), observateur d'injections en mode observation, épurateur d'attributs de
 * trace. Aucun de ces éléments n'exécute quoi que ce soit : ils ne créent aucun canal à côté de
 * `executeGuardedTool`.
 */
import type { Context } from "cordis";
import { join } from "node:path";
import { assertAdapters, REGISTRY } from "./adapters.js";
import { type CapabilityService, type CockpitServices, capabilitiesTool, cockpitService } from "./cockpit/index.js";
import { codeReviewPlanTool, ocrBinary } from "./impl/code-review.js";
import { mediaTool, ytdlpBinary } from "./impl/media.js";
import { DesktopController, desktopTools, flauiWorker } from "./impl/desktop.js";
import { sandboxieDir, sandboxTools } from "./impl/sandboxie.js";
import { linuxTools, smolvmBinary } from "./impl/smolvm.js";
import { tmpdir } from "node:os";
import { activePolicy } from "@jarod/kernel/network";
import { osqueryBinary, osqueryTool } from "./impl/osquery.js";
import { type Lifecycle, type LifecycleDeps, startConnectedBrowserLifecycle } from "./impl/connected-browser-lifecycle.js";
import { createLocalTraces, type LocalTraces, normalizeTracesConfig } from "./otel/local-traces.js";

export * from "./adapters.js";
export * from "./cockpit/index.js";
export * from "./observer.js";
export * from "./impl/index.js";
export * from "./recipes/index.js";
export * from "./telemetry.js";
export * from "./otel/local-traces.js";

declare module "cordis" {
  interface Context {
    integrations: {
      registry: typeof REGISTRY;
      /** Le registre vivant des capacités (cockpit, lot 1) : lecture seule. */
      capabilities: CapabilityService;
      /** E2 : à appeler UNE fois par l'hôte (la passerelle). N'ajoute aucun outil tant que le réglage de l'utilisateur est éteint ou vide. */
      startConnectedBrowserLifecycle(o: Omit<LifecycleDeps, "tools">): Lifecycle;
      /** G2 : traces locales (absent si le profil n'a pas de dossier de données ou si l'agent n'est pas chargé). */
      traces: LocalTraces | undefined;
    };
  }
}

export const name = "integrations";
// Lus par le cockpit s'ils sont là (chargés avant : ordre inférieur) ; absents = rien de déclaré, le plugin démarre quand même.
export const inject = {
  storage: { required: false },
  tools: { required: false },
  skills: { required: false },
  permissions: { required: false },
  agent: { required: false },
};

export function apply(ctx: Context): void {
  // Un registre qui viole la politique empêche le démarrage de ce plugin : mieux vaut s'arrêter que mentir.
  assertAdapters(REGISTRY);
  // Cockpit : les services déjà chargés (ordre inférieur) sont lus par leur forme ; l'outil `capabilities` entre au registre existant.
  const tools = ctx.get("tools") as unknown as (CockpitServices["tools"] & { registry: { register(t: unknown): () => void } }) | undefined;
  const storage = ctx.get("storage") as unknown as { settings?: CockpitServices["settings"] } | undefined;
  const capabilities = cockpitService({
    tools,
    skills: ctx.get("skills") as unknown as CockpitServices["skills"],
    permissions: ctx.get("permissions") as unknown as CockpitServices["permissions"],
    settings: storage?.settings,
  });
  if (tools) ctx.effect(() => tools.registry.register(capabilitiesTool(capabilities)), "integrations:capabilities-tool");
  // G16 : le PLAN de revue de code (OpenCodeReview en délégation, sans modèle ni réseau) ; sans moteur, l'outil le dit à l'appel.
  if (tools) ctx.effect(() => tools.registry.register(codeReviewPlanTool(() => ocrBinary())), "integrations:code-review-plan");
  // G13 : diagnostics système prédéfinis (osqueryi, sans démon ni élévation), en lecture seule et audités ; Windows seulement (requêtes et binaire Windows).
  if (tools && process.platform === "win32") ctx.effect(() => tools.registry.register(osqueryTool(() => osqueryBinary())), "integrations:system-diagnostics");
  // G5 : texte d'une vidéo en ligne (yt-dlp) ; outil Internet (refusé hors ligne par la porte), accord à chaque appel.
  if (tools) ctx.effect(() => tools.registry.register(mediaTool(() => ytdlpBinary())), "integrations:media-fetch");
  // G15 (2026-10-21, Sandboxie-Plus installé par l'utilisateur) : lancer un programme dans le bac de Jarod (réseau coupé par défaut, réseau
  // ouvert = opération réservée), revoir et vider ce qu'il a écrit. Présent seulement si Sandboxie est installé (relu à chaque appel).
  if (tools && process.platform === "win32") {
    for (const t of sandboxTools({ dir: () => sandboxieDir(), internet: () => activePolicy().internet, scratch: join(tmpdir(), "jarod-sandbox-run") })) {
      ctx.effect(() => tools.registry.register(t), `integrations:${t.name}`);
    }
  }
  // G10 (2026-10-21, Mode développeur activé par l'utilisateur) : la machine Linux de Jarod (smolvm) ; réseau coupé par défaut, réseau et
  // écriture dans le dossier de travail = opérations réservées ; linux_prepare télécharge l'image (outil Internet).
  if (tools && process.platform === "win32") {
    for (const t of linuxTools({ bin: () => smolvmBinary(), internet: () => activePolicy().internet })) {
      ctx.effect(() => tools.registry.register(t), `integrations:${t.name}`);
    }
  }
  // D1 raccordé (2026-10-21) : pilote de fenêtres FlaUI, deux outils de l'agent (liste ; pilotage sous permissions, fenêtre = cible, action =
  // opération, clavier brut et souris réservés), un seul contrôleur par bureau, arrêt d'urgence Ctrl+Alt+Fin. Moteur arrêté à l'arrêt du plugin.
  if (tools && process.platform === "win32") {
    const desktop = new DesktopController({ worker: () => flauiWorker() });
    ctx.effect(() => {
      const off = desktopTools(desktop).map((t) => tools.registry.register(t));
      return () => {
        for (const f of off) f();
        desktop.dispose();
      };
    }, "integrations:desktop-control");
  }
  // G2 : traces locales OpenTelemetry, branchées à l'agent ; le réglage `localTraces` est relu à chaque trace (éteint par défaut).
  const agent = ctx.get("agent") as unknown as { attachSpans?(sink: LocalTraces["sink"]): () => void } | undefined;
  const dataDir = (ctx.get("storage") as unknown as { dataDir?: string } | undefined)?.dataDir;
  let traces: LocalTraces | undefined;
  if (agent?.attachSpans && dataDir) {
    const local = createLocalTraces({ dir: join(dataDir, "traces"), config: () => normalizeTracesConfig(storage?.settings?.get("localTraces")) });
    traces = local;
    ctx.effect(() => {
      const detach = agent.attachSpans!(local.sink);
      return () => {
        detach();
        void local.shutdown();
      };
    }, "integrations:local-traces");
  }
  ctx.provide("integrations", {
    traces,
    registry: REGISTRY,
    capabilities,
    startConnectedBrowserLifecycle: (o) => {
      const tools = ctx.get("tools") as unknown as LifecycleDeps["tools"] | undefined;
      if (!tools) throw new Error("E2 : le service d'outils est absent, le navigateur connecté ne peut pas être branché");
      return startConnectedBrowserLifecycle({ ...o, tools });
    },
  });
}
