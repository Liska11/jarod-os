/**
 * La carte des handlers de l'ui-bridge branchés sur le kernel (W8 ; + capture vocale W10, canaux Jarod). Un canal hermesAPI absent d'ici
 * répond « canal non porté » (`dispatchOneaiCall`) : la liste grandit au fil du portage, jamais de
 * succès apparent pour un service qui n'existe pas encore côté Jarod.
 */
import type { OneaiHandler } from "../ipc.js";
import { createAccountHandlers } from "./account.js";
import { createApiServerHandlers } from "./api-server.js";
import { createAppHandlers } from "./app.js";
import { createApprovalBroker } from "./approvals.js";
import { createAutomationHandlers } from "./automation.js";
import { createSecretsHandlers } from "./secrets.js";
import { createBackupHandlers } from "./backup.js";
import { createChatHandlers } from "./chat.js";
import { createConfigHandlers } from "./config.js";
import type { HandlerContext } from "./context.js";
import { createCronHandlers } from "./cron.js";
import { createFileGate, createFileHandlers } from "./files.js";
import { createGatewayHandlers } from "./gateways.js";
import { createHuggingFaceHandlers } from "./huggingface.js";
import { createInstallHandlers } from "./install.js";
import { createJarodSettingsHandlers } from "./jarod-settings.js";
import { createKanbanHandlers } from "./kanban.js";
import { createLocalEngineHandlers } from "./local-engine.js";
import { createLocalModelsHandlers } from "./local-models.js";
import { createMcpHandlers } from "./mcp.js";
import { createPlatformHandlers } from "./platform.js";
import { createMemoryHandlers } from "./memory.js";
import { createModelHandlers } from "./models.js";
import { createPluginHandlers } from "./plugins.js";
import { createPhoneHandlers } from "./phone.js";
import { createRagIndexHandlers } from "./rag-index.js";
import { createProfileHandlers } from "./profiles.js";
import { createProviderHandlers } from "./providers.js";
import { createRegistryHandlers } from "./registry.js";
import { createRemoteHandlers } from "./remote.js";
import { createSessionHandlers } from "./sessions.js";
import { createSkillsHandlers } from "./skills.js";
import { createToolsHandlers } from "./tools.js";
import { createCapabilityHandlers } from "./capabilities.js";
import { createCodespaceHandlers } from "./codespace.js";
import { createTaskHandlers } from "./tasks.js";
import { createAuditHandlers } from "./audit.js";
import { createContextHandlers } from "./context-view.js";
import { createArtifactHandlers } from "./artifacts.js";
import { createSshHostHandlers } from "./ssh-hosts.js";
import { createUpdateHandlers } from "./updates.js";
import { createVaultHandlers } from "./vault.js";
import { createVoiceHandlers } from "./voice.js";
import { createWorkspaceHandlers } from "./workspace.js";

export type { DesktopKernel, DesktopShell, HandlerContext } from "./context.js";
export { closeAllApiServers, startRememberedApiServers } from "./api-server.js";
export { bindUpdateEvents } from "./updates.js";
export { bindVoiceEvents } from "./voice.js";
export { bindLocalModelsEvents } from "./local-models.js";

export function createHandlers(ctx: HandlerContext): Record<string, OneaiHandler> {
  // Q12 : une seule garde fichiers pour tous les canaux (racines choisies dans la boîte native, journal).
  const gate = createFileGate(ctx);
  // Accord des outils : un seul courtier, partagé entre le chat (qui pose les demandes) et ses canaux de réponse.
  const approvals = createApprovalBroker(ctx);
  return {
    ...createAppHandlers(ctx),
    ...createInstallHandlers(ctx),
    ...createRemoteHandlers(ctx),
    ...createAccountHandlers(ctx),
    ...createConfigHandlers(ctx),
    ...createModelHandlers(ctx),
    ...createProfileHandlers(ctx),
    ...createProviderHandlers(ctx),
    ...createChatHandlers(ctx, gate, approvals.broker),
    ...approvals.handlers,
    ...createSessionHandlers(ctx, gate),
    ...createFileHandlers(ctx, gate),
    ...createAutomationHandlers(ctx),
    ...createSecretsHandlers(ctx),
  ...createBackupHandlers(ctx, gate),
    ...createMemoryHandlers(ctx),
    ...createGatewayHandlers(ctx),
    ...createCronHandlers(ctx),
    ...createKanbanHandlers(ctx, gate),
    ...createSkillsHandlers(ctx),
    ...createRegistryHandlers(ctx),
    ...createToolsHandlers(ctx),
    ...createCapabilityHandlers(ctx),
    ...createTaskHandlers(ctx),
    ...createAuditHandlers(ctx),
    ...createContextHandlers(ctx),
    ...createArtifactHandlers(ctx),
    ...createMcpHandlers(ctx),
    ...createVoiceHandlers(ctx),
    ...createWorkspaceHandlers(ctx, gate),
    ...createCodespaceHandlers(ctx, gate),
    ...createUpdateHandlers(ctx),
    ...createJarodSettingsHandlers(ctx),
    ...createPluginHandlers(ctx),
    ...createPlatformHandlers(ctx),
    ...createVaultHandlers(ctx),
    ...createSshHostHandlers(ctx),
    ...createPhoneHandlers(ctx),
    ...createApiServerHandlers(ctx),
    ...createLocalEngineHandlers(ctx),
    ...createLocalModelsHandlers(ctx),
    ...createHuggingFaceHandlers(ctx),
    ...createRagIndexHandlers(ctx),
  } as Record<string, OneaiHandler>;
}
