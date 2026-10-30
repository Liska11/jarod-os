// Q2 (analyse du 29/10, idée reprise de brahma `core/learned_rules.py`) : une consigne donnée en corrigeant Jarod est gardée comme souvenir
// de type `rule` et injectée dans CHAQUE conversation, quelle que soit la requête, bornée en nombre, jamais en double avec les souvenirs.
import { describe, expect, it } from "vitest";
import { MAX_INJECTED_RULES } from "@jarod/plugin-memory";
import { makeCore } from "./helpers.js";

describe("Q2 règles apprises", () => {
  it("une règle est injectée même quand la requête n'a rien à voir", async () => {
    const core = await makeCore();
    core.memory.add("Ne jamais tutoyer l'utilisateur.", "rule");
    const prompt = core.agent.buildSystemPrompt("quelle heure est-il ?");
    expect(prompt).toContain("## Règles que l'utilisateur t'a données (à respecter toujours)\n- Ne jamais tutoyer l'utilisateur.");
  });

  it("une règle n'apparaît pas aussi parmi les souvenirs", async () => {
    const core = await makeCore();
    core.memory.add("Toujours répondre en français.", "rule");
    const prompt = core.agent.buildSystemPrompt("français");
    expect(prompt.split("Toujours répondre en français.").length - 1).toBe(1);
  });

  it(`au plus ${MAX_INJECTED_RULES} règles injectées, les plus récentes`, async () => {
    const core = await makeCore();
    for (let i = 0; i < MAX_INJECTED_RULES + 5; i++) core.memory.add(`Règle numéro ${i}.`, "rule");
    expect(core.memory.rules()).toHaveLength(MAX_INJECTED_RULES);
  });
});
