/**
 * G9 — MCP Inspector à la demande (OUTIL DE DÉVELOPPEMENT), en bouclage, avec un jeton propre à l'instance.
 *
 *   pnpm run mcp:inspect                                   # interface web vide (catalogue temporaire)
 *   pnpm run mcp:inspect -- --port 6300 -- node serveur.mjs # interface web sur un serveur stdio
 *   pnpm run mcp:inspect -- --list tools -- node serveur.mjs # lecture seule du catalogue, en JSON
 *
 * Moteur : JAROD_MCP_INSPECTOR, sinon engines/mcp-inspector (voir engines.lock/README.md). Ctrl+C arrête l'instance lancée ici, et elle seule.
 * Le jeton n'est jamais mis dans l'URL : il s'affiche une fois, ici, pour l'écran de connexion de l'interface.
 */
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectorList, type InspectorListMethod, startInspector } from "../packages/plugins/integrations/src/impl/mcp-inspector.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = process.argv.slice(2);
// Le premier « -- » est celui de pnpm ; le suivant sépare les options de la commande du serveur.
const args = raw[0] === "--" ? raw.slice(1) : raw;
const sep = args.indexOf("--");
const opts = sep >= 0 ? args.slice(0, sep) : args;
const command = sep >= 0 ? args.slice(sep + 1) : [];
const opt = (name: string) => {
  const i = opts.indexOf(name);
  return i >= 0 ? opts[i + 1] : undefined;
};

async function main(): Promise<void> {
  const engineDir = process.env.JAROD_MCP_INSPECTOR ?? join(ROOT, "engines", "mcp-inspector");
  const server = command.length ? { name: opt("--name") ?? "serveur", command: command[0]!, args: command.slice(1), cwd: process.cwd() } : undefined;
  const list = opt("--list");
  if (list) {
    if (!server) throw new Error("--list exige la commande du serveur après « -- »");
    const method = `${list}/list` as InspectorListMethod;
    console.log(JSON.stringify(await inspectorList({ engineDir, server, method }), null, 2));
    return;
  }
  const port = opt("--port") ? Number(opt("--port")) : undefined;
  const inst = await startInspector({ engineDir, ...(server ? { server } : {}), ...(port ? { port } : {}) });
  console.log(`MCP Inspector (outil de développement) : ${inst.url}`);
  console.log(`Jeton de session, à saisir dans l'interface (éphémère, jamais journalisé) : ${inst.token}`);
  console.log("Ctrl+C pour arrêter cette instance.");
  const stop = async () => {
    await inst.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(`mcp:inspect : ${(e as Error).message}`);
  process.exit(1);
});
