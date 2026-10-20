/**
 * Cockpit, lot 5 : écran « Artefacts », VRAI kernel, VRAIS handlers, vrais fichiers.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

describe("artefacts", () => {
  it("liste avec l'état du fichier ; aperçu borné d'un SVG intact ; refus après modification ; jamais un programme ouvert", async () => {
    const { call, app } = await setupKernel();
    const ws = tempDir();
    writeFileSync(join(ws, "a.svg"), "<svg/>");
    writeFileSync(join(ws, "outil.exe"), "MZ");
    const svg = app.agent.artifacts.register({ sessionId: null, kind: "diagram", title: "A", path: join(ws, "a.svg"), origin: "agent" });
    const exe = app.agent.artifacts.register({ sessionId: null, kind: "file", title: "outil", path: join(ws, "outil.exe"), origin: "agent" });
    const rows = (await call("artifacts-list")) as { id: string; state: string }[];
    expect(rows.find((r) => r.id === svg.id)?.state).toBe("intact");
    expect(await call("artifact-preview", svg.id)).toEqual({ kind: "svg", text: "<svg/>" });
    expect(await call("artifact-open", exe.id)).toMatchObject({ success: false, error: expect.stringMatching(/programme/) });
    writeFileSync(join(ws, "a.svg"), "<svg>autre</svg>");
    expect(await call("artifact-preview", svg.id)).toMatchObject({ kind: "none", reason: expect.stringMatching(/changé/) });
    expect(await call("artifact-preview", "../x")).toMatchObject({ kind: "none" });
    expect(await call("artifact-forget", svg.id)).toEqual({ success: true });
    expect(((await call("artifacts-list")) as unknown[]).length).toBe(1);
  });
});
