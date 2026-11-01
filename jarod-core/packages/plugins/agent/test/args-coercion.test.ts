// Une liste ou un objet envoyé en texte JSON est corrigé ; tout le reste est refusé comme avant.
import { describe, expect, it } from "vitest";
import { coerceArgs, validateArgs } from "@jarod/plugin-tools";

const schema = {
  type: "object",
  properties: { sheets: { type: "array" }, opts: { type: "object" }, name: { type: "string" }, mixed: { type: ["string", "object"] } },
  required: ["sheets"],
};

describe("coerceArgs", () => {
  it("remplace sur place un tableau ou un objet écrit en texte JSON, et le dit", () => {
    const args: Record<string, unknown> = { sheets: ' [{"name":"a","rows":[[1]]}] ', opts: '{"x":1}', name: "[pas touché]" };
    expect(coerceArgs(schema, args)).toEqual(["sheets", "opts"]);
    expect(args).toEqual({ sheets: [{ name: "a", rows: [[1]] }], opts: { x: 1 }, name: "[pas touché]" });
    expect(validateArgs(schema, args)).toBeNull();
  });

  it("laisse tel quel ce qui n'est pas du bon JSON, ni du bon genre, ni attendu comme tableau ou objet", () => {
    const args: Record<string, unknown> = { sheets: "[1, 2", opts: "[1]", mixed: '{"a":1}' };
    expect(coerceArgs(schema, args)).toEqual([]);
    expect(args).toEqual({ sheets: "[1, 2", opts: "[1]", mixed: '{"a":1}' });
    expect(validateArgs(schema, args)).toMatch(/Type invalide pour sheets : attendu array, reçu string/);
    const obj: Record<string, unknown> = { sheets: '{"a":1}' };
    expect(coerceArgs(schema, obj)).toEqual([]);
    expect(validateArgs(schema, obj)).toMatch(/attendu array/);
  });
});
