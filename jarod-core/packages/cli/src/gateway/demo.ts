// Démonstration de l'essai : le VRAI noyau de Jarod sur un profil jetable, un FAUX fournisseur de modèle local (aucune clé, aucun réseau
// externe) et la passerelle, dans un seul processus. À lancer avec `pnpm --filter @jarod/cli exec tsx src/gateway/demo.ts`, puis à
// brancher au shell de Herald OS :
//   HERALD_OS_BACKEND_URL=http://127.0.0.1:<port>  HERALD_OS_BACKEND_TOKEN=<jeton>
// Le faux modèle répond en écho ; si le message contient « écris », il demande d'écrire un fichier (donc l'accord de l'utilisateur).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { openCore } from "../context.js";
import { createGateway } from "./server.js";
import { writeSecretFile } from "./secret-file.js";

const root = mkdtempSync(join(tmpdir(), "jarod-gateway-demo-"));
const workspace = join(root, "travail");
mkdirSync(workspace);

type Msg = { role: string; content?: unknown; tool_calls?: unknown[] };
const chunk = (d: Record<string, unknown>, finish?: string) => ({ choices: [{ delta: d, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 8 } } : {}) });

const llm = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const messages = (JSON.parse(body || "{}").messages ?? []) as Msg[];
    const last = messages.at(-1);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    let parts: Record<string, unknown>[];
    if (last?.role === "tool") parts = [chunk({ content: "C'est fait : " }), chunk({ content: String(last.content ?? "").slice(0, 120) }), chunk({}, "stop")];
    else if (/processus/i.test(userText)) {
      // Outil système en lecture : aucun accord, un résultat réel de la machine.
      parts = [chunk({ tool_calls: [{ index: 0, id: "call-ps", type: "function", function: { name: "system_processes", arguments: JSON.stringify({ action: "top", sort: "memory", limit: 3 }) } }] }), chunk({}, "tool_calls")];
    } else if (/ouvre/i.test(userText)) {
      // Outil système qui agit : la carte d'accord de Herald, avec la phrase de l'action.
      const path = process.env.JAROD_DEMO_OPEN || workspace;
      parts = [chunk({ tool_calls: [{ index: 0, id: "call-open", type: "function", function: { name: "system_open", arguments: JSON.stringify({ target: "path", path }) } }] }), chunk({}, "tool_calls")];
    } else if (/écris/i.test(userText)) {
      parts = [chunk({ tool_calls: [{ index: 0, id: "call-demo", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "demo.txt", content: "écrit par Jarod via la passerelle" }) } }] }), chunk({}, "tool_calls")];
    } else parts = [chunk({ content: "Jarod (faux modèle) a reçu : " }), ...userText.split(/(\s+)/).filter(Boolean).map((w) => chunk({ content: w })), chunk({}, "stop")];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const p of parts) {
      res.write(`data: ${JSON.stringify(p)}\n\n`);
      await new Promise((r) => setTimeout(r, 40));
    }
    res.end("data: [DONE]\n\n");
  });
});
const llmPort: number = await new Promise((ok) => llm.listen(0, "127.0.0.1", () => ok((llm.address() as { port: number }).port)));

const pm = new ProfileManager(root);
pm.create("demo");
pm.setActive("demo");
const { core } = await openCore({ env: { JAROD_HOME: root, JAROD_CUSTOM_API_KEY: ["demo", "key", "not-a-secret"].join("-") } });
// `JAROD_DEMO_OLLAMA=<modèle>` : un VRAI modèle local (Ollama) à la place du faux fournisseur.
const realModel = process.env.JAROD_DEMO_OLLAMA?.trim();
core.settings.patch(
  realModel
    ? { activeProvider: "ollama", activeModel: realModel, autoTitle: false, workspace }
    : { activeProvider: "custom", activeModel: "faux-modele", providerOverrides: { custom: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, models: ["faux-modele"] } }, autoTitle: false, workspace },
);
await core.skills.reload();
// De quoi remplir les pages Automatisations et Mémoire du shell.
core.scheduler.save({ name: "Bilan du matin", prompt: "Résume ma journée d'hier.", spec: { kind: "daily", time: "08:30" } });
core.memory.add("Je préfère les réponses courtes.");
core.memory.add("Mon dossier de travail est D:/JAROD-OS.");
core.userProfile.add("Identité", "Prénom : Marc");

const gateway = createGateway({ core, version: "0.1.5-gateway-spike", log: (line) => console.error(`[passerelle] ${line}`) });
const port = await gateway.listen(0);
const info = { url: `http://127.0.0.1:${port}`, token: gateway.token, workspace, profile: root };
// Le fichier porte le jeton en clair, même en démonstration : même écriture protégée que la passerelle (0o600, `icacls`).
const hardened = writeSecretFile(join(root, "gateway.json"), JSON.stringify(info));
if (hardened.error) console.error(`[passerelle] jeton en clair non restreint : ${hardened.error}`);
console.log(`HERMES_BACKEND_READY port=${port}`);
console.log(JSON.stringify(info));

const stop = async () => {
  console.error("[passerelle] non servi :", JSON.stringify(gateway.unhandled()));
  console.error("[passerelle] événements de Jarod sans équivalent :", JSON.stringify(gateway.ignoredEvents()));
  await gateway.close();
  await core.dispose().catch(() => {});
  llm.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
