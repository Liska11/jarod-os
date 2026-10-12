/**
 * SPECS-P5-UI-PARITE.md §3.3 — API compatible OpenAI branchée au kernel. Invariants : sans clé il ne s'allume pas ; chaque requête exige la clé ; un
 * client y parle à l'agent en LECTURE SEULE (mode Plan : aucune écriture, même avec « autoriser sans demander ») ; la clé n'est montrée qu'une fois ;
 * l'ouvrir au réseau passe par une boîte native. VRAI kernel, VRAI serveur HTTP, fournisseur LLM = stub.
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllApiServers, startRememberedApiServers } from "../src/main/handlers/index.js";
import { say, scripted, setupKernel, toolCall } from "./ui-parite-helpers.js";

afterEach(async () => {
  closeAllApiServers();
  await cleanup();
});
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

type Status = { enabled: boolean; running: boolean; port: number; host: string; keyConfigured: boolean; error: string };

async function api(confirmAnswers: boolean[] = [true], script = [say("réponse de l'agent")]) {
  const stub = await scripted(script);
  const k = await setupKernel(stub.port, confirmAnswers);
  k.app.agent.settings.set("apiServer", { enabled: false, port: 0, host: "127.0.0.1" }); // port libre choisi par le système
  return { ...k, stub };
}
const url = (s: Status, path: string) => `http://127.0.0.1:${s.port}${path}`;

describe("API compatible OpenAI", () => {
  it("sans clé : refus d'allumer ; une clé neuve est montrée UNE fois, jamais relue, et l'ancienne cesse de marcher", async () => {
    const { call, app, stub } = await api();
    try {
      await rejects(() => call("api-server-set", true), /aucune clé enregistrée/);
      expect(((await call("api-server-status")) as Status).keyConfigured).toBe(false);
      const a = (await call("api-server-new-key")) as { key: string };
      expect(a.key).toMatch(/^jarod-[0-9a-f]{48}$/);
      expect(((await call("api-server-status")) as Status).keyConfigured).toBe(true);
      expect(JSON.stringify(await call("api-server-status"))).not.toContain(a.key);
      const b = (await call("api-server-new-key")) as { key: string };
      expect(b.key).not.toBe(a.key);
      expect(app.agent.settings.getSecret("api:openai:key")).toBe(b.key);
    } finally {
      stub.close();
    }
  });

  it("un serveur allumé revient au lancement (clé requise) ; créer les handlers n'ouvre aucun port", async () => {
    const { call, app, stub } = await api();
    try {
      await call("api-server-new-key");
      app.agent.settings.set("apiServer", { enabled: true, port: 0, host: "127.0.0.1" });
      expect(((await call("api-server-status")) as Status).running).toBe(false);
      await startRememberedApiServers();
      const s = (await call("api-server-status")) as Status;
      expect(s).toMatchObject({ enabled: true, running: true });
      expect(s.port).toBeGreaterThan(0);
      closeAllApiServers();
      app.agent.settings.setSecret("api:openai:key", "");
      await startRememberedApiServers();
      expect(((await call("api-server-status")) as Status).running).toBe(false);
    } finally {
      stub.close();
    }
  });

  it("allumer : boîte native qui dit « lecture seule » ; refusée, rien n'écoute ; acceptée, le serveur répond ; éteindre ne demande rien", async () => {
    const { call, app, confirms, stub } = await api([false, true]);
    try {
      await call("api-server-new-key");
      await rejects(() => call("api-server-set", true), /refusé par l'utilisateur/);
      expect(confirms[0]!.detail).toMatch(/LECTURE SEULE/);
      expect(confirms[0]!.detail).toMatch(/cette machine seulement/);
      expect(app.agent.settings.get("apiServer").enabled).toBe(false);
      const on = (await call("api-server-set", true)) as Status;
      expect(on).toMatchObject({ enabled: true, running: true, keyConfigured: true });
      expect(on.port).toBeGreaterThan(0);
      const off = (await call("api-server-set", false)) as Status;
      expect(off).toMatchObject({ enabled: false, running: false });
      expect(confirms).toHaveLength(2);
      await rejects(() => call("api-server-set", "oui"), /booléen attendu/);
    } finally {
      stub.close();
    }
  });

  it("chaque requête exige la clé : sans clé ou avec une mauvaise, 401 ; avec la bonne, /v1/models répond", async () => {
    const { call, stub } = await api();
    try {
      const { key } = (await call("api-server-new-key")) as { key: string };
      const s = (await call("api-server-set", true)) as Status;
      expect((await fetch(url(s, "/v1/models"))).status).toBe(401);
      expect((await fetch(url(s, "/v1/models"), { headers: { authorization: "Bearer mauvaise" } })).status).toBe(401);
      const ok = await fetch(url(s, "/v1/models"), { headers: { authorization: `Bearer ${key}` } });
      expect(ok.status).toBe(200);
      expect(JSON.stringify(await ok.json())).toContain("jarod");
    } finally {
      stub.close();
    }
  });

  it("un client parle à l'agent ; la conversation existe dans Jarod, titrée, et l'agent y est en MODE PLAN", async () => {
    const { call, app, stub } = await api();
    try {
      const { key } = (await call("api-server-new-key")) as { key: string };
      const s = (await call("api-server-set", true)) as Status;
      const res = await fetch(url(s, "/v1/chat/completions"), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "jarod", stream: false, messages: [{ role: "user", content: "Bonjour depuis un client" }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      expect(body.choices[0]!.message.content).toBe("réponse de l'agent");
      const session = app.agent.sessions.list()[0]!;
      expect(session.context?.agentMode).toBe("plan");
      expect(app.agent.messages.list(session.id).some((m) => m.role === "user" && m.content.includes("Bonjour depuis un client"))).toBe(true);
    } finally {
      stub.close();
    }
  });

  it("LECTURE SEULE : un outil qui écrit est refusé pour le client, même avec « autoriser sans demander » ; rien n'est écrit", async () => {
    const dir = realpathSync.native(tempDir());
    const { call, app, stub } = await api([true], [toolCall("c1", "write_file", { path: "pirate.txt", content: "x" }), say("terminé")]);
    try {
      app.agent.settings.patch({ workspace: dir, autoApproveTools: true });
      const { key } = (await call("api-server-new-key")) as { key: string };
      const s = (await call("api-server-set", true)) as Status;
      const res = await fetch(url(s, "/v1/chat/completions"), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "jarod", stream: false, messages: [{ role: "user", content: "écris un fichier" }] }),
      });
      expect(res.status).toBe(200);
      expect(existsSync(join(dir, "pirate.txt"))).toBe(false);
      const tool = app.agent.messages.list(app.agent.sessions.list()[0]!.id).find((m) => m.role === "tool")!;
      expect(tool.isError).toBe(true);
      expect(tool.content).toMatch(/Mode Plan/);
    } finally {
      stub.close();
    }
  });

  it("réglage hôte/port : valeurs bornées ; ouvrir au réseau demande une boîte native, le fermer non ; `enabled` ne s'écrit PAS par ce canal", async () => {
    const { call, app, confirms, stub } = await api([false, true]);
    try {
      app.agent.settings.set("apiServer", { enabled: false, port: 8642, host: "127.0.0.1" });
      await rejects(() => call("set-jarod-settings", { apiServer: { host: "0.0.0.0" } }), /refusé par l'utilisateur/);
      expect(confirms[0]!.message).toMatch(/Ouvrir l'API au réseau local/);
      expect(app.agent.settings.get("apiServer").host).toBe("127.0.0.1");
      await call("set-jarod-settings", { apiServer: { host: "0.0.0.0", port: 9000 } });
      expect(app.agent.settings.get("apiServer")).toEqual({ enabled: false, port: 9000, host: "0.0.0.0" });
      await call("set-jarod-settings", { apiServer: { host: "127.0.0.1" } });
      expect(confirms).toHaveLength(2);
      for (const [patch, why] of [[{ port: 80 }, /entre 1024 et 65535/], [{ port: 70000 }, /entre/], [{ host: "192.168.1.5" }, /127\.0\.0\.1/], [{ enabled: true }, /inconnue/]] as [Record<string, unknown>, RegExp][]) {
        await rejects(() => call("set-jarod-settings", { apiServer: patch }), why);
      }
      expect(app.agent.settings.get("apiServer").enabled).toBe(false);
    } finally {
      stub.close();
    }
  });
});
