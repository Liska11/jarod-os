/**
 * @jarod/plugin-gateways — `ctx.gateways` : Telegram, Discord, Slack, WhatsApp (Cloud API), e-mail,
 * l'appairage, le pont téléphone (mobile + mobile-page, secret d'appairage de `remote/host.ts`) et
 * android/adb (PLAN §2). Services portés tels quels de `services/{telegram,discord,slack,whatsapp,
 * email,pairing}.ts` ; câblage de `core.ts:270-274,605-610,684-688,989-1073,1158-1219,1293-1381`
 * dans `hub.ts`. Une passerelle démarrée s'enregistre dans `runtime.gateways` (plugin-agent) : c'est
 * par là que les tâches planifiées, l'appairage et l'outil `present` livrent.
 */
import { type GatewayStatus, GatewaysConfig, type KernelEvents } from "@jarod/contracts";
import type {} from "@jarod/plugin-agent";
import type {} from "@jarod/plugin-llm";
import type {} from "@jarod/plugin-storage";
import { transcribe } from "@jarod/plugin-voice";
import type { Context } from "cordis";
import { androidTools } from "./android-tools.js";
import { GatewayHub } from "./hub.js";
import { registerPairCommand } from "./pair-command.js";

export * from "./android.js";
export * from "./android-tools.js";
export * from "./discord.js";
export * from "./email.js";
export * from "./hub.js";
export * from "./pair-command.js";
export * from "./mobile.js";
export * from "./mobile-page.js";
export * from "./pairing.js";
export * from "./remote-host.js";
export * from "./remote-protocol.js";
export * from "./slack.js";
export * from "./telegram.js";
export * from "./whatsapp.js";

declare module "cordis" {
  interface Context {
    gateways: GatewayHub;
  }
  interface Events extends KernelEvents {}
}

export const name = "gateways";
export const inject = ["storage", "llm", "agent"];
export const Config = GatewaysConfig;

export function apply(ctx: Context, input: GatewaysConfig): void {
  const config = GatewaysConfig.parse(input ?? {});
  const runtime = ctx.agent;
  const hub = new GatewayHub({
    runtime,
    // `core.transcribe` (core.ts:1112-1114) : même fonction que `ctx.voice.transcribe`.
    transcribe: (audio, mime) => transcribe(ctx.llm.providers, ctx.storage.settings, audio, mime),
    options: config,
  });
  hub.on("gateway", (st: GatewayStatus) => ctx.emit("gateway:status", st));
  // `/pair` (core.ts:2025-2045) vit avec l'appairage.
  registerPairCommand({ commands: runtime.commands, settings: runtime.settings, pairing: hub.pairing });
  // core.ts:529 — une commande adb = une approbation (outils `dangerous`).
  const unregisterAndroid = androidTools(hub.android).map((t) => runtime.tools.register(t));
  ctx.provide("gateways", hub);
  ctx.effect(() => {
    if (config.autoStart) {
      hub.syncAll();
      // core.ts:510-515 — a bridge the user switched on comes back with the app; a fresh install listens to nothing.
      if (runtime.settings.get("mobile").enabled) {
        void hub.mobile.start().catch((e: unknown) => {
          runtime.notifications.add("error", "Pont local", (e as Error).message);
        });
      }
    }
    return async () => {
      hub.stopAll();
      await hub.mobile.close();
      for (const off of unregisterAndroid) off();
      runtime.commands.unregisterWhere((c) => c.name === "pair" && c.source === "builtin");
    };
  }, "gateways:live");
}
