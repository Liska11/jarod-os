// Les mêmes vecteurs des deux côtés : `apps/desktop/src/lib/redact.test.ts` porte la copie du shell (le processus
// principal Electron ne peut pas importer `@jarod/*`).
import { describe, expect, it } from "vitest";
import { KEYED_SECRET, redactKeyedText, redactText } from "../src/redact.js";

describe("redactText", () => {
  it("masque les formes longues", () => {
    expect(redactText("clé sk-abcdefghijklmnopqrstuvwxyz012345")).toContain("sk-[masqué]");
    expect(redactText("Bearer abcdefghijklmnop")).toContain("Bearer [masqué]");
    expect(redactText("ghp_ABCDEFGHIJKLMNOPQRSTUVWX")).toContain("[jeton masqué]");
    expect(redactText("xoxb-1234567890ABCDEFGH")).toContain("xox[masqué]");
    expect(redactText("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456")).toContain("[clé masquée]");
    expect(redactText(`1234567890:${"A".repeat(40)}`)).toContain("[jeton masqué]");
    expect(redactText('"api_key": "abcdefghijklmnop"')).toContain("[masqué]");
  });

  it("masque un jeton de bot collé à son préfixe, comme dans une URL d'API", () => {
    const url = `https://api.telegram.org/bot${"1".repeat(9)}:${"A".repeat(35)}/sendMessage`;
    expect(redactText(url)).toContain("[jeton masqué]");
    expect(redactText(url)).not.toContain("A".repeat(35));
  });

  it("laisse intact le texte ordinaire", () => {
    expect(redactText("le moteur a démarré sur le port 8722")).toBe("le moteur a démarré sur le port 8722");
  });

  it("garde son seuil de 12 caractères : c'est `redactKeyedText` qui couvre les valeurs courtes", () => {
    expect(redactText("https://x/y?token=abc123")).toBe("https://x/y?token=abc123");
    expect(redactKeyedText("https://x/y?token=abc123")).toBe("https://x/y?token=[masqué]");
  });
});

describe("redactKeyedText", () => {
  it("masque à clé explicite une valeur trop courte pour le seuil générique", () => {
    expect(redactKeyedText("password=pw1234")).toBe("password=[masqué]");
    expect(redactKeyedText('"api_key": "court"')).toBe('"api_key": "[masqué]"');
    expect(redactKeyedText("X-Hermes-Session-Token: abc")).toBe("X-Hermes-Session-Token: [masqué]");
  });

  it("est idempotent et ne remasque pas une valeur déjà masquée", () => {
    for (const text of ["https://x/y?token=[masqué]", "password=[masqué]", "secret: [masqué]"]) {
      expect(redactKeyedText(redactKeyedText(text))).toBe(redactKeyedText(text));
    }

    expect(redactKeyedText("https://x/y?token=[masqué]")).toBe("https://x/y?token=[masqué]");
  });

  it("sur-masque un nom qui contient un mot à clé, et laisse le reste intact", () => {
    expect(redactKeyedText("max_tokens: 4096")).toBe("max_tokens: [masqué]");
    expect(redactKeyedText("le modèle répond en français")).toBe("le modèle répond en français");
  });

  it("exporte la règle elle-même, pour la revalider sans la recopier", () => {
    expect("token=[masqué]".replace(KEYED_SECRET, "$1[masqué]")).toBe("token=[masqué]");
  });
});
