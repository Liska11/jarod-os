// ImageDescriber : cache par pièce jointe, repli lisible, annulation de l'utilisateur, et un fournisseur qui ne répond jamais ne bloque pas le tour.
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ImageDescriber, supportsVision } from "../src/vision.js";

afterEach(cleanup);

const image = { id: "img1", name: "capture.png", kind: "image", mime: "image/png", data: "AAAA" } as never;
const turn = (attachments: unknown[]) => ({ role: "user", content: "regarde", attachments }) as never;

async function describer(chat: (req: { signal?: AbortSignal }) => Promise<{ text: string }>, timeoutMs?: number) {
  const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false } });
  app.storage.settings.set("imageDescription", { mode: "always", provider: "p", model: "vm" });
  const calls = { n: 0 };
  const d = new ImageDescriber(
    {
      db: app.storage.db,
      settings: app.storage.settings,
      providers: { client: () => ({ chat: (req: { signal?: AbortSignal }) => (calls.n++, chat(req)) }) } as never,
      attachments: { load: () => ({ data: "AAAA" }) } as never,
    },
    ...(timeoutMs === undefined ? [] : [{ timeoutMs }]),
  );
  return { d, calls };
}

describe("ImageDescriber", () => {
  it("décrit une fois, garde la description, et la rejoue sans nouvel appel", async () => {
    const { d, calls } = await describer(async () => ({ text: "  un bouton rouge  " }));

    expect(await d.describe(image)).toBe("un bouton rouge");
    expect(await d.describe(image)).toBe("un bouton rouge");
    expect(calls.n).toBe(1);
  });

  it("une réponse vide est une erreur, pas une description vide gardée en cache", async () => {
    const { d } = await describer(async () => ({ text: "   " }));

    await expect(d.describe(image)).rejects.toThrow(/rien répondu/);
    expect(d.cached("img1")).toBeUndefined();
  });

  it("prepare : l'image devient du texte (jamais ses octets) ; un échec est dit dans le texte sans faire échouer le tour", async () => {
    const ok = await describer(async () => ({ text: "schéma" }));
    const [out] = await ok.d.prepare([turn([image])]);

    expect(out!.attachments![0]).toMatchObject({ kind: "text" });
    expect("data" in out!.attachments![0]!).toBe(false);
    expect((out!.attachments![0] as { text: string }).text).toContain("schéma");

    const ko = await describer(async () => {
      throw new Error("quota dépassé");
    });
    const [failed] = await ko.d.prepare([turn([image])]);

    expect((failed!.attachments![0] as { text: string }).text).toBe("[Image non décrite : quota dépassé]");
  });

  it("l'annulation de l'utilisateur interrompt le tour (elle n'est pas transformée en texte)", async () => {
    const { d } = await describer((req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("annulé")))));
    const user = new AbortController();
    const pending = d.prepare([turn([image])], user.signal);

    user.abort();

    await expect(pending).rejects.toThrow("annulé");
  });

  it("un fournisseur qui ne répond jamais est coupé après le délai : le tour continue avec « Image non décrite »", async () => {
    const { d } = await describer((req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("délai dépassé")))), 50);
    const started = Date.now();
    const [out] = await d.prepare([turn([image])]);

    expect(Date.now() - started).toBeLessThan(3000);
    expect((out!.attachments![0] as { text: string }).text).toMatch(/^\[Image non décrite : /);
  });
});

describe("supportsVision", () => {
  it("familles connues vraies, modèle inconnu faux (il recevra une description)", () => {
    for (const [p, m] of [["anthropic", "x"], ["openai", "gpt-4o-mini"], ["x", "gemini-2.5-pro"], ["x", "qwen2.5-vl-7b"], ["x", "llava:13b"]] as const) expect(supportsVision(p, m), `${p}/${m}`).toBe(true);
    for (const [p, m] of [["deepseek", "deepseek-chat"], ["lmstudio", "qwen3-8b"], ["x", "llama-3.1-8b"]] as const) expect(supportsVision(p, m), `${p}/${m}`).toBe(false);
  });
});
