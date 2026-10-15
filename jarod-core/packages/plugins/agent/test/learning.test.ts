// Portage de packages/core/test/learning.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import type { AgentHooks } from "../src/agent.js";
import type { TestCore as JarodCore } from "./helpers.js";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import { parseReview } from "../src/learning.js";
import { MAX_PROFILE_CHARS, UserProfileService } from "@jarod/plugin-memory";
import { makeCore, tempDir } from "./helpers.js";

function fakeProvider(core: JarodCore, answer: (req: ChatRequest) => string): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => ["m"],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const text = answer(req);
      h.onText?.(text);
      const r: ChatResult = { text, thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1 };
      return r;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return requests;
}

const hooks: AgentHooks = { emit: () => {}, approve: async () => true };
const run = (core: JarodCore, id: string, text: string) =>
  new Promise<void>((resolve) => {
    void core.submit(id, text, { ...hooks, emit: (e) => e.type === "done" && resolve() });
  });
const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("user profile (USER.md)", () => {
  it("keeps sections of lines, without duplicates, and bounded", () => {
    const dir = tempDir();
    const p = new UserProfileService(() => dir);
    expect(p.read()).toBe("");
    expect(p.add("Identité", "Développeur à Lyon")).toBe(true);
    expect(p.add("Identité", "développeur à lyon")).toBe(false);
    p.add("Préférences", "Réponses courtes, en français");
    expect(p.read()).toBe(
      "# Profil de l'utilisateur\n\n## Identité\n- Développeur à Lyon\n\n## Préférences\n- Réponses courtes, en français",
    );
    p.setSection("Identité", ["Développeur à Paris"]);
    expect(p.read()).toContain("- Développeur à Paris");
    expect(p.remove("paris")).toBe(1);
    expect(p.read()).not.toContain("## Identité");
    expect(() => p.write("x".repeat(MAX_PROFILE_CHARS + 1))).toThrow(/condense/);
  });

  it("is read into the system prompt, and its tool is kept out of plan mode", async () => {
    const core = await makeCore();
    await core.init();
    await core.tools
      .get("user_profile")!
      .run(
        { action: "add", section: "Façon de travailler", line: "Aime les plans numérotés" },
        { sessionId: "s", workspace: null },
      );
    const s = core.settings.getAll();
    expect(core.agent.buildSystemPrompt("bonjour", s)).toContain(
      "## Profil de l'utilisateur (USER.md)\n## Façon de travailler\n- Aime les plans numérotés",
    );
    expect(core.agent.toolSpecs({ ...s, agentMode: "plan" }).map((t) => t.name)).not.toContain("user_profile");
  });
});

describe("learning review", () => {
  it("parses the review answer defensively", () => {
    expect(parseReview('voici : {"memories":[{"content":"a"}],"profile":[]}')?.memories).toHaveLength(1);
    expect(parseReview("pas de json")).toBeNull();
    expect(parseReview("{cassé")).toBeNull();
  });

  it("reviews after enough user messages, keeps durable things, drops secrets, suggests a skill", async () => {
    const core = await makeCore();
    await core.init();
    core.settings.set("learning", { enabled: true, reviewEvery: 2 });
    const review = JSON.stringify({
      memories: [
        { type: "preference", content: "Préfère TypeScript à JavaScript" },
        { type: "fact", content: "Son mot de passe GitHub est hunter2" },
      ],
      profile: [{ section: "Projets en cours", line: "Jarod-One, un agent de bureau" }],
      skill: { name: "Publier une version", description: "bump, build, installeurs" },
    });
    const reqs = fakeProvider(core, (req) => (req.system.startsWith("Tu relis") ? review : "ok"));
    const s = core.sessions.create();
    await run(core, s.id, "Je travaille sur Jarod-One");
    expect(reqs.filter((r) => r.system.startsWith("Tu relis"))).toHaveLength(0);
    await run(core, s.id, "Et je préfère TypeScript");
    await until(() => core.notifications.list().some((n) => n.title === "Idée de skill"));

    const reviewReq = reqs.find((r) => r.system.startsWith("Tu relis"))!;
    expect(reviewReq.messages[0]!.content).toContain("UTILISATEUR : Et je préfère TypeScript");
    expect(core.memory.list().map((m) => m.content)).toContain("Préfère TypeScript à JavaScript");
    expect(
      core.memory
        .list()
        .map((m) => m.content)
        .join(" "),
    ).not.toMatch(/hunter2/);
    expect(core.userProfile.read()).toContain("## Projets en cours\n- Jarod-One, un agent de bureau");
    expect(core.notifications.list().find((n) => n.title === "Jarod a appris")?.body).toMatch(/TypeScript/);
    expect(core.notifications.list().find((n) => n.title === "Idée de skill")?.body).toMatch(/^Publier une version/);

    // Not again until two new user messages.
    await run(core, s.id, "merci");
    await new Promise((r) => setTimeout(r, 50));
    expect(reqs.filter((r) => r.system.startsWith("Tu relis"))).toHaveLength(1);
  });

  it("une revue lancée sans signal d'appelant reste réellement annulable (R3.5)", async () => {
    const core = await makeCore();
    await core.init();
    core.settings.set("learning", { enabled: true, reviewEvery: 2 });
    let seen: AbortSignal | undefined;
    const client: ProviderClient = {
      listModels: async () => ["m"],
      chat: (req) =>
        new Promise<ChatResult>((_resolve, reject) => {
          seen = req.signal;
          req.signal?.addEventListener("abort", () => reject(new Error("annulé")), { once: true });
        }),
    };
    core.providers.client = () => client;
    const s = core.sessions.create();

    // La revue est un appel d'arrière-plan : personne ne lui passe de signal.
    const review = core.learning.review(s.id);
    await until(() => seen !== undefined);
    expect(seen?.aborted, "tant que la revue tourne, rien n'est annulé").toBe(false);

    // Le contrôleur appartient maintenant au service : l'arrêt coupe bien l'appel en aval.
    expect(core.learning.cancel(s.id), "la revue en vol s'arrête").toBe(true);
    await expect(review).rejects.toThrow(/annulé/);
    expect(seen?.aborted).toBe(true);
    expect(core.learning.cancel(s.id), "déjà finie : rien à annuler").toBe(false);
  });

  it("cancelAll() coupe une revue en vol (arrêt du noyau)", async () => {
    const core = await makeCore();
    await core.init();
    core.settings.set("learning", { enabled: true, reviewEvery: 2 });
    let seen: AbortSignal | undefined;
    const client: ProviderClient = {
      listModels: async () => ["m"],
      chat: (req) =>
        new Promise<ChatResult>((_resolve, reject) => {
          seen = req.signal;
          req.signal?.addEventListener("abort", () => reject(new Error("annulé")), { once: true });
        }),
    };
    core.providers.client = () => client;
    const s = core.sessions.create();
    const review = core.learning.review(s.id);
    await until(() => seen !== undefined);

    core.learning.cancelAll();
    await expect(review).rejects.toThrow(/annulé/);
    expect(seen?.aborted).toBe(true);
  });

  it("does nothing when turned off", async () => {
    const core = await makeCore();
    await core.init();
    core.settings.set("learning", { enabled: false, reviewEvery: 2 });
    const reqs = fakeProvider(core, () => "ok");
    const s = core.sessions.create();
    for (const t of ["a", "b", "c"]) await run(core, s.id, t);
    await new Promise((r) => setTimeout(r, 50));
    expect(reqs.some((r) => r.system.startsWith("Tu relis"))).toBe(false);
  });
});
