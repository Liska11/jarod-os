/**
 * A throwaway Jarod for the phone app's development: a real kernel on a temporary profile (nothing
 * of yours is read or written), its mobile bridge on port 10493, and a scripted model that streams
 * its answer and asks for one approval when told "approuve". Prints the pairing link.
 *
 *   pnpm --dir jarod-core exec tsx packages/plugins/gateways/scripts/dev-phone-pc.ts
 *   JAROD_BRIDGE=http://127.0.0.1:10493 npm --prefix mobile run dev
 */
import { bootApp, discoverPlugins, shutdown, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";

const port = Number(process.env.PORT ?? 10493);
const plugins: Record<string, Record<string, unknown>> = {};
for (const p of discoverPlugins()) plugins[p.name] = {};
plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
plugins.scheduler = { autoStart: false };
plugins.gateways = { autoStart: false };
const app = await bootApp(plugins);
const core = app.agent as unknown as {
  settings: { patch(v: Record<string, unknown>): void; set(k: string, v: unknown): void };
  providers: { client: (provider: string) => unknown };
  notifications: { add(kind: string, title: string, body?: string): void };
};
core.settings.patch({ activeProvider: "openai", activeModel: "dev-phone" });
core.settings.set("autoTitle", false);

let turn = 0;
core.providers.client = () => ({
  listModels: async () => [],
  chat: async (req: { messages: { role: string; content: unknown }[] }, handlers?: { onText?: (t: string) => void }) => {
    const last = [...req.messages].reverse().find((m) => m.role === "user");
    const said = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    const wantsTool = /approuve/i.test(said) && !req.messages.some((m) => m.role === "tool");
    if (wantsTool) {
      return {
        text: "",
        thinking: "",
        stopReason: "tool_use",
        toolCalls: [{ id: `call-${++turn}`, name: "write_file", args: { path: "essai-telephone.txt", content: "bonjour" } }],
      };
    }
    const answer = `Bien reçu depuis le téléphone : **${said.slice(0, 200)}**.\n\nCeci est le modèle factice du PC de développement.`;
    for (const word of answer.split(/(?<= )/)) {
      handlers?.onText?.(word);
      await new Promise((d) => setTimeout(d, 40));
    }
    return { text: answer, thinking: "", toolCalls: [], stopReason: "stop" };
  },
});

const hub = app.gateways;
await hub.mobile.start(port);
const pairing = await hub.mobile.appPairing();
console.log(`\nJarod de développement sur le port ${port}. Lien d'association (10 min) :\n\n${pairing.appLink}\n`);
setInterval(() => core.notifications.add("info", "Rappel de test", "Une notification du PC de développement."), 120_000).unref();

const stop = async () => {
  await hub.mobile.close();
  await shutdown(app);
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
