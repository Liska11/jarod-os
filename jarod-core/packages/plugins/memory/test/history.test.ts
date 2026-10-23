// V-18 : historique de la mémoire — écrit par les déclencheurs SQL quel que soit l'écrivain, rétablissement de chaque sorte de changement,
// refus propres, plafond, effacement. Sur un VRAI kernel (storage + memory, base migrée).
import { describe, expect, it } from "vitest";
import { makeCore } from "./helpers.js";

describe("historique de la mémoire (V-18)", () => {
  it("ajout, modification (texte et type), retrait : chaque geste laisse sa ligne, du plus récent au plus ancien", async () => {
    const { memory } = await makeCore();
    const m = memory.add("Le dépôt est sur C:", "fact");
    memory.update(m.id, "Le dépôt est sur D:");
    memory.update(m.id, "Le dépôt est sur D:", "preference");
    // Une écriture qui ne change rien ne pollue pas l'historique.
    memory.update(m.id, "Le dépôt est sur D:", "preference");
    memory.delete(m.id);
    const h = memory.history();
    expect(h.map((c) => c.action)).toEqual(["delete", "update", "update", "add"]);
    expect(h[3]).toMatchObject({ memoryId: m.id, after: { type: "fact", content: "Le dépôt est sur C:" } });
    expect(h[3]!.before).toBeUndefined();
    expect(h[2]).toMatchObject({ before: { content: "Le dépôt est sur C:" }, after: { content: "Le dépôt est sur D:" } });
    expect(h[1]).toMatchObject({ before: { type: "fact" }, after: { type: "preference" } });
    expect(h[0]).toMatchObject({ before: { type: "preference", content: "Le dépôt est sur D:" } });
    expect(h[0]!.after).toBeUndefined();
    expect(memory.history({ memoryId: "autre" })).toEqual([]);
    expect(memory.history({ limit: 2 })).toHaveLength(2);
  });

  it("un écrivain qui passe par SQL directement est aussi tracé (déclencheurs, pas le code)", async () => {
    const { memory, db } = await makeCore();
    db.run("INSERT INTO memories (id, type, content, created_at, updated_at) VALUES ('brut', 'fact', 'écrit en SQL', 1, 1)");
    expect(memory.history()[0]).toMatchObject({ memoryId: "brut", action: "add" });
  });

  it("rétablir : un retrait revient avec son identifiant, une modification revient en arrière, un ajout est retiré", async () => {
    const { memory } = await makeCore();
    const m = memory.add("Préfère le français", "preference");
    memory.update(m.id, "Préfère l'anglais");
    const changed = memory.history()[0]!;
    expect(memory.restore(changed.seq)).toEqual({ memoryId: m.id, did: "reverted" });
    expect(memory.get(m.id)).toMatchObject({ content: "Préfère le français", type: "preference" });

    memory.delete(m.id);
    expect(memory.restore(memory.history()[0]!.seq)).toEqual({ memoryId: m.id, did: "recreated" });
    expect(memory.get(m.id)).toMatchObject({ content: "Préfère le français", type: "preference" });

    const added = memory.add("Un ajout de trop");
    const addRow = memory.history({ memoryId: added.id }).find((c) => c.action === "add")!;
    expect(memory.restore(addRow.seq)).toEqual({ memoryId: added.id, did: "removed" });
    expect(memory.get(added.id)).toBeUndefined();
    // Le geste se trace lui-même : on peut défaire un rétablissement.
    expect(memory.history()[0]).toMatchObject({ memoryId: added.id, action: "delete" });
  });

  it("refus sans rien écrire : changement inconnu, souvenir déjà retiré, déjà présent, doublon de texte", async () => {
    const { memory } = await makeCore();
    expect(() => memory.restore(999_999)).toThrow(/inconnu/);
    expect(() => memory.restore(Number.NaN)).toThrow(/inconnu/);
    const m = memory.add("A");
    const addSeq = memory.history()[0]!.seq;
    memory.delete(m.id);
    expect(() => memory.restore(addSeq)).toThrow(/n'existe plus/);
    const delSeq = memory.history()[0]!.seq;
    memory.restore(delSeq);
    expect(() => memory.restore(delSeq)).toThrow(/déjà présent/);
    // Le texte d'avant existe déjà sous un autre souvenir : pas de doublon.
    memory.update(m.id, "B");
    const upd = memory.history()[0]!.seq;
    memory.add("A");
    const count = memory.list().length;
    expect(() => memory.restore(upd)).toThrow(/identique/);
    expect(memory.list()).toHaveLength(count);
    expect(memory.get(m.id)!.content).toBe("B");
  });

  it("effacement : d'un souvenir, ou de tout ; et le plafond garde les 2 000 dernières lignes", async () => {
    const { memory, db } = await makeCore();
    const a = memory.add("A");
    memory.add("B");
    memory.update(a.id, "A2");
    expect(memory.purgeHistory(a.id)).toBe(2);
    expect(memory.history().map((c) => c.action)).toEqual(["add"]);
    expect(memory.purgeHistory()).toBe(1);
    expect(memory.history()).toEqual([]);

    db.tx(() => {
      for (let i = 0; i < 2050; i++) db.run("INSERT INTO memories (id, type, content, created_at, updated_at) VALUES (?, 'fact', ?, 1, 1)", `x${i}`, `x${i}`);
    });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_history")!.n).toBe(2000);
    expect(memory.history({ limit: 1 })[0]!.memoryId).toBe("x2049");
  });
});
