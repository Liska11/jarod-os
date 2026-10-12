/**
 * W5 (Q4 = A) : SOUL.md du profil, s'il existe et n'est pas vide, EST la persona du prompt système ;
 * le réglage `persona` sert de repli ; `/persona` écrit le fichier. Jarod-cordis (pas de test source).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONA_FILE } from "@jarod/plugin-persona";
import { describe, expect, it } from "vitest";
import { makeCore } from "./helpers.js";

describe("persona SOUL.md", () => {
  it("sans SOUL.md : le réglage ; avec : le fichier ; vide : retour au réglage", async () => {
    const core = await makeCore();
    const soul = join(core.options.dataDir, PERSONA_FILE);
    core.settings.set("persona", "Persona du réglage.");
    expect(core.agent.buildSystemPrompt("bonjour").startsWith("Persona du réglage.")).toBe(true);

    writeFileSync(soul, "# Jarod\nTu es Jarod, sobre et direct.\n", "utf8");
    const prompt = core.agent.buildSystemPrompt("bonjour");
    expect(prompt.startsWith("# Jarod\nTu es Jarod, sobre et direct.")).toBe(true);
    expect(prompt).not.toContain("Persona du réglage.");

    writeFileSync(soul, "  \n", "utf8");
    expect(core.agent.buildSystemPrompt("bonjour").startsWith("Persona du réglage.")).toBe(true);
  });

  it("/persona écrit SOUL.md (le réglage n'est pas touché) et l'affiche", async () => {
    const core = await makeCore();
    const before = core.settings.get("persona");
    const r = await core.commands.execute("/persona Tu réponds en une phrase.", { sessionId: null });
    expect(r?.text).toBe("Persona mise à jour.");
    const soul = join(core.options.dataDir, PERSONA_FILE);
    expect(existsSync(soul)).toBe(true);
    expect(readFileSync(soul, "utf8")).toBe("Tu réponds en une phrase.\n");
    expect(core.settings.get("persona")).toBe(before);
    const shown = await core.commands.execute("/persona", { sessionId: null });
    expect(shown?.text).toContain("Tu réponds en une phrase.");
    expect(core.agent.buildSystemPrompt("x").startsWith("Tu réponds en une phrase.")).toBe(true);
  });
});
