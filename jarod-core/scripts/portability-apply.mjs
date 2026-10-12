// Standalone portability apply script - bypasses CLI issues
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { ProfileManager } from "@jarod/plugin-persona";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";
import { portabilityApply as portabilityApplyFn } from "../packages/cli/src/portability.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

function defaultDataRoot(env = process.env, platform = process.platform, home = homedir()) {
  if (env.JAROD_HOME) return env.JAROD_HOME;
  const appData =
    platform === "win32"
      ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return join(appData, "Jarod-One", "data");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] !== "apply") {
    console.error("Usage: node portability-apply.mjs apply <bundle-dir> [--profile <name>] [--approve-mcp]");
    process.exit(1);
  }

  const bundleDir = args[1];
  let profile = "default";
  let approveMcp = false;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--profile" && args[i + 1]) {
      profile = args[++i];
    } else if (args[i] === "--approve-mcp") {
      approveMcp = true;
    }
  }

  const env = process.env;
  const root = defaultDataRoot(env);
  if (!existsSync(root) && !env.JAROD_HOME) {
    throw new Error(`Aucune donnée Jarod-One trouvée dans ${root}. Lancez l'application une première fois, ou définissez JAROD_HOME.`);
  }

  const profiles = new ProfileManager(root);
  if (!profiles.list().includes(profile)) throw new Error(`Profil inconnu : ${profile}`);
  const dataDir = profiles.dirFor(profile);

  // Create minimal kernel with only storage and memory plugins
  const plugins = {};
  plugins.storage = { dataDir, cipher: electronSecretsCipher(electronUserDataDir(env)) };
  plugins.memory = {};

  const app = new JarodApp({ plugins });
  const started = await start(app);

  // Get the memory plugin from the app
  const memoryPlugin = app.reflect.store.get(Symbol.for("memory"));
  if (!memoryPlugin) {
    console.error("Plugin memory non chargé");
    await stop(started);
    process.exit(1);
  }

  const portability = memoryPlugin.value?.portability;
  if (!portability) {
    console.error("PortabilityService non disponible");
    await stop(started);
    process.exit(1);
  }

  try {
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

    const needsMcpApproval = inspection.approval.some(a => a.key === "mcpServers");
    if (needsMcpApproval && !approveMcp) {
      console.log("\n⚠️  mcpServers nécessite une approbation. Relancez avec --approve-mcp");
      await stop(started);
      process.exit(1);
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

    await stop(started);
    process.exit(0);
  } catch (error) {
    console.error(`Erreur: ${error instanceof Error ? error.message : String(error)}`);
    await stop(started);
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});