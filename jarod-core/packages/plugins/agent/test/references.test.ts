// Portage de packages/core/test/references.test.ts (rév. 2e180305).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatRequest } from "@jarod/contracts";
import { expandReferences, findReferences, searchFiles } from "@jarod/plugin-memory";
import type { Attachment } from "@jarod/contracts";
import { makeCore, tempDir } from "./helpers.js";

/** A small project: code, an image, a binary, a folder, and dependencies nobody wants listed. */
function project(): string {
  const ws = tempDir();
  mkdirSync(join(ws, "src", "lib"), { recursive: true });
  mkdirSync(join(ws, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(ws, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(ws, "src", "lib", "util.ts"), "export const util = 2;\n");
  writeFileSync(join(ws, "notes de réunion.md"), "# Réunion\n");
  writeFileSync(join(ws, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  writeFileSync(join(ws, "data.bin"), Buffer.from([1, 0, 2, 0, 3]));
  writeFileSync(join(ws, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  return ws;
}

function saver() {
  const saved: { name: string; mime: string; data: string }[] = [];
  const save = (name: string, mime: string, data: Buffer): Attachment => {
    saved.push({ name, mime, data: data.toString("utf8") });
    return { id: `a${saved.length}`, name, mime, size: data.length };
  };
  return { saved, save };
}

describe("les références @", () => {
  it("se lisent dans le texte, sans prendre une adresse e-mail pour une référence", () => {
    expect(findReferences('Regarde @src/app.ts, puis @"notes de réunion.md" et @diff.')).toEqual([
      "src/app.ts",
      "notes de réunion.md",
      "diff",
    ]);
    expect(findReferences("écris à jean@exemple.fr ou (@src/lib/)")).toEqual(["src/lib/"]);
    expect(findReferences("@a @a @b")).toEqual(["a", "b"]);
  });

  it("joignent fichiers, images et arborescences du dossier de travail — rien d'autre", async () => {
    const ws = project();
    const { saved, save } = saver();
    const r = await expandReferences(
      'Vois @src/app.ts, @logo.png, @src/, @"notes de réunion.md", @data.bin, @jean et @../ailleurs.txt',
      ws,
      save,
    );
    expect(saved.map((s) => [s.name, s.mime])).toEqual([
      ["src/app.ts", "text/plain"],
      ["logo.png", "image/png"],
      ["src-arborescence.txt", "text/plain"],
      ["notes de réunion.md", "text/plain"],
    ]);
    expect(saved[0]!.data).toContain("export const app");
    expect(saved[2]!.data).toBe("Contenu de src/ :\napp.ts\nlib/\n  util.ts");
    expect(r.attachments).toHaveLength(4);
    expect(r.notes).toEqual(["[@data.bin : fichier binaire, non joint]"]);
  });

  it("@diff joint les modifications, ou dit pourquoi il n'y en a pas", async () => {
    const ws = project();
    const a = saver();
    await expandReferences("@diff", ws, a.save, async () => "diff --git a/x b/x\n+ligne");
    expect(a.saved).toEqual([{ name: "modifications.diff", mime: "text/plain", data: "diff --git a/x b/x\n+ligne" }]);
    const b = saver();
    expect((await expandReferences("@diff", ws, b.save, async () => null)).notes[0]).toMatch(/pas un dépôt git/);
    expect((await expandReferences("@diff", ws, b.save, async () => "")).notes[0]).toMatch(/aucune modification/);
  });

  it("proposent les fichiers qui correspondent, sans les dépendances", () => {
    const ws = project();
    expect(searchFiles(ws, "app")).toEqual(["src/app.ts"]);
    expect(searchFiles(ws, "util")[0]).toBe("src/lib/util.ts");
    expect(searchFiles(ws, "left-pad")).toEqual([]);
    expect(searchFiles(ws, "")).toContain("src/");
  });

  it("dans la zone de saisie, le message garde son texte et reçoit les pièces jointes", async () => {
    const core = await makeCore();
    const ws = project();
    core.settings.patch({ workspace: ws, autoTitle: false });
    const requests: ChatRequest[] = [];
    core.providers.client = () =>
      ({
        chat: async (req: ChatRequest) => {
          requests.push(req);
          return { text: "vu", thinking: "", toolCalls: [], stopReason: "stop" };
        },
        listModels: async () => [],
      }) as never;
    const session = core.sessions.create();
    const done = new Promise<void>((resolve) => {
      void core.submit(session.id, "Explique @src/app.ts", {
        approve: async () => false,
        emit: (e) => e.type === "done" && resolve(),
      });
    });
    await done;
    const user = core.messages.list(session.id).find((m) => m.role === "user")!;
    expect(user.content).toBe("Explique @src/app.ts");
    expect(user.attachments?.map((a) => a.name)).toEqual(["src_app.ts"]);
    const sent = requests[0]!.messages.find((m) => m.role === "user")!;
    expect(sent.attachments?.[0]).toMatchObject({ kind: "text" });
    expect(sent.attachments?.[0]?.text).toContain("export const app");
  });
});
