// 2026-10-22 — les arguments d'un outil sont masqués PAR STRUCTURE avant d'être journalisés : un secret court, un secret long, une forme connue,
// une option de ligne de commande. Faux secrets sentinelles uniquement.
import { describe, expect, it } from "vitest";
import { auditArgs, redactCommandText, redactValue } from "../src/redact.js";

describe("redactValue — champs nommés comme des secrets", () => {
  it("masque en entier, court ou long, à toute profondeur", () => {
    const out = redactValue({ user: "ana", password: "abc", nested: { apiKey: "x".repeat(80), headers: [{ Authorization: "Basic YQ==" }] }, token: { a: 1 } }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("abc");
    expect(JSON.stringify(out)).not.toContain("xxxxxxxx");
    expect(JSON.stringify(out)).not.toContain("YQ==");
    expect((out as { user: string }).user).toBe("ana");
    expect((out.nested as { apiKey: string }).apiKey).toBe("[masqué]");
    expect(out.token).toBe("[masqué]");
  });

  it("garde un compte de jetons (nombre sous un nom en …tokens) et ne modifie pas l'original", () => {
    const original = { max_tokens: 4096, secret: "court" };
    const out = redactValue(original) as Record<string, unknown>;
    expect(out.max_tokens).toBe(4096);
    expect(out.secret).toBe("[masqué]");
    expect(original.secret).toBe("court");
  });

  it("masque les formes connues dans une chaîne libre, et les options de ligne de commande, courtes ou non", () => {
    const text = redactCommandText("curl -H 'Authorization: Bearer SENTINELLEjeton-longue-0000' https://x --password abc --api-key=zz tool -token t1");
    expect(text).not.toContain("SENTINELLEjeton");
    expect(text).not.toContain(" abc");
    expect(text).not.toContain("zz");
    expect(text).not.toContain(" t1");
    expect(text).toContain("https://x");
  });

  it("une profondeur excessive est coupée, pas parcourue sans fin", () => {
    let v: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 20; i++) v = { child: v };
    expect(JSON.stringify(redactValue(v))).toContain("trop profond");
  });
});

describe("auditArgs", () => {
  it("masque avant de tronquer : un secret au-delà de la limite ne peut pas rester en clair en bout de ligne", () => {
    const s = auditArgs({ note: "a".repeat(480), password: "SENTINELLE-court" }, 500);
    expect(s).not.toContain("SENTINELLE");
    expect(s.length).toBeLessThanOrEqual(501);
  });

  it("des arguments circulaires ne font pas échouer le journal", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => auditArgs(a)).not.toThrow();
  });
});
