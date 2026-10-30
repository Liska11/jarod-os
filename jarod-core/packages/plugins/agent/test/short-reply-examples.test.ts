// Les exemples de réponses courtes sont dans le prompt système (30/10), en français comme en anglais, et ne contiennent eux-mêmes ni puce ni liste.
import { describe, expect, it } from "vitest";
import { shortReplyExamples } from "../src/agent.js";
import { makeCore } from "./helpers.js";

describe("exemples de réponses courtes", () => {
  it("trois exemples, sans puce ni markdown dans les réponses données en modèle", () => {
    for (const lang of ["fr", "en"]) {
      const lines = shortReplyExamples(lang).split("\n").filter((l) => l.startsWith("- "));
      expect(lines).toHaveLength(3);
      for (const l of lines) {
        const answer = l.split("→")[1]!;
        expect(answer).not.toMatch(/[*#`]|^\s*[-•]/);
        expect(answer.replace(/[«»"]/g, "").split(/[.!?]/).filter((x) => x.trim()).length).toBeLessThanOrEqual(2);
      }
    }
  });

  it("le prompt système réel les porte", async () => {
    const core = await makeCore();
    core.settings.patch({ language: "fr" });
    expect(core.agent.buildSystemPrompt("bonjour")).toContain("## Exemples de style");
  });
});
