// Portage de packages/core/test/llama-server.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { LlamaServerSupervisor, type SpawnedProcess } from "../src/llama-server.js";

/** Un faux processus qui se souvient d'avoir été tué — et rien d'autre. */
function fakeChild(pid = 4242) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const state = { pid, killed: [] as string[], didExit: false };
  const child: SpawnedProcess = {
    pid,
    kill: (signal) => {
      state.killed.push(signal ?? "SIGTERM");
      return true;
    },
    on: (event, listener) => {
      (listeners[event] ??= []).push(listener);
    },
  };
  return {
    child,
    state,
    exit: (code = 1) => {
      state.didExit = true;
      for (const l of listeners.exit ?? []) l(code);
    },
  };
}

function setup(opts: { answers?: boolean[]; bin?: string } = {}) {
  const answers = [...(opts.answers ?? [false, true])];
  const spawned: { bin: string; args: string[] }[] = [];
  const child = fakeChild();
  const supervisor = new LlamaServerSupervisor({
    spawn: (bin, args) => {
      spawned.push({ bin, args });
      return child.child;
    },
    probe: async () => answers.shift() ?? false,
    readinessTimeoutMs: 1_200,
    backoffMs: 10,
    maxRestarts: 1,
  });
  return { supervisor, spawned, child, bin: opts.bin ?? process.execPath };
}

describe("surveillance d'un serveur local", () => {
  it("refuse de démarrer sans chemin de binaire : on n'invente pas un chemin", async () => {
    const { supervisor } = setup();
    await expect(supervisor.start({ bin: "", model: "m.gguf", port: 8099 })).rejects.toThrow(/LLAMA_NO_BINARY/);
    // Refuser sans nommer de chemin EST le comportement : sur cette machine, le chemin n'est
    // même pas lisible, un « défaut » serait donc une invention.
    expect(supervisor.status().running).toBe(false);
  });

  it("refuse un binaire qui n'existe pas, et un modèle non nommé", async () => {
    const { supervisor } = setup({ bin: "C:/nulle-part/llama-server.exe" });
    await expect(
      supervisor.start({ bin: "C:/nulle-part/llama-server.exe", model: "m.gguf", port: 8099 }),
    ).rejects.toThrow(/LLAMA_BINARY_MISSING/);
    const other = setup().supervisor;
    await expect(other.start({ bin: process.execPath, model: "", port: 8099 })).rejects.toThrow(/LLAMA_NO_MODEL/);
  });

  it("démarre, attend que le port réponde, et se déclare prêt", async () => {
    const { supervisor, spawned } = setup({ answers: [false, false, true] });
    const state = await supervisor.start({ bin: process.execPath, model: "m.gguf", port: 8099, gpuLayers: 99 });
    expect(state).toMatchObject({ running: true, ready: true, port: 8099, model: "m.gguf", pid: 4242 });
    // argv construit sans shell, et le modèle vient de la configuration, pas d'une supposition.
    expect(spawned[0]?.args).toEqual(["-m", "m.gguf", "--port", "8099", "--host", "127.0.0.1", "-ngl", "99"]);
    await supervisor.stop();
  });

  it("sur un port déjà pris, il le DIT et n'adopte rien", async () => {
    const { supervisor, spawned } = setup({ answers: [true] });
    await expect(supervisor.start({ bin: process.execPath, model: "m.gguf", port: 8080 })).rejects.toThrow(
      /LLAMA_PORT_BUSY/,
    );
    // C'est le cas réel de cette machine : un serveur écoute déjà. S'approprier ce qu'on trouve
    // finit par tuer un travail qui n'est pas le sien.
    expect(spawned).toHaveLength(0);
    expect(supervisor.status().running).toBe(false);
  });

  it("arrête seulement l'enfant qu'il a lancé, et le dit quand il n'y en a pas", async () => {
    const { supervisor, child } = setup();
    expect(await supervisor.stop()).toBe(false);
    await supervisor.start({ bin: process.execPath, model: "m.gguf", port: 8099 });
    expect(await supervisor.stop()).toBe(true);
    expect(child.state.killed).toEqual(["SIGTERM"]);
    expect(supervisor.status().running).toBe(false);
  });

  it("si rien ne répond dans le délai, il ne laisse pas un processus à moitié vivant", async () => {
    const { supervisor, child } = setup({ answers: [false, false, false, false, false, false] });
    await expect(supervisor.start({ bin: process.execPath, model: "m.gguf", port: 8099 })).rejects.toThrow(
      /LLAMA_NOT_READY/,
    );
    expect(child.state.killed).toEqual(["SIGTERM"]);
    expect(supervisor.status().running).toBe(false);
  });

  it("un enfant mort avant d'être prêt est signalé, sans attente sans fin", async () => {
    const { supervisor, child } = setup({ answers: [false] });
    const started = supervisor.start({ bin: process.execPath, model: "m.gguf", port: 8099 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.exit(3);
    await expect(started).rejects.toThrow(/LLAMA_DIED|LLAMA_NOT_READY/);
  });
});

describe("arrêt avant un échange de modèle", () => {
  it("attend que l'ancien serveur ne réponde plus avant de rendre la main (sinon le suivant le prendrait pour un étranger)", async () => {
    const child = fakeChild();
    let alive = false;
    // Une fois tué, le serveur répond encore à trois sondes avant de se taire.
    let dying = 3;
    const s = new LlamaServerSupervisor({
      spawn: () => ((alive = true), child.child),
      probe: async () => (child.state.killed.length ? dying-- > 0 : alive),
    });
    await s.start({ bin: process.execPath, model: "m.gguf", port: 8099 });
    expect(s.status().ready).toBe(true);
    await s.stop();
    expect(child.state.killed).toEqual(["SIGTERM"]);
    expect(dying).toBe(-1);
    expect(s.status().running).toBe(false);
  });

  it("ne bloque pas au-delà de stopWaitMs si le port répond toujours", async () => {
    const child = fakeChild();
    let spawned = false;
    const s = new LlamaServerSupervisor({ spawn: () => ((spawned = true), child.child), probe: async () => spawned, stopWaitMs: 300 });
    spawned = false;
    await s.start({ bin: process.execPath, model: "m.gguf", port: 8099 });
    const t = Date.now();
    await s.stop();
    expect(Date.now() - t).toBeGreaterThanOrEqual(250);
    expect(Date.now() - t).toBeLessThan(3_000);
  });
});
