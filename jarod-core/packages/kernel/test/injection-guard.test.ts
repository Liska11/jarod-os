/**
 * Garde anti-injection : politique et mesure (portée depuis la reconstruction, Phases 1-4).
 *
 * Ce que ces cas tiennent : la mesure décide du mode ; la lecture n'est jamais bloquée ; une action
 * bloquante est refusée sur arguments structurels ou sur contenu non fiable lu pendant le tour ;
 * les contenus légitimes du corpus ne déclenchent aucun blocage.
 */
import { describe, expect, it } from "vitest";
import { actionVerdict, BENIGN, guardMode, MALICIOUS, outputVerdict, selftest, taintOf } from "../src/injection-guard.js";

describe("mesure du corpus", () => {
  it("n'entre en blocage que si la mesure le justifie, et publie les deux taux", () => {
    const r = selftest();
    expect(r.benign).toBe(20);
    expect(r.malicious).toBe(8);
    expect(r.falsePositiveRate).toBe(0);
    expect(r.blockRate).toBeGreaterThanOrEqual(0.85);
    expect(r.mode).toBe("enforce");
    expect(guardMode()).toBe("enforce");
    // Le détecteur brut signale un contenu légitime (balise <important> citée) : il marque, il ne bloque pas.
    expect(r.rawFalsePositiveRate).toBeGreaterThan(0);
    // Un piège échappe au détecteur (préfixe SYSTEM: seul, poids 1 sous le seuil) : dit, pas masqué.
    expect(r.missed).toContain("fake-authority");
  });

  it("aucun contenu légitime ne teinte ni ne bloque une action", () => {
    for (const text of BENIGN) {
      expect(taintOf(text, "read_file")).toBeNull();
      expect(actionVerdict({ tier: "mutate", tool: "write_file", args: { content: text } }).block).toBe(false);
    }
  });
});

describe("politique", () => {
  it("le palier read n'est jamais bloqué, même sur un contenu piégé : marqueur seulement", () => {
    const piege = MALICIOUS[0]!.text;
    const out = outputVerdict({ tier: "read", tool: "read_file", text: piege });
    expect(out.block).toBe(false);
    // Contrat V-04 : la sortie d'une lecture passe inchangée ; le signal est dans l'audit et la teinture.
    expect(out.marker).toBe("");
    expect(out.taint?.motif).toContain("override-instructions");
    expect(actionVerdict({ tier: "read", tool: "read_file", args: { path: "x" }, taint: out.taint }).block).toBe(false);
  });

  it("une action bloquante est refusée quand le tour est teinté", () => {
    const taint = taintOf(MALICIOUS[0]!.text, "read_file");
    const verdict = actionVerdict({ tier: "mutate", tool: "write_file", args: { path: "ok.txt", content: "ok" }, taint });
    expect(verdict.block).toBe(true);
    expect(verdict.source).toBe("teinture");
    expect(verdict.reason).toMatch(/lu pendant ce tour/);
    expect(verdict.motif).toContain("override-instructions");
  });

  it("des arguments qui imitent un appel d'outil bloquent sans teinture", () => {
    const verdict = actionVerdict({ tier: "mutate", tool: "run_shell", args: { command: MALICIOUS[4]!.text } });
    expect(verdict.block).toBe(true);
    expect(verdict.source).toBe("arguments");
    expect(verdict.motif).toContain("tool-call-impersonation");
  });

  it("la sortie d'une action bloquante est retenue, celle d'une lecture passe inchangée (V-04)", () => {
    const instruction = MALICIOUS[0]!.text; // « ignore les instructions… » : instruction explicite
    const hidden = MALICIOUS[5]!.text; // texte invisible seul : tentative, mais pas une instruction
    expect(outputVerdict({ tier: "mutate", tool: "write_file", text: instruction }).block).toBe(true);
    const read = outputVerdict({ tier: "read", tool: "read_file", text: instruction });
    expect(read.block).toBe(false);
    // Contrat V-04 : la sortie d'une lecture passe inchangée ; le signal est dans l'audit et la teinture.
    expect(read.marker).toBe("");
    expect(read.taint?.motif).toContain("override-instructions");
    // Une balise cachée seule reste critique pour une ACTION, sans teinter le tour (ce n'est pas un ordre).
    expect(outputVerdict({ tier: "mutate", tool: "write_file", text: hidden }).block).toBe(true);
    expect(taintOf(hidden, "read_file")).toBeNull();
  });

  it("une action réseau est bloquante quel que soit son palier", () => {
    const taint = taintOf(MALICIOUS[0]!.text, "read_file");
    expect(actionVerdict({ tier: "act", tool: "web_fetch", args: { url: "http://x" }, taint }).block).toBe(true);
    expect(actionVerdict({ tier: "act", tool: "fetch_url", args: { url: "http://x" }, taint }).block).toBe(true);
  });
});