import { describe, expect, it } from "vitest";
import { sameSecret } from "../src/secret.js";

// Un jeton de passerelle se compare sans court-circuiter : le test ne peut prouver le temps constant, mais
// il fige le contrat (valeur exacte, jamais une valeur absente, vide ou d'un autre type).
describe("sameSecret", () => {
  it("n'accepte que la valeur exacte", () => {
    const token = "V3Qy-token_base64url-abcdefghijklmnop";
    expect(sameSecret(token, token)).toBe(true);
  });

  it("refuse tout le reste, y compris un préfixe du bon jeton", () => {
    const token = "V3Qy-token_base64url-abcdefghijklmnop";
    expect(sameSecret("V3Qy-token_base64url-abcdefghijklmno", token)).toBe(false); // un octet de moins
    expect(sameSecret(`${token}p`, token)).toBe(false); // un octet de plus
    expect(sameSecret(token.slice(0, 12), token)).toBe(false);
    expect(sameSecret("V3Qy-token_base64url-abcdefghijklmnoP", token)).toBe(false); // même longueur, autre casse
  });

  it("refuse une valeur absente, vide ou d'un autre type (en-tête HTTP multiple)", () => {
    expect(sameSecret(undefined, "jeton")).toBe(false);
    expect(sameSecret(null, "jeton")).toBe(false);
    expect(sameSecret("", "jeton")).toBe(false);
    expect(sameSecret(["jeton", "jeton"], "jeton")).toBe(false);
    expect(sameSecret("jeton", "")).toBe(false);
  });
});
