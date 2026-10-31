// Vue de l'écran (30/10) : ce que fait brahma avec `screen_processor.py` — une capture réduite en JPEG, donnée à un modèle qui VOIT, qui répond
// à la question posée. Le modèle de vision est celui que l'utilisateur a nommé (Réglages › Description d'images) : la capture lui est envoyée,
// donc rien ne part sans ce réglage. Sans lui, l'outil retombe sur la lecture du texte de l'écran (locale, `screen_read`) et le dit.
import type { ToolDef } from "../registry.js";
import { powershellExe, type PsRunner, realPsRunner } from "./ps.js";
import * as E from "./scripts-everyday.js";

export interface ScreenLookDeps {
  platform?: NodeJS.Platform;
  ps?: PsRunner;
  /** Regarde une image et répond à la question ; absent ou `canLook()` faux : lecture du texte seulement. */
  vision?: { canLook(): boolean; look(image: { data: string; mime: string }, question: string, signal?: AbortSignal): Promise<string> };
}

const QUESTION_DEFAULT =
  "Décris ce qu'affiche cet écran : les fenêtres ouvertes, le contenu important, et recopie mot pour mot le texte utile (messages d'erreur, titres, chiffres). Réponds en français, de façon concise.";

export function screenLookTool(deps: ScreenLookDeps = {}): ToolDef[] {
  if ((deps.platform ?? process.platform) !== "win32") return [];
  const runner = (): PsRunner => deps.ps ?? realPsRunner(powershellExe());
  const json = (v: unknown) => JSON.stringify(v);
  return [
    {
      name: "screen_look",
      source: "builtin",
      dangerous: false,
      audited: true,
      limit: () => (deps.vision?.canLook() ? null : "Vision désactivée — lecture du texte seulement (OCR). Choisir un modèle dans Réglages › Modèles › Description d'images"),
      description:
        "REGARDE l'écran de l'utilisateur et répond à une question (« qu'est-ce qui est affiché ? », « que dit cette erreur ? », « sur quel site suis-je ? »). target=screen : tous les écrans ; target=window : la fenêtre au premier plan. Utilise-le dès que l'utilisateur dit « regarde mon écran », « tu vois ? » ou parle de ce qu'il a sous les yeux. La capture est envoyée au modèle de vision réglé par l'utilisateur ; sans réglage, seul le texte lisible est rendu.",
      parameters: {
        type: "object",
        properties: { question: { type: "string" }, target: { type: "string", enum: ["screen", "window"] } },
      },
      async run(args, ctx) {
        const target = args.target === "window" ? "window" : "screen";
        const question = typeof args.question === "string" && args.question.trim() ? args.question.trim().slice(0, 1000) : QUESTION_DEFAULT;
        const vision = deps.vision;
        if (vision?.canLook()) {
          const shot = ((await runner().json(E.SCREEN_SHOT, { target }, { timeoutMs: 60_000, signal: ctx.signal })) ?? {}) as { jpeg?: string; width?: number; height?: number };
          if (!shot.jpeg) throw new Error("la capture d'écran est vide");
          const answer = await vision.look({ data: shot.jpeg, mime: "image/jpeg" }, question, ctx.signal);
          return json({ target, mode: "vision", size: `${shot.width}x${shot.height}`, answer });
        }
        const r = ((await runner().json(E.SCREEN_OCR, { target }, { timeoutMs: 90_000, signal: ctx.signal })) ?? {}) as { lines?: unknown };
        const text = (Array.isArray(r.lines) ? r.lines.map(String) : []).join("\n").slice(0, 30_000);
        return json({
          target,
          mode: "texte",
          note: "Aucun modèle de vision n'est réglé : seul le texte lisible à l'écran est rendu (pas les images ni la mise en page). Réglages › Modèles › Description d'images pour voir vraiment.",
          text,
          empty: text.trim() === "",
        });
      },
    },
  ];
}
