import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefenderScanner, QuarantineError, type QuarantineEvent, QuarantineService, type Scanner } from "../src/index.js";

const made: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-q-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clean: Scanner = { scan: () => ({ verdict: "clean", scanner: "stub" }) };
const dirty: Scanner = { scan: () => ({ verdict: "infected", scanner: "stub" }) };
const absent: Scanner = { scan: () => ({ verdict: "unavailable", scanner: "stub", detail: "absent" }) };

function setup(scanner: Scanner, approve: boolean | null = true) {
  const events: QuarantineEvent[] = [];
  const src = temp();
  const file = join(src, "rapport.pdf");
  writeFileSync(file, "contenu");
  const svc = new QuarantineService({
    root: temp(),
    scanner,
    approve: approve === null ? null : async () => approve,
    onEvent: (e) => events.push(e),
  });
  return { svc, file, events, src };
}

describe("plugin-quarantine", () => {
  it("l'entrée empreinte, trace la provenance et laisse la source en place", () => {
    const { svc, file } = setup(clean);
    const r = svc.intake(file, { source: "download", url: "https://exemple.test/a.pdf" });

    expect(r.id).toMatch(/^[0-9a-f]{64}$/);
    expect(r).toMatchObject({ status: "quarantined", size: 7, label: "rapport.pdf", provenance: { source: "download" } });
    expect(existsSync(file)).toBe(true);
    // Le même contenu n'entre qu'une fois.
    expect(svc.intake(file, { source: "autre" }).id).toBe(r.id);
    expect(svc.list()).toHaveLength(1);
  });

  it("un lien n'est jamais suivi à l'entrée", () => {
    const { svc, file, src } = setup(clean);
    const lien = join(src, "lien.pdf");
    try {
      symlinkSync(file, lien, "file");
    } catch {
      return;
    }
    expect(() => svc.intake(lien, { source: "x" })).toThrow(QuarantineError);
  });

  it("un fichier propre, analysé, approuvé sort — et la copie a la même empreinte", async () => {
    const { svc, file } = setup(clean);
    const r = svc.intake(file, { source: "download" });
    expect(svc.scan(r.id).status).toBe("clean");

    const dest = temp();
    const out = await svc.promote(r.id, dest);
    expect(readFileSync(out, "utf8")).toBe("contenu");
    expect(svc.get(r.id).status).toBe("promoted");
  });

  it("sans analyseur disponible, le fichier reste « unscanned » et ne sort jamais", async () => {
    const { svc, file } = setup(absent);
    const r = svc.intake(file, { source: "download" });
    expect(svc.scan(r.id).status).toBe("unscanned");
    await expect(svc.promote(r.id, temp())).rejects.toThrow(/unscanned/);
  });

  it("un fichier infecté ne sort pas, même avec un accord", async () => {
    const { svc, file } = setup(dirty);
    const r = svc.intake(file, { source: "download" });
    expect(svc.scan(r.id).status).toBe("infected");
    await expect(svc.promote(r.id, temp())).rejects.toThrow(/infected/);
  });

  it("sans accord, ou sans canal d'accord, rien ne sort et rien n'est écrit", async () => {
    for (const approve of [false, null] as const) {
      const { svc, file } = setup(clean, approve);
      const r = svc.intake(file, { source: "download" });
      svc.scan(r.id);
      const dest = temp();
      await expect(svc.promote(r.id, dest)).rejects.toThrow(QuarantineError);
      expect(existsSync(join(dest, "rapport.pdf"))).toBe(false);
      expect(svc.get(r.id).status).toBe("clean");
    }
  });

  it("un contenu modifié en quarantaine est détecté : « tampered », et il ne sort pas", async () => {
    const { svc, file } = setup(clean);
    const r = svc.intake(file, { source: "download" });
    svc.scan(r.id);
    const blob = join(svc["d"].root, `${r.id}.blob`);
    writeFileSync(blob, "autre chose");

    await expect(svc.promote(r.id, temp())).rejects.toThrow(/empreinte/);
    expect(svc.get(r.id).status).toBe("tampered");
  });

  it("n'écrase jamais, et refuse une destination qui est un lien", async () => {
    const { svc, file } = setup(clean);
    const r = svc.intake(file, { source: "download" });
    svc.scan(r.id);

    const dest = temp();
    writeFileSync(join(dest, "rapport.pdf"), "existant");
    await expect(svc.promote(r.id, dest)).rejects.toThrow(/existe déjà/);
    expect(readFileSync(join(dest, "rapport.pdf"), "utf8")).toBe("existant");

    const vrai = temp();
    const lien = join(temp(), "lien");
    try {
      symlinkSync(vrai, lien, "junction");
    } catch {
      return;
    }
    await expect(svc.promote(r.id, lien)).rejects.toThrow(/dossier ordinaire/);
  });

  it("un nom donné ne peut pas sortir du dossier de destination", async () => {
    const { svc, file } = setup(clean);
    const r = svc.intake(file, { source: "download" });
    svc.scan(r.id);
    const dest = temp();
    const out = await svc.promote(r.id, dest, "..\\..\\evil.pdf");
    expect(out.startsWith(join(dest).replace(/\\/g, "/")) || out.toLowerCase().includes("jarod-q-")).toBe(true);
    expect(existsSync(join(dest, "evil.pdf"))).toBe(true);
  });

  it("un nom réduit à « .. » ne désigne jamais le dossier parent", async () => {
    const { svc, file } = setup(clean);
    const r = svc.intake(file, { source: "download" });
    svc.scan(r.id);
    const dest = temp();
    const out = await svc.promote(r.id, dest, "a/..");
    expect(existsSync(join(dest, "fichier"))).toBe(true);
    expect(out.replace(/\\/g, "/")).toContain("/fichier");
  });

  it("l'audit ne contient que empreintes, tailles et statuts", async () => {
    const { svc, file, events } = setup(clean);
    const r = svc.intake(file, { source: "download", url: "https://exemple.test/x" });
    svc.scan(r.id);
    await svc.promote(r.id, temp());
    const text = JSON.stringify(events);
    expect(text).not.toContain("exemple.test");
    expect(text).not.toContain("rapport.pdf");
    expect(events.map((e) => e.action)).toEqual(["intake", "scan", "promote"]);
  });

  it("la suppression détruit le contenu et garde la trace", () => {
    const { svc, file } = setup(clean);
    const r = svc.intake(file, { source: "download" });
    svc.delete(r.id);
    expect(existsSync(join(svc["d"].root, `${r.id}.blob`))).toBe(false);
    expect(svc.get(r.id).status).toBe("deleted");
  });

  it("l'analyseur Defender dit « indisponible » plutôt que « propre » quand il n'est pas là", () => {
    const sans = new DefenderScanner({});
    expect(sans.scan(join(temp(), "x")).verdict).toBe("unavailable");
  });
});
