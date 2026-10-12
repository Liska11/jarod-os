/**
 * SPECS-P5-UI-PARITE.md § 13.4 — le REFUS est le défaut de l'accord des outils, épinglé cas par cas : FC1 (fenêtre fermée), FC2 (canal IPC mort), FC3 (expiration),
 * FC5 (lecture des permissions en échec), FC6 (réponse tardive ou inconnue), FC7 (réponse invalide), FC8 (écriture de `alwaysAllowTools` en échec), FC9 (confirmation native
 * indisponible ou refusée), FC10 (arrêt du tour) ; AR7 (pas de « Toujours » pour l'exécution de commandes arbitraires). FC4 (service d'approbation en erreur) est dans
 * `plugins/agent/test/approval-failclosed.test.ts`. Barres figées dans la spec AVANT le code.
 */
import { describe, expect, it } from "vitest";
import { createApprovalBroker, NEVER_ALWAYS } from "../src/main/handlers/approvals.js";

type Sent = [string, unknown];
const D = "Écrit un fichier";

function make(o: { send?: (c: string, p: unknown) => void; confirm?: ((m: string, d: string, a?: string) => Promise<boolean>) | null; tool?: unknown; toolsGet?: () => unknown; settingsSet?: () => void; timeoutMs?: number } = {}) {
  const sent: Sent[] = [];
  const list: string[] = [];
  const tool = o.tool ?? { dangerous: true, description: D };
  const ctx = {
    kernel: () =>
      ({
        agent: {
          tools: { get: o.toolsGet ?? (() => tool) },
          gate: { decide: () => "allow" },
          settings: { get: () => list, set: o.settingsSet ?? ((_k: string, v: string[]) => void (list.length = 0, list.push(...v))) },
        },
      }) as never,
    shell: {
      send: o.send ?? ((c: string, p: unknown) => void sent.push([c, p])),
      ...(o.confirm === null ? {} : { confirm: o.confirm ?? (async () => true) }),
    } as never,
  };
  return { sent, list, ...createApprovalBroker(ctx, o.timeoutMs ?? 60_000) };
}

describe("le refus est le défaut : chaque cas d'échec", () => {
  it("FC1 : la fenêtre répond « refuser » (fermée, Échap, clic à côté) ⇒ refus, rien d'accordé", async () => {
    const { broker, handlers, sent } = make();
    const p = broker.request("o1", "r", "s1", { name: "write_file" }, D);
    expect(await handlers["tool-approval-respond"](broker.list()[0]!.id, false)).toBe(true);
    expect(await p).toBe(false);
    expect(handlers["tool-approval-grants"]()).toEqual({ session: 0 });
    expect(sent.at(-1)![1]).toMatchObject({ allowed: false, reason: "answered" });
  });

  it("FC2 : canal IPC mort (`shell.send` LÈVE) ⇒ refus IMMÉDIAT, jamais une attente de 15 minutes, aucune demande restante", async () => {
    const { broker } = make({
      send: () => {
        throw new Error("Object has been destroyed");
      },
    });
    const t0 = Date.now();
    expect(await broker.request("o1", "r", "s1", { name: "write_file" }, D)).toBe(false);
    expect(Date.now() - t0, "refus immédiat").toBeLessThan(500);
    expect(broker.list()).toEqual([]);
  });

  it("FC2 bis : `shell.send` qui lève au moment de la résolution ne rend pas la décision à l'appelant en erreur et ne lui accorde rien", async () => {
    let calls = 0;
    const { broker, handlers } = make({
      send: (c: string) => {
        calls++;
        if (c === "tool-approval-resolved") throw new Error("fenêtre détruite");
      },
    });
    const p = broker.request("o1", "r", "s1", { name: "write_file" }, D);
    expect(calls).toBe(1);
    await handlers["tool-approval-respond"](broker.list()[0]!.id, false);
    expect(await p).toBe(false);
  });

  it("FC3 : sans réponse au délai ⇒ refus et demande retirée", async () => {
    const { broker, sent } = make({ timeoutMs: 25 });
    expect(await broker.request("o1", "r", "s1", { name: "write_file" }, D)).toBe(false);
    expect(broker.list()).toEqual([]);
    expect(sent.at(-1)![1]).toMatchObject({ allowed: false, reason: "timeout" });
  });

  it("FC5 : la lecture des permissions échoue (`tools.get` LÈVE) ⇒ la fenêtre s'affiche, ni « toujours » ni « conversation » n'est proposé, jamais un accord", async () => {
    const { broker, handlers } = make({
      toolsGet: () => {
        throw new Error("registre indisponible");
      },
    });
    let settled: boolean | undefined;
    void broker.request("o1", "r", "s1", { name: "write_file" }, D).then((v) => (settled = v));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBeUndefined(); // pas d'accord par défaut : la demande attend l'utilisateur
    expect(broker.list()).toHaveLength(1);
    expect(broker.list()[0]).toMatchObject({ canAlways: false, canSession: false });
    await expect(handlers["tool-approval-respond"](broker.list()[0]!.id, true, "session")).rejects.toThrow(/indisponible/);
    broker.cancel("o1");
  });

  it("FC6 : réponse tardive, inconnue ou périmée ⇒ `false`, rien n'est accordé", async () => {
    const { broker, handlers } = make();
    const p = broker.request("o1", "r", "s1", { name: "write_file" }, D);
    const id = broker.list()[0]!.id;
    broker.cancel("o1");
    expect(await p).toBe(false);
    expect(await handlers["tool-approval-respond"](id, true)).toBe(false); // trop tard
    expect(await handlers["tool-approval-respond"]("inconnu", true)).toBe(false);
  });

  it("FC7 : réponse invalide ⇒ erreur, rien d'accordé, la demande reste ouverte", async () => {
    const { broker, handlers } = make();
    void broker.request("o1", "r", "s1", { name: "write_file" }, D);
    const id = broker.list()[0]!.id;
    for (const args of [[42, true], [id, "oui"], [id, true, "toujours"], [id, null], [undefined, true]] as unknown[][]) {
      await expect(handlers["tool-approval-respond"](...(args as [unknown, unknown, unknown]))).rejects.toThrow(/attendu/);
    }
    expect(broker.list()).toHaveLength(1);
    expect(handlers["tool-approval-grants"]()).toEqual({ session: 0 });
    broker.cancel("o1");
  });

  it("FC8 : l'écriture de `alwaysAllowTools` échoue (`settings.set` LÈVE) ⇒ erreur, la demande RESTE ouverte, rien n'est accordé ni retenu", async () => {
    const { broker, handlers, list } = make({
      settingsSet: () => {
        throw new Error("disque plein");
      },
    });
    let settled: boolean | undefined;
    void broker.request("o1", "r", "s1", { name: "write_file" }, D).then((v) => (settled = v));
    const id = broker.list()[0]!.id;
    await expect(handlers["tool-approval-respond"](id, true, true)).rejects.toThrow(/disque plein/);
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBeUndefined();
    expect(broker.list()).toHaveLength(1);
    expect(list).toEqual([]);
    broker.cancel("o1");
  });

  it("FC9 : confirmation native indisponible ⇒ « toujours » refusé, la demande reste ouverte ; refusée de même", async () => {
    const none = make({ confirm: null });
    void none.broker.request("o1", "r", "s1", { name: "write_file" }, D);
    await expect(none.handlers["tool-approval-respond"](none.broker.list()[0]!.id, true, true)).rejects.toThrow(/indisponible/);
    expect(none.broker.list()).toHaveLength(1);
    none.broker.cancel("o1");
    const no = make({ confirm: async () => false });
    void no.broker.request("o1", "r", "s1", { name: "write_file" }, D);
    await expect(no.handlers["tool-approval-respond"](no.broker.list()[0]!.id, true, true)).rejects.toThrow(/refusé par l'utilisateur/);
    expect(no.broker.list()).toHaveLength(1);
    expect(no.list).toEqual([]);
    no.broker.cancel("o1");
  });

  it("FC10 : l'arrêt du tour refuse et retire SES demandes, pas celles d'un autre tour", async () => {
    const { broker } = make();
    const a = broker.request("tour-1", "r", "s1", { name: "write_file" }, D);
    const b = broker.request("tour-2", "r", "s2", { name: "write_file" }, D);
    broker.cancel("tour-1");
    expect(await a).toBe(false);
    expect(broker.list()).toHaveLength(1);
    broker.cancel("tour-2");
    expect(await b).toBe(false);
  });
});

describe("AR7 — pas de « Toujours » pour l'exécution de commandes arbitraires", () => {
  const shell = { dangerous: true, description: "Lance une commande" };

  it("RN1 la liste NEVER_ALWAYS : EXACTEMENT neuf outils (§ 23.1 ; web_fetch ajouté le 2026-10-05 et les trois outils système le 2026-10-11, décisions de l'utilisateur)", () => {
    expect([...NEVER_ALWAYS].sort()).toEqual(["android_shell", "cronjob", "http_request", "run_shell", "skill_hub_install", "system_files", "system_kill_process", "system_quit_app", "web_fetch"]);
  });

  it.each(["run_shell", "android_shell", "skill_hub_install", "cronjob", "http_request", "web_fetch", "system_files", "system_kill_process", "system_quit_app"])(
    "RN2 %s : `canAlways` FAUX, `canSession` VRAI ; « toujours » est refusé (rien n'est ajouté, la demande reste ouverte), « conversation » est accepté",
    async (name) => {
      const { broker, handlers, list } = make({ tool: { dangerous: true, description: `d ${name}` } });
      const p = broker.request("o1", "r", "s1", { name }, `d ${name}`);
      const req = broker.list()[0]!;
      expect(req).toMatchObject({ canAlways: false, canSession: true });
      for (const always of [true, "always"]) await expect(handlers["tool-approval-respond"](req.id, true, always)).rejects.toThrow(new RegExp(`indisponible pour ${name}`));
      expect(list).toEqual([]);
      expect(broker.list()).toHaveLength(1);
      expect(await handlers["tool-approval-respond"](req.id, true, "session")).toBe(true);
      expect(await p).toBe(true);
    },
  );

  it.each(["write_file", "edit_file"])("RN3 %s garde « Toujours » ET « cette conversation » (bornés par Q12, journalisés)", async (name) => {
    const { broker } = make();
    void broker.request("o1", "r", "s1", { name }, D);
    expect(broker.list()[0]).toMatchObject({ canAlways: true, canSession: true });
    broker.cancel("o1");
  });

  it("run_shell : `canAlways` FAUX, `canSession` VRAI ; « toujours » est refusé (rien n'est ajouté), « conversation » est accepté", async () => {
    const { broker, handlers, list } = make({ tool: shell });
    const p = broker.request("o1", "r", "s1", { name: "run_shell" }, "Lance une commande");
    const req = broker.list()[0]!;
    expect(req).toMatchObject({ canAlways: false, canSession: true });
    await expect(handlers["tool-approval-respond"](req.id, true, true)).rejects.toThrow(/indisponible/);
    await expect(handlers["tool-approval-respond"](req.id, true, "always")).rejects.toThrow(/indisponible/);
    expect(list).toEqual([]);
    expect(broker.list()).toHaveLength(1);
    expect(await handlers["tool-approval-respond"](req.id, true, "session")).toBe(true);
    expect(await p).toBe(true);
    expect(handlers["tool-approval-grants"]()).toEqual({ session: 1 });
  });

  it("un outil ordinaire (write_file) garde les deux", async () => {
    const { broker } = make();
    void broker.request("o1", "r", "s1", { name: "write_file" }, D);
    expect(broker.list()[0]).toMatchObject({ canAlways: true, canSession: true });
    broker.cancel("o1");
  });
});
