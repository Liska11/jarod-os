/**
 * Phase 4 (audit v4) — l'échappement des arguments d'un serveur MCP sous `cmd.exe`.
 *
 * Le client MCP lance un serveur stdio par `spawn(..., { shell: true })` sur Windows quand la commande n'est
 * pas un chemin absolu (les shims `npx`/`uvx` sont des `.cmd`). L'ancien échappement d'un guillemet littéral
 * était `\"` — or `cmd.exe` ne donne AUCUN sens particulier à l'antislash : à l'intérieur d'une chaîne entre
 * guillemets, un guillemet s'écrit `""`. Avec `\"`, la chaîne se refermait au premier guillemet et la suite
 * (`&`, `|`, `>`) était interprétée comme une commande.
 */
import { describe, expect, it } from "vitest";
import { cmdQuote } from "../src/mcp.js";

describe("cmdQuote — l'échappement d'un argument pour cmd.exe", () => {
  it("laisse un argument sans métacaractère tel quel", () => {
    expect(cmdQuote("mcp-server")).toBe("mcp-server");
    expect(cmdQuote("C:/outils/serveur.js")).toBe("C:/outils/serveur.js");
  });

  it("entoure de guillemets un argument à espaces", () => {
    expect(cmdQuote("C:/Program Files/serveur.js")).toBe('"C:/Program Files/serveur.js"');
  });

  it("double un guillemet littéral, et n'utilise JAMAIS l'antislash", () => {
    const q = cmdQuote('say "hi"');
    expect(q).toBe('"say ""hi"""');
    expect(q, "`\\\"` est ce que cmd.exe ne comprend pas").not.toContain('\\"');
  });

  it("protège les métacaractères de cmd.exe en les mettant entre guillemets", () => {
    for (const s of ["a&b", "a|b", "a>b", "a<b", "a^b"]) expect(cmdQuote(s)).toBe(`"${s}"`);
  });

  it("une tentative d'injection reste inerte : la chaîne ne se referme pas avant la fin", () => {
    const q = cmdQuote('x" & calc & "');
    expect(q).toBe('"x"" & calc & """');
    // Un nombre PAIR de guillemets : rien n'est laissé ouvert, donc le `&` reste à l'intérieur.
    expect((q.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it("un argument vide ne devient pas un argument absent", () => {
    expect(cmdQuote("")).toBe("");
  });
});