// Cockpit, lot 3 : les skills de mattpocock/skills embarquées (sélection, commit épinglé, MIT) s'installent SANS réseau par le hub —
// même analyse de sécurité, même verrou (provenance), chargement à la demande — et seulement quand on le demande.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_PACKS } from "../src/bundled/index.js";
import { parseHubIdentifier, SkillsHubService } from "../src/skills-hub.js";
import { SkillRegistry } from "../src/skills.js";

const store: Record<string, unknown> = {};
const settings = { get: (k: string) => store[k] ?? [], set: (k: string, v: unknown) => void (store[k] = v), onChange: () => () => {} } as never;
const notifications = { push: () => {}, add: () => {} } as never;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig() {
  const root = mkdtempSync(join(tmpdir(), "jarod-bundled-"));
  dirs.push(root);
  const skills = new SkillRegistry(join(root, "skills"), settings, notifications);
  await skills.reload().catch(() => {});
  const noNet = (async () => {
    throw new Error("aucun réseau dans ce test");
  }) as unknown as typeof fetch;
  return { skills, hub: new SkillsHubService({ skills, fetch: noNet } as never) };
}

describe("skills embarquées", () => {
  it("la sélection couvre diagnostic, tests, revue, conception, spécification, passation ; épinglée et sous licence MIT", () => {
    const p = BUNDLED_PACKS.mattpocock!;
    expect(Object.keys(p.skills).sort()).toEqual(["code-review", "codebase-design", "diagnosing-bugs", "handoff", "tdd", "to-spec"]);
    expect(p.commit).toBe("5beb35b040e3de97e54fa9e386d7e42d15c295c2");
    expect(p.license).toBe("MIT");
    expect(p.licenseText).toMatch(/Copyright \(c\) 2026 Matt Pocock/);
    for (const [id, s] of Object.entries(p.skills)) {
      const md = s.files["SKILL.md"]!;
      expect(md, id).toMatch(/version: 0\.0\.0\+5beb35b/);
      expect(md, id).toMatch(/Note d'adaptation Jarod-OS/);
      expect(Object.keys(s.files).every((f) => f.endsWith(".md")), id).toBe(true);
    }
    // Aucune publication externe sans accord : la note de to-spec le dit.
    expect(p.skills["to-spec"]!.files["SKILL.md"]).toMatch(/Rien n'est publié dans un gestionnaire de tickets/);
  });

  it("identifiant bundled:<lot>/<skill>", () => {
    expect(parseHubIdentifier("bundled:mattpocock/tdd")).toEqual({ kind: "bundled", pack: "mattpocock", skill: "tdd" });
  });

  it("listées non installées ; installées sans réseau, avec la provenance au verrou ; chargées à la demande", async () => {
    const { skills, hub } = await rig();
    expect((await hub.bundled()).every((b) => !b.installed)).toBe(true);
    const r = await hub.install("bundled:mattpocock/tdd");
    expect(r.id).toBe("tdd");
    expect(r.scan.verdict).not.toBe("dangerous");
    const lock = await hub.lock();
    expect(lock.tdd).toMatchObject({ source: "bundled", repo: "mattpocock/skills", commit: "5beb35b040e3de97e54fa9e386d7e42d15c295c2", path: "skills/engineering/tdd" });
    expect(Object.keys(lock.tdd!.files).sort()).toEqual(["LICENSE", "SKILL.md", "mocking.md", "tests.md"]);
    expect(skills.get("tdd")?.version).toBe("0.0.0+5beb35b");
    expect((await hub.bundled()).find((b) => b.id === "tdd")?.installed).toBe(true);
  });

  it("aucune skill embarquée n'est jugée dangereuse par l'analyse", async () => {
    const { hub } = await rig();
    for (const b of await hub.bundled()) expect((await hub.inspect(b.identifier)).scan.verdict, b.id).not.toBe("dangerous");
  });
});
