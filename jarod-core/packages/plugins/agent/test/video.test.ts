// Cockpit, lot 7 — scénario 7 de la mission : lancer un rendu vidéo ; progression (tâche), annulation et résultat sont gérés.
// HyperFrames et ffprobe SIMULÉS (aucun rendu réel ici) ; la porte unique et le registre des tâches sont réels.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionGuard, unifiedGate } from "@jarod/plugin-permissions";
import { ToolRegistry, type ToolDef } from "@jarod/plugin-tools";
import { describe, expect, it } from "vitest";
import { executeGuardedTool } from "../src/agent.js";
import { ArtifactStore } from "../src/artifacts.js";
import { TaskLedger } from "../src/tasks.js";
import { type Runner, videoTools } from "../src/video.js";
import { makeCore, tempDir } from "./helpers.js";

async function rig(render: Runner, o: { ffprobe?: boolean } = {}) {
  const core = await makeCore();
  const ws = tempDir();
  mkdirSync(join(ws, "clip"));
  const artifacts = new ArtifactStore(core.db);
  const calls: string[][] = [];
  const run: Runner = async (file, args, opts) => {
    calls.push([file, ...args]);
    if (file.endsWith("ffprobe")) return { code: 0, stdout: JSON.stringify({ format: { duration: "4.000" }, streams: [{ codec_name: "h264", width: 1920, height: 1080 }] }), stderr: "" };
    return render(file, args, opts);
  };
  const which = (n: string) => (n === "hyperframes" ? "C:\\bin\\hyperframes.cmd" : n === "ffprobe" && o.ffprobe !== false ? "C:\\bin\\ffprobe" : null);
  const tools = new ToolRegistry();
  for (const t of videoTools({ artifacts, run, which })) tools.register(t as unknown as ToolDef);
  const tasks = new TaskLedger();
  const settings = { disabledTools: [], agentMode: "build", autoApproveTools: false, alwaysAllowTools: [], workspace: ws } as never;
  const call = (args: Record<string, unknown>, signal = new AbortController().signal) =>
    executeGuardedTool(tools, "s", { id: "c", name: "video_render", args }, signal, { approve: async () => true }, settings, { gate: unifiedGate(new PermissionGuard(), () => true), tasks });
  return { core, ws, artifacts, calls, tasks, call };
}

const writes: Runner = async (_f, args) => {
  writeFileSync(args[args.indexOf("--output") + 1]!, "faux mp4");
  return { code: 0, stdout: "rendu terminé", stderr: "" };
};

describe("rendu vidéo HyperFrames", () => {
  it("rend localement avec des arguments fermés, vérifie par ffprobe, enregistre l'artefact vidéo", async () => {
    const { core, ws, calls, artifacts, tasks, call } = await rig(writes);
    const r = await call({ project: "clip", output: "out.mp4", quality: "high", fps: 30 });
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/\[Vérification : constatée\] out\.mp4 : 4\.00 s, 1920×1080, h264/);
    expect(calls[0]).toEqual(["C:\\bin\\hyperframes.cmd", "render", "--output", join(ws, "out.mp4"), "--format", "mp4", "--quiet", "--quality", "high", "--fps", "30"]);
    expect(artifacts.list({ kind: "video" })[0]).toMatchObject({ title: "out.mp4", sourcePath: join(ws, "clip"), origin: "video_render" });
    expect(tasks.list()[0]).toMatchObject({ status: "done", summary: "Rendre la vidéo clip → out.mp4 (HyperFrames, local)" });
    await core.dispose();
  });

  it("refuse avant l'accord : projet absent, format inconnu, sortie hors du dossier de travail", async () => {
    const { core, calls, call } = await rig(writes);
    expect((await call({ project: "absent", output: "o.mp4" })).content).toMatch(/pas un dossier/);
    expect((await call({ project: "clip", output: "o.exe" })).content).toMatch(/\.mp4/);
    expect((await call({ project: "clip", output: "..\\o.mp4" })).content).toMatch(/hors du dossier/);
    expect(calls).toEqual([]);
    await core.dispose();
  });

  it("annulation : le rendu en cours est coupé, la tâche est annulée, aucun artefact", async () => {
    const slow: Runner = (_f, _a, o) => new Promise((res) => o.signal?.addEventListener("abort", () => res({ code: null, stdout: "", stderr: "", aborted: true })));
    const { core, artifacts, tasks, call } = await rig(slow);
    const pending = call({ project: "clip", output: "out.mp4" });
    await new Promise((r) => setTimeout(r, 20));
    expect(tasks.list()[0]!.status).toBe("running");
    tasks.cancel(tasks.list()[0]!.id);
    expect((await pending).isError).toBe(true);
    expect(tasks.list()[0]!.status).toBe("cancelled");
    expect(artifacts.list()).toEqual([]);
    await core.dispose();
  });

  it("échec de la commande : erreur avec la fin de sa sortie ; sans ffprobe, la preuve est dite impossible", async () => {
    const { core, call } = await rig(async () => ({ code: 1, stdout: "", stderr: "Chrome introuvable" }));
    expect((await call({ project: "clip", output: "out.mp4" })).content).toMatch(/code 1.*Chrome introuvable/);
    await core.dispose();
    const noProbe = await rig(writes, { ffprobe: false });
    expect((await noProbe.call({ project: "clip", output: "out.webm" })).content).toMatch(/\[Vérification : impossible\] ffprobe absent/);
    await noProbe.core.dispose();
  });
});
