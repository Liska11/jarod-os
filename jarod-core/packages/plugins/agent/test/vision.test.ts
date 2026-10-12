// Portage de packages/core/test/vision.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent.js";
import type { ChatRequest } from "@jarod/contracts";
import { supportsVision } from "@jarod/plugin-vision";
import { makeCore } from "./helpers.js";

type Core = Awaited<ReturnType<typeof makeCore>>;

/** A 1×1 PNG: real bytes, as a screenshot would arrive. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** Every request per provider; the describing model answers a description, the others "ok". */
function fakes(core: Core, opts: { describerFails?: boolean } = {}) {
  const requests: { provider: string; req: ChatRequest }[] = [];
  core.providers.client = (provider: string) =>
    ({
      chat: async (req: ChatRequest) => {
        requests.push({ provider, req });
        const sees = req.messages.some((m) => m.attachments?.some((a) => a.kind === "image" && a.data));
        if (sees && provider === "openai") {
          if (opts.describerFails) throw new Error("quota dépassé");
          return {
            text: "Une fenêtre d'erreur : « Fichier introuvable »",
            thinking: "",
            toolCalls: [],
            stopReason: "stop",
          };
        }
        return { text: "ok", thinking: "", toolCalls: [], stopReason: "stop" };
      },
      listModels: async () => [],
    }) as never;
  core.settings.set("autoTitle", false);
  return requests;
}

async function sendImage(core: Core, sessionId = core.sessions.create().id) {
  const att = core.attachments.save("capture.png", "image/png", PNG);
  const events: AgentEvent[] = [];
  const r = await core.runAndWait(
    sessionId,
    "Que dit cette capture ?",
    { emit: (e) => events.push(e), approve: async () => false },
    [att],
  );
  return { r, events, sessionId, att };
}

const attachmentsSentTo = (requests: { provider: string; req: ChatRequest }[], provider: string) =>
  requests.filter((x) => x.provider === provider).flatMap((x) => x.req.messages.flatMap((m) => m.attachments ?? []));

describe("qui voit les images", () => {
  it("reconnaît les familles qui lisent les images, et suppose le contraire pour le reste", () => {
    for (const [p, m] of [
      ["anthropic", "claude-sonnet-5"],
      ["openai", "gpt-4o-mini"],
      ["openai", "gpt-5"],
      ["google", "gemini-2.5-flash"],
      ["openrouter", "qwen/qwen2.5-vl-72b-instruct"],
      ["ollama", "llava:13b"],
      ["ollama", "gemma3:12b"],
      ["mistral", "pixtral-large-latest"],
      ["llamacpp", "Llama-3.2-11B-Vision-Instruct"],
    ]) {
      expect(supportsVision(p!, m!), `${p}/${m}`).toBe(true);
    }
    for (const [p, m] of [
      ["deepseek", "deepseek-chat"],
      ["deepseek", "deepseek-reasoner"],
      ["ollama", "qwen2.5-coder:14b"],
      ["lmstudio", "mistral-7b-instruct"],
      ["openai", "gpt-3.5-turbo"],
    ]) {
      expect(supportsVision(p!, m!), `${p}/${m}`).toBe(false);
    }
  });
});

describe("description automatique des images", () => {
  it("un modèle texte seul reçoit la description écrite par le modèle choisi, une seule fois", async () => {
    const core = await makeCore();
    core.settings.patch({
      activeProvider: "deepseek",
      activeModel: "deepseek-chat",
      imageDescription: { mode: "auto", provider: "openai", model: "gpt-4o" },
    });
    const requests = fakes(core);
    const { r, events, sessionId } = await sendImage(core);
    expect(r.text).toBe("ok");

    const toDescriber = requests.filter((x) => x.provider === "openai");
    expect(toDescriber).toHaveLength(1);
    expect(toDescriber[0]!.req.model).toBe("gpt-4o");
    const seen = attachmentsSentTo(requests, "deepseek");
    expect(seen.some((a) => a.kind === "image")).toBe(false);
    const described = seen.find((a) => a.name === "capture.png")!;
    expect(described.kind).toBe("text");
    expect(described.text).toContain("Fichier introuvable");
    expect(described.text).toContain("gpt-4o");
    expect(events.some((e) => e.type === "status" && e.status === "Description de l'image « capture.png »…")).toBe(
      true,
    );

    // The next turn replays the history: the description comes from the cache, not a new call.
    await core.runAndWait(sessionId, "Et donc ?", { emit: () => {}, approve: async () => false });
    expect(requests.filter((x) => x.provider === "openai")).toHaveLength(1);
    expect(attachmentsSentTo(requests, "deepseek").filter((a) => a.text?.includes("Fichier introuvable")).length).toBe(
      2,
    );
  });

  it("sans modèle de description choisi, rien ne part ailleurs : l'image est envoyée telle quelle", async () => {
    const core = await makeCore();
    core.settings.patch({ activeProvider: "deepseek", activeModel: "deepseek-chat" });
    const requests = fakes(core);
    await sendImage(core);
    expect(requests.map((x) => x.provider)).toEqual(["deepseek"]);
    expect(attachmentsSentTo(requests, "deepseek").some((a) => a.kind === "image" && a.data)).toBe(true);
  });

  it("un modèle qui voit reçoit l'image ; « always » la décrit quand même ; « off » jamais", async () => {
    const seeing = await makeCore();
    seeing.settings.patch({
      activeProvider: "anthropic",
      activeModel: "claude-sonnet-5",
      imageDescription: { mode: "auto", provider: "openai", model: "gpt-4o" },
    });
    const r1 = fakes(seeing);
    await sendImage(seeing);
    expect(r1.map((x) => x.provider)).toEqual(["anthropic"]);

    const always = await makeCore();
    always.settings.patch({
      activeProvider: "anthropic",
      activeModel: "claude-sonnet-5",
      imageDescription: { mode: "always", provider: "openai", model: "gpt-4o" },
    });
    const r2 = fakes(always);
    await sendImage(always);
    expect(r2.map((x) => x.provider)).toEqual(["openai", "anthropic"]);

    const off = await makeCore();
    off.settings.patch({
      activeProvider: "deepseek",
      activeModel: "deepseek-chat",
      imageDescription: { mode: "off", provider: "openai", model: "gpt-4o" },
    });
    const r3 = fakes(off);
    await sendImage(off);
    expect(r3.map((x) => x.provider)).toEqual(["deepseek"]);
  });

  it("une description impossible est dite au modèle, et le tour continue", async () => {
    const core = await makeCore();
    core.settings.patch({
      activeProvider: "deepseek",
      activeModel: "deepseek-chat",
      imageDescription: { mode: "auto", provider: "openai", model: "gpt-4o" },
    });
    const requests = fakes(core, { describerFails: true });
    const { r, att } = await sendImage(core);
    expect(r.error).toBeUndefined();
    const described = attachmentsSentTo(requests, "deepseek").find((a) => a.name === "capture.png")!;
    expect(described.text).toBe("[Image non décrite : quota dépassé]");
    // Nothing cached: the next turn tries again.
    expect(core.vision!.cached(att.id)).toBeUndefined();
  });

  it("supprimer la pièce jointe supprime sa description", async () => {
    const core = await makeCore();
    core.settings.patch({
      activeProvider: "deepseek",
      activeModel: "deepseek-chat",
      imageDescription: { mode: "auto", provider: "openai", model: "gpt-4o" },
    });
    fakes(core);
    const { att } = await sendImage(core);
    expect(core.vision!.cached(att.id)).toContain("Fichier introuvable");
    core.attachments.delete(att.id);
    expect(core.vision!.cached(att.id)).toBeUndefined();
  });
});
