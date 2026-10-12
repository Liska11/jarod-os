import type { CliCore } from "./context.js";

/** Forme structurelle minimale du PortabilityService (plugin-memory) utilisée par cette commande. */
interface PortabilityPort {
  inspect(dir: string): {
    manifest: { profile: string; version: number | string };
    memory: { added: number; alreadyThere: number };
    settings: string[];
    ignored: string[];
    approval: { key: string; lines: string[] }[];
  };
  apply(dir: string, opts?: { approve?: readonly string[] }): {
    memory: { added: number; alreadyThere: number };
    settings: number;
    personas: number;
    ignored: string[];
    approved: string[];
  };
}

export async function portabilityApply(core: CliCore, args: { bundleDir: string; profile: string; approveMcp: boolean }): Promise<number> {
  const { bundleDir, profile, approveMcp } = args;

  // Get the memory plugin from the app's reflect store (where cordis stores plugin instances)
  // The key is Symbol("memory") - a Symbol with description "memory"
  const store = core.app.reflect?.store as Record<symbol, { value?: { portability?: PortabilityPort } }> | undefined;
  const memorySymbol = store ? Object.getOwnPropertySymbols(store).find(s => s.description === "memory") : undefined;
  const memoryPlugin = store && memorySymbol ? store[memorySymbol] : undefined;
  if (!memoryPlugin) {
    console.error("Plugin memory non chargé");
    return 1;
  }

  const portability = memoryPlugin.value?.portability;
  if (!portability) {
    console.error("PortabilityService non disponible");
    return 1;
  }
  
  try {
    // First inspect
    console.log(`Inspection du bundle: ${bundleDir}`);
    const inspection = portability.inspect(bundleDir);
    
    console.log(`Bundle: ${inspection.manifest.profile} (v${inspection.manifest.version})`);
    console.log(`Mémoire: ${inspection.memory.added} nouveaux, ${inspection.memory.alreadyThere} existants`);
    console.log(`Réglages à écrire: ${inspection.settings.join(", ") || "aucun"}`);
    console.log(`Réglages ignorés: ${inspection.ignored.join(", ") || "aucun"}`);
    console.log(`Réglages à approuver: ${inspection.approval.map(a => a.key).join(", ") || "aucun"}`);
    
    if (inspection.approval.length > 0) {
      for (const a of inspection.approval) {
        console.log(`  ${a.key}:`);
        for (const line of a.lines) console.log(`    ${line}`);
      }
    }
    
    // Check if we need approval for mcpServers
    const needsMcpApproval = inspection.approval.some(a => a.key === "mcpServers");
    if (needsMcpApproval && !approveMcp) {
      console.log("\n⚠️  mcpServers nécessite une approbation. Relancez avec --approve-mcp");
      return 1;
    }
    
    console.log("\nApplication du bundle...");
    const result = portability.apply(bundleDir, {
      approve: approveMcp ? ["mcpServers"] : []
    });
    
    console.log("✅ Import appliqué:");
    console.log(`  Mémoire: +${result.memory.added} (${result.memory.alreadyThere} déjà présents)`);
    console.log(`  Réglages: ${result.settings} écrits`);
    console.log(`  Personas: ${result.personas} ajoutés`);
    console.log(`  Ignorés: ${result.ignored.join(", ") || "aucun"}`);
    console.log(`  Approuvés: ${result.approved.join(", ") || "aucun"}`);
    
    return 0;
  } catch (error) {
    console.error(`Erreur: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}