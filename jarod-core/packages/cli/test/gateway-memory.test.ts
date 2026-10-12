// Passerelle compatible Hermes (essai) : la page Mémoire de Herald (MEMORY.md / USER.md) bâtie sur la vraie mémoire et le vrai profil de Jarod.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import { checkTexts, diffEntries, parseProfile } from "../src/gateway/memory.js";
import { createGateway } from "../src/gateway/server.js";

const items = (...texts: string[]) => texts.map((text, i) => ({ id: `id${i}`, text }));

describe("diffEntries (changements minimaux)", () => {
  it("rien ne change : aucun changement", () => {
    expect(diffEntries(items("a", "b"), ["a", "b"])).toEqual({ updates: [], deletes: [], adds: [] });
  });
  it("une entrée modifiée est une MISE À JOUR (même identifiant), pas une suppression suivie d'un ajout", () => {
    expect(diffEntries(items("a", "b", "c"), ["a", "B", "c"])).toEqual({ updates: [{ id: "id1", text: "B" }], deletes: [], adds: [] });
  });
  it("suppression au milieu : seule celle-là part, les autres gardent leur identifiant", () => {
    expect(diffEntries(items("a", "b", "c"), ["a", "c"])).toEqual({ updates: [], deletes: ["id1"], adds: [] });
  });
  it("ajout, texte vide ignoré, espaces rognés", () => {
    expect(diffEntries(items("a"), ["a", "  ", " nouveau  "])).toEqual({ updates: [], deletes: [], adds: ["nouveau"] });
  });
  it("des doublons sont appariés un à un", () => {
    expect(diffEntries(items("x", "x"), ["x"])).toEqual({ updates: [], deletes: ["id1"], adds: [] });
  });
  it("tout remplacer : appariement dans l'ordre, puis l'excédent", () => {
    expect(diffEntries(items("a", "b"), ["1", "2", "3"])).toEqual({ updates: [{ id: "id0", text: "1" }, { id: "id1", text: "2" }], deletes: [], adds: ["3"] });
  });
});

describe("profil et corps", () => {
  it("parseProfile lit le format du service (titre ignoré, sections, puces)", () => {
    const m = parseProfile("# Profil de l'utilisateur\n\n## Identité\n- Marc\n- 40 ans\n\n## Préférences\n- réponses courtes\n");
    expect([...m]).toEqual([["Identité", ["Marc", "40 ans"]], ["Préférences", ["réponses courtes"]]]);
    expect(parseProfile("").size).toBe(0);
  });
  it("checkTexts refuse ce qui n'est pas une liste de textes, ou trop gros", () => {
    expect(checkTexts({ texts: ["a"] })).toEqual(["a"]);
    for (const bad of [null, {}, { texts: "a" }, { texts: [1] }, { texts: Array.from({ length: 501 }, () => "x") }, { texts: ["x".repeat(8001)] }]) expect(() => checkTexts(bad)).toThrow();
  });
});

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig() {
  const root = mkdtempSync(join(tmpdir(), "jarod-gw-mem-"));
  dirs.push(root);
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core } = await openCore({ env: { JAROD_HOME: root } });
  const gw = createGateway({ core, version: "test" });
  const port = await gw.listen(0);
  closers.push(async () => {
    await gw.close();
    await core.dispose();
  });
  const call = async (method: string, path: string, body?: unknown, token: string | null = gw.token) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...(token ? { "x-hermes-session-token": token } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { core, gw, call };
}

describe("routes /api/memory/files devant le vrai noyau", { timeout: 60_000 }, () => {
  it("lit les deux fichiers : souvenirs dans l'ordre de création avec leurs dates, lignes du profil", async () => {
    const { core, call } = await rig();
    const empty = await call("GET", "/api/memory/files");
    expect(empty.body.files["MEMORY.md"]).toMatchObject({ exists: false, texts: [] });
    expect(empty.body.files["USER.md"]).toMatchObject({ exists: false, texts: [], modified_at: 0 });

    const first = core.memory.add("Je préfère les réponses courtes");
    await new Promise((r) => setTimeout(r, 5));
    core.memory.add("Mon dossier de travail est D:\\JAROD-OS");
    core.userProfile.add("Identité", "Marc");
    core.userProfile.add("Projets en cours", "Jarod-OS");

    const r = await call("GET", "/api/memory/files");
    expect(r.status).toBe(200);
    expect(r.body.files["MEMORY.md"].texts).toEqual(["Je préfère les réponses courtes", "Mon dossier de travail est D:\\JAROD-OS"]);
    expect(r.body.files["MEMORY.md"].dates[0]).toBe(first.createdAt);
    expect(r.body.files["MEMORY.md"].exists).toBe(true);
    expect(r.body.files["USER.md"]).toMatchObject({ exists: true, texts: ["Marc", "Jarod-OS"] });
    expect(r.body.files["USER.md"].modified_at).toBeGreaterThan(0);
  });

  it("MEMORY.md : modifier garde l'identifiant et la date et ne déplace pas l'entrée ; supprimer et ajouter fonctionnent", async () => {
    const { core, call } = await rig();
    const a = core.memory.add("alpha");
    await new Promise((r) => setTimeout(r, 5));
    core.memory.add("beta");
    await new Promise((r) => setTimeout(r, 5));
    core.memory.add("gamma");

    let r = await call("PUT", "/api/memory/files/MEMORY.md", { texts: ["ALPHA modifié", "beta", "gamma"] });
    expect(r.status).toBe(200);
    expect(r.body.files["MEMORY.md"].texts).toEqual(["ALPHA modifié", "beta", "gamma"]); // même place
    expect(core.memory.get(a.id)).toMatchObject({ content: "ALPHA modifié", createdAt: a.createdAt });
    expect(core.memory.list()).toHaveLength(3);

    // La page fait une opération à la fois : supprimer « beta », puis ajouter « delta ».
    r = await call("PUT", "/api/memory/files/MEMORY.md", { texts: ["ALPHA modifié", "gamma"] });
    expect(r.body.files["MEMORY.md"].texts).toEqual(["ALPHA modifié", "gamma"]);
    expect(core.memory.list()).toHaveLength(2);
    await new Promise((res) => setTimeout(res, 5));
    r = await call("PUT", "/api/memory/files/MEMORY.md", { texts: ["ALPHA modifié", "gamma", "delta"] });
    expect(r.body.files["MEMORY.md"].texts).toEqual(["ALPHA modifié", "gamma", "delta"]);
    expect(core.memory.list().map((m) => m.content).sort()).toEqual(["ALPHA modifié", "delta", "gamma"]);

    r = await call("PUT", "/api/memory/files/MEMORY.md", { texts: [] });
    expect(r.body.files["MEMORY.md"]).toMatchObject({ exists: false, texts: [] });
    expect(core.memory.list()).toHaveLength(0);
  });

  it("USER.md : une ligne modifiée reste dans sa section, un ajout va dans Préférences, une suppression retire la ligne", async () => {
    const { core, call } = await rig();
    core.userProfile.add("Identité", "Marc");
    core.userProfile.add("Identité", "40 ans");
    core.userProfile.add("Projets en cours", "Jarod-OS");

    let r = await call("PUT", "/api/memory/files/USER.md", { texts: ["Marc", "41 ans", "Jarod-OS", "aime le café"] });
    expect(r.status).toBe(200);
    expect(r.body.files["USER.md"].texts).toEqual(["Marc", "41 ans", "Jarod-OS", "aime le café"]);
    const sections = [...parseProfile(core.userProfile.read())];
    expect(sections).toEqual([["Identité", ["Marc", "41 ans"]], ["Projets en cours", ["Jarod-OS"]], ["Préférences", ["aime le café"]]]);

    r = await call("PUT", "/api/memory/files/USER.md", { texts: ["Marc", "41 ans", "aime le café"] });
    expect([...parseProfile(core.userProfile.read())]).toEqual([["Identité", ["Marc", "41 ans"]], ["Préférences", ["aime le café"]]]);
    expect(r.body.files["USER.md"].texts).toEqual(["Marc", "41 ans", "aime le café"]);
  });

  it("refuse proprement : corps invalide, profil trop long, fichier inconnu, sans jeton", async () => {
    const { core, call, gw } = await rig();
    expect((await call("PUT", "/api/memory/files/MEMORY.md", { texts: "x" })).status).toBe(400);
    expect((await call("PUT", "/api/memory/files/MEMORY.md", {})).body.detail).toMatch(/liste de textes/);
    const long = await call("PUT", "/api/memory/files/USER.md", { texts: Array.from({ length: 6 }, (_, i) => `${i}${"x".repeat(790)}`) });
    expect(long.status).toBe(400);
    expect(long.body.detail).toMatch(/trop long/);
    expect(core.userProfile.read()).toBe(""); // rien n'a été écrit
    expect((await call("PUT", "/api/memory/files/SOUL.md", { texts: [] })).status).toBe(404);
    expect((await call("GET", "/api/memory/files", undefined, null)).status).toBe(401);
    expect(gw.unhandled()).toMatchObject({ "PUT /api/memory/files/SOUL.md": 1 });
  });
});
