/**
 * A throwaway Jarod for the phone app's development: a real kernel on a temporary profile (nothing
 * of yours is read or written), its mobile bridge on port 10493, and a scripted model that streams
 * its answer and asks for one approval when told "approuve". Prints the pairing link.
 * Phone approvals are on, and a loopback-only control port (CONTROL_PORT, default 10494) lets a
 * developer play the PC: `/approve` asks the phones as a background task would, `/notify?kind=`
 * (task, reminder, alert) adds a notification.
 *
 *   pnpm --dir jarod-core exec tsx packages/plugins/gateways/scripts/dev-phone-pc.ts
 *   JAROD_BRIDGE=http://127.0.0.1:10493 npm --prefix mobile run dev
 */
import { bootApp, discoverPlugins, shutdown, tempDir } from "@jarod/kernel/testing";
import { createServer } from "node:http";
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
  sessions: { create(title?: string): { id: string } };
  backgroundHooks: { approve(sessionId: string, call: unknown, description: string): Promise<boolean> };
  providers: { client: (provider: string) => unknown };
  notifications: { add(kind: string, title: string, body?: string): void };
};
core.settings.patch({ activeProvider: "openai", activeModel: "dev-phone" });
core.settings.set("autoTitle", false);
core.settings.set("phoneApprovals", true);

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
// No speech-to-text on a throwaway profile: a fixed sentence stands in, saying it is one.
(hub as unknown as { transcribeWith: (audio: Buffer) => Promise<string> }).transcribeWith = async (audio) =>
  `Ceci est une transcription de test (${Math.max(1, Math.round(audio.length / 1024))} Ko d'audio reçus).`;
await hub.mobile.start(port);
const pairing = await hub.mobile.appPairing();
console.log(`\nJarod de développement sur le port ${port}. Lien d'association (10 min) :\n\n${pairing.appLink}\n`);

// Playing the PC, from this computer only.
const NOTES: Record<string, [string, string, string]> = {
  task: ["success", "Tâche terminée", "Le rapport de test est prêt."],
  reminder: ["info", "Rappel", "Appeler le garage à 15 h."],
  alert: ["warning", "Alerte", "Le disque D: est presque plein."],
};
const control = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/approve") {
    const session = core.sessions.create("Tâche planifiée (test)");
    const call = { id: `bg-${Date.now()}`, name: "run_shell", args: { command: "echo sauvegarde" } };
    void core.backgroundHooks.approve(session.id, call, "Lancer la sauvegarde de test").then((ok) => console.log(`approbation : ${ok ? "acceptée" : "refusée"}`));
    res.end("demandée\n");
    return;
  }
  if (url.pathname === "/notify") {
    const note = NOTES[url.searchParams.get("kind") ?? "task"] ?? NOTES.task!;
    core.notifications.add(note[0], note[1], note[2]);
    res.end("envoyée\n");
    return;
  }
  res.statusCode = 404;
  res.end();
});
control.listen(Number(process.env.CONTROL_PORT ?? 10494), "127.0.0.1");

const stop = async () => {
  control.close();
  await hub.mobile.close();
  await shutdown(app);
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
