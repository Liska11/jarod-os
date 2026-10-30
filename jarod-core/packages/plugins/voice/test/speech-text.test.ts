// Ce que la voix lit : nettoyage (markdown, émojis, flèches, adresses, code) et dictionnaire de prononciation. Le texte affiché n'est jamais touché.
import { describe, expect, it } from "vitest";
import { applyPronunciations, cleanForSpeech, spokenText } from "../src/speech-text.js";

const TRAP = [
  "# Résultat 🎉",
  "**Salut** Demba-san ! Voici _le_ point :",
  "- première étape → ouvrir `Paramètres`",
  "- deuxième étape ➜ voir https://exemple.com/a?b=1&c=2 ou [la doc](https://doc.example.org)",
  "1. Lancer ✅ puis ❌ arrêter 👍🏽",
  "```js",
  "console.log('secret')",
  "```",
  "<think>je réfléchis</think>",
  "> citation ⇒ fin • ok ★",
  "| a | b |",
].join("\n");

describe("nettoyage avant la synthèse", () => {
  it("retire markdown, émojis, flèches, adresses, code et réflexion ; garde les mots", () => {
    const out = cleanForSpeech(TRAP);
    expect(out).not.toMatch(/[*_`#>|]|https?:|www\.|console|secret|réfléchis/);
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}←-⇿➡➜✅❌★•]/u);
    expect(out).toContain("Salut Demba-san !");
    expect(out).toContain("première étape ouvrir Paramètres");
    expect(out).toContain("la doc");
    expect(out).toContain("un lien");
    expect(out).toContain("citation fin ok");
  });

  it("un texte déjà propre ne change pas ; les accents et la ponctuation restent", () => {
    expect(cleanForSpeech("Il est quatorze heures, c'est déjà l'été !")).toBe("Il est quatorze heures, c'est déjà l'été !");
    expect(cleanForSpeech("")).toBe("");
  });
});

describe("prononciation", () => {
  const dico = [{ written: "Demba-san", spoken: "Dèmba sanne" }, { written: "Demba", spoken: "Dèmba" }];

  it("par défaut aucun remplacement (Demba-san est lu tel quel) ; avec un dictionnaire : mot entier seulement, majuscules libres, le plus long d'abord", () => {
    expect(applyPronunciations("Salut Demba-san, ça va ?")).toBe("Salut Demba-san, ça va ?");
    expect(applyPronunciations("Salut Demba-san, ça va ?", dico)).toBe("Salut Dèmba sanne, ça va ?");
    expect(applyPronunciations("demba-SAN", dico)).toBe("Dèmba sanne");
    expect(applyPronunciations("Demba arrive", dico)).toBe("Dèmba arrive");
    expect(applyPronunciations("Dembasan et Dembaville", dico)).toBe("Dembasan et Dembaville");
  });

  it("spokenText = nettoyage puis dictionnaire", () => {
    expect(spokenText("**Demba-san** 🎉 → ok")).toBe("Demba-san ok");
    expect(spokenText("**Demba-san** 🎉 → ok", dico)).toBe("Dèmba sanne ok");
    expect(spokenText("GPU", [{ written: "GPU", spoken: "jé pé u" }])).toBe("jé pé u");
  });
});
