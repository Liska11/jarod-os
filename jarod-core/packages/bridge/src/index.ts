// L'API de @jarod/bridge : les handlers de pilotage de Jarod (venus de l'application jarod-cordis, sans Electron), le kernel vu par eux et le shell qu'ils attendent.
export { assertOneaiChannel, ONEAI_EVENT_CHANNELS, ONEAI_INVOKE_CHANNELS } from "@jarod/contracts/ipc";
export { bindLocalModelsEvents, bindUpdateEvents, bindVoiceEvents, closeAllApiServers, createHandlers, startRememberedApiServers } from "./main/handlers/index.js";
export type { DesktopKernel, DesktopShell, HandlerContext } from "./main/handlers/index.js";
export { desktopKernelOf } from "./main/kernel.js";
export type { OneaiHandler } from "./main/ipc.js";
export { HERMES_REGISTRY, RegistryClient } from "./main/registry.js";
