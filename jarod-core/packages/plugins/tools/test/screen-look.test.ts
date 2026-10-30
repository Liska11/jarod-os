// Vue de l'écran : avec un modèle de vision réglé, la capture JPEG lui est donnée avec la question ; sans, repli sur le texte lisible.
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/registry.js";
import { screenLookTool } from "../src/system/screen-look.js";
import * as E from "../src/system/scripts-everyday.js";

const ctx = { sessionId: "s", workspace: null } as ToolContext;

function ps() {
  const calls: { script: string; args: unknown }[] = [];
  return {
    calls,
    json: async (script: string, args?: Record<string, unknown>) => {
      calls.push({ script, args });
      return script === E.SCREEN_SHOT ? { width: 1920, height: 1080, jpeg: "QUJD" } : { lines: ["Erreur 404", "Page introuvable"] };
    },
  };
}

describe("screen_look", () => {
  it("n'existe que sous Windows", () => {
    expect(screenLookTool({ platform: "linux" })).toEqual([]);
  });

  it("avec un modèle de vision : capture JPEG envoyée avec la question, réponse rendue", async () => {
    const p = ps();
    const seen: { image: { data: string; mime: string }; question: string }[] = [];
    const [tool] = screenLookTool({ platform: "win32", ps: p, vision: { canLook: () => true, look: async (image, question) => (seen.push({ image, question }), "Un navigateur sur une page d'erreur 404.") } });
    expect(tool!.dangerous).toBe(false);
    const out = JSON.parse(await tool!.run({ question: "Que dit l'erreur ?", target: "window" }, ctx));
    expect(out).toMatchObject({ mode: "vision", answer: "Un navigateur sur une page d'erreur 404.", size: "1920x1080" });
    expect(p.calls).toEqual([{ script: E.SCREEN_SHOT, args: { target: "window" } }]);
    expect(seen[0]).toEqual({ image: { data: "QUJD", mime: "image/jpeg" }, question: "Que dit l'erreur ?" });
  });

  it("sans modèle de vision : le texte lisible, avec la raison dite", async () => {
    const p = ps();
    const [tool] = screenLookTool({ platform: "win32", ps: p, vision: { canLook: () => false, look: async () => "jamais" } });
    const out = JSON.parse(await tool!.run({}, ctx));
    expect(out.mode).toBe("texte");
    expect(out.text).toContain("Erreur 404");
    expect(out.note).toMatch(/Aucun modèle de vision/);
    expect(p.calls[0]!.script).toBe(E.SCREEN_OCR);
  });
});
