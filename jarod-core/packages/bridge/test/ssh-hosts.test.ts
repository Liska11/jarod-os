/**
 * SPECS-P5-UI-PARITE.md §3.3 — hôtes SSH déclarés depuis l'écran. Invariants : la clé se CHOISIT dans la boîte native (un chemin tapé est refusé),
 * aucun mot de passe ni option ne passe, déclarer ne connecte rien, le test n'est que la commande fixe du service. VRAI kernel, VRAI service.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

function keyFile(name = "id_ed25519"): string {
  const p = join(tempDir(), name);
  writeFileSync(p, "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-DE-LA-CLE\n-----END OPENSSH PRIVATE KEY-----\n");
  return p;
}

async function wired(picks: (string | null)[] = []) {
  const k = await setupKernel(undefined, [], { pickFile: async () => picks.shift() ?? null });
  return k;
}

describe("hôtes SSH", () => {
  it("la clé se choisit dans la boîte native : le chemin tapé est refusé, le chemin choisi accepté ; le contenu de la clé n'est jamais lu", async () => {
    const key = keyFile();
    const { call } = await wired([key]);
    const input = { name: "serveur de prod", host: "prod.example.org", username: "ops", port: 2222, keyPath: key };
    await rejects(() => call("ssh-host-add", input), /clé non choisie dans la boîte/);
    expect(await call("ssh-pick-key")).toBe(key);
    const list = (await call("ssh-host-add", input)) as { id: string; name: string; host: string; username: string; port: number; keyPath: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "serveur de prod", host: "prod.example.org", username: "ops", port: 2222, keyPath: key });
    expect(JSON.stringify(list)).not.toContain("SECRET-DE-LA-CLE");
    expect(await call("ssh-hosts-list")).toEqual(list);
  });

  it("boîte annulée : null, rien n'est retenu ; sans boîte native : refus", async () => {
    const { call } = await wired([null]);
    expect(await call("ssh-pick-key")).toBeNull();
    await rejects(() => call("ssh-host-add", { name: "x", host: "h.example.org", username: "u", keyPath: keyFile() }), /clé non choisie/);
    const none = await setupKernel();
    await rejects(() => none.call("ssh-pick-key"), /indisponible/);
  });

  it("jamais de mot de passe, de phrase de passe ni d'option : champs inconnus refusés ; types invalides ; règles du service (nom, utilisateur, port, adresse)", async () => {
    const key = keyFile();
    const { call, app } = await wired([key]);
    await call("ssh-pick-key");
    const ok = { name: "n", host: "h.example.org", username: "u", keyPath: key };
    await rejects(() => call("ssh-host-add", { ...ok, password: "x" }), /jamais de mot de passe ni d'option/);
    await rejects(() => call("ssh-host-add", { ...ok, passphrase: "x" }), /non accepté/);
    await rejects(() => call("ssh-host-add", { ...ok, options: "-oStrictHostKeyChecking=no" }), /non accepté/);
    await rejects(() => call("ssh-host-add", { ...ok, name: 5 }), /texte attendu/);
    await rejects(() => call("ssh-host-add", { ...ok, name: "  " }), /Nom manquant/);
    await rejects(() => call("ssh-host-add", { ...ok, username: "" }), /Utilisateur manquant/);
    await rejects(() => call("ssh-host-add", { ...ok, port: 70000 }), /Port invalide/);
    await rejects(() => call("ssh-host-add", { ...ok, port: {} }), /nombre attendu/);
    await rejects(() => call("ssh-host-add", { ...ok, host: "-oProxyCommand=calc" }), /./);
    await rejects(() => call("ssh-host-add", null), /déclaration attendue/);
    expect(app.agent.settings.get("sshHosts" as never) ?? []).toEqual([]);
  });

  it("nom déjà pris : refus ; retirer : l'entrée disparaît (rien n'est supprimé du disque) ; identifiant inconnu : refus", async () => {
    const key = keyFile();
    const { call } = await wired([key]);
    await call("ssh-pick-key");
    const ok = { name: "Prod", host: "h.example.org", username: "u", keyPath: key };
    const list = (await call("ssh-host-add", ok)) as { id: string }[];
    await rejects(() => call("ssh-host-add", { ...ok, name: "prod" }), /Nom déjà pris/);
    expect(await call("ssh-host-remove", list[0]!.id)).toEqual([]);
    await rejects(() => call("ssh-host-remove", "inconnu"), /./);
    await rejects(() => call("ssh-host-remove", 3), /identifiant attendu/);
  });

  it("test : rend le verdict et au plus 500 caractères de sortie ; jamais une commande saisie (le canal n'en prend pas) ; hôte inconnu refusé", async () => {
    const key = keyFile();
    const { call, app } = await wired([key]);
    await call("ssh-pick-key");
    const list = (await call("ssh-host-add", { name: "n", host: "h.example.org", username: "u", keyPath: key })) as { id: string }[];
    const svc = (app as unknown as { tools: { sshHosts: { test(id: string): Promise<unknown> } } }).tools.sshHosts;
    const asked: string[] = [];
    svc.test = async (id: string) => (asked.push(id), { ok: true, stdout: "u\nh\nLinux x86_64\n" + "x".repeat(900), message: "", timedOut: false, durationMs: 42, hostName: "n" });
    const r = (await call("ssh-host-test", list[0]!.id, "rm -rf /")) as { ok: boolean; output: string; durationMs: number };
    expect(asked).toEqual([list[0]!.id]);
    expect(r.ok).toBe(true);
    expect(r.output.length).toBe(500);
    expect(r.output.startsWith("u\nh\nLinux")).toBe(true);
    svc.test = async () => ({ ok: false, stdout: "", message: "Host key verification failed. " + "y".repeat(900), timedOut: false, durationMs: 5, hostName: "n" });
    const bad = (await call("ssh-host-test", list[0]!.id)) as { ok: boolean; message: string };
    expect(bad.ok).toBe(false);
    expect(bad.message.length).toBe(500);
    await rejects(() => call("ssh-host-test", 3), /identifiant attendu/);
  });

  it("agent commands per machine: off by default; on only after a native confirmation naming the machine; off at once", async () => {
    const key = keyFile();
    const asked: string[] = [];
    const answers = [false, true];
    const k = await setupKernel(undefined, [], { pickFile: async () => key, confirm: async (message, detail) => (asked.push(`${message}
${detail}`), answers.shift() ?? false) });
    await k.call("ssh-pick-key");
    const list = (await k.call("ssh-host-add", { name: "pc2", host: "100.64.0.2", username: "ops", keyPath: key })) as { id: string; agentExec: boolean }[];
    expect(list[0]!.agentExec).toBe(false);
    expect(k.app.agent.settings.get("sshExecHosts" as never)).toBeUndefined();

    await rejects(() => k.call("ssh-host-exec-set", list[0]!.id, true), /refusé par l'utilisateur/);
    expect(((await k.call("ssh-hosts-list")) as { agentExec: boolean }[])[0]!.agentExec).toBe(false);

    const on = (await k.call("ssh-host-exec-set", list[0]!.id, true)) as { agentExec: boolean }[];
    expect(on[0]!.agentExec).toBe(true);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("pc2");
    expect(asked[1]).toContain("ops@100.64.0.2:22");

    const off = (await k.call("ssh-host-exec-set", list[0]!.id, false)) as { agentExec: boolean }[];
    expect(off[0]!.agentExec).toBe(false);
    expect(asked).toHaveLength(2);

    await rejects(() => k.call("ssh-host-exec-set", "inconnu", true), /non déclaré/);
    await rejects(() => k.call("ssh-host-exec-set", list[0]!.id, "yes"), /attendu/);
    const none = await setupKernel(undefined, [], { pickFile: async () => key, noConfirm: true });
    await none.call("ssh-pick-key");
    const l2 = (await none.call("ssh-host-add", { name: "pc3", host: "100.64.0.3", username: "ops", keyPath: key })) as { id: string }[];
    await rejects(() => none.call("ssh-host-exec-set", l2[0]!.id, true), /confirmation native indisponible/);
  });
});
