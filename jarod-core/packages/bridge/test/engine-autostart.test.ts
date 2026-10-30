// Q0 (analyse du 29/10, lacune L1) : la passerelle du bureau lance le moteur local au démarrage quand `localEngine.autoStart` est vrai.
// `autoStartLocalEngine` ne rejette jamais, journalise l'état RÉEL et garde les trois gardes de `jarod serve`.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { autoStartLocalEngine } from "../src/index.js";

function fakeEngine(o: { autoStart: boolean; fails?: boolean }) {
  let running = false;
  let starts = 0;
  return {
    get starts() {
      return starts;
    },
    engine: {
      config: () =>
        ({ autoStart: o.autoStart, installed: { bin: "llama-server" }, activePreset: "p1", port: 8080, presets: [{ id: "p1", name: "LFM3-1.7B-Q8_0" }] }) as never,
      start: async () => {
        starts++;
        if (o.fails) throw new Error("modèle introuvable");
        running = true;
        return {} as never;
      },
      running: () => running,
    },
  };
}

const realRoot = join("D:", "Jarod-OS", "data");

describe("Q0 autoStartLocalEngine (passerelle du bureau)", () => {
  it("démarre le préréglage actif et annonce l'état réel", async () => {
    const f = fakeEngine({ autoStart: true });
    const lines: string[] = [];
    await autoStartLocalEngine({ dataRoot: realRoot, localEngine: { engine: f.engine } }, {}, (l) => lines.push(l), join(tmpdir(), "x"));
    expect(f.starts).toBe(1);
    expect(lines.at(-1)).toContain("actif (port 8080, préréglage « LFM3-1.7B-Q8_0 »)");
  });

  it("ne démarre rien quand le démarrage automatique n'est pas demandé", async () => {
    const f = fakeEngine({ autoStart: false });
    const lines: string[] = [];
    await autoStartLocalEngine({ dataRoot: realRoot, localEngine: { engine: f.engine } }, {}, (l) => lines.push(l), join(tmpdir(), "x"));
    expect(f.starts).toBe(0);
  });

  it("jamais en mode test", async () => {
    const f = fakeEngine({ autoStart: true });
    const lines: string[] = [];
    await autoStartLocalEngine({ dataRoot: realRoot, localEngine: { engine: f.engine } }, { JAROD_TEST_MODE: "1" }, (l) => lines.push(l), join(tmpdir(), "x"));
    expect(f.starts).toBe(0);
    expect(lines.at(-1)).toContain("mode test");
  });

  it("un échec n'est jamais fatal : la promesse se résout et l'échec est journalisé", async () => {
    const f = fakeEngine({ autoStart: true, fails: true });
    const lines: string[] = [];
    await expect(autoStartLocalEngine({ dataRoot: realRoot, localEngine: { engine: f.engine } }, {}, (l) => lines.push(l), join(tmpdir(), "x"))).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("modèle introuvable");
    expect(lines.at(-1)).toContain("continue sans moteur local");
  });
});
