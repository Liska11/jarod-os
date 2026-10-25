/**
 * Simulateurs : lecture des sorties de simctl et d'adb, et validation de la capture d'écran.
 */
import { describe, expect, it } from "vitest";
import { parseAdb, parseSimctl, screenshot } from "../src/simulator.js";

describe("parseSimctl", () => {
  it("garde les appareils disponibles, avec leur UDID et leur état", () => {
    const json = JSON.stringify({
      devices: {
        "iOS 18.2": [
          { name: "iPhone 16", udid: "AAAA-1", state: "Booted", isAvailable: true },
          { name: "iPad", udid: "BBBB-2", state: "Shutdown", isAvailable: false },
        ],
      },
    });
    expect(parseSimctl(json)).toEqual([{ platform: "ios", name: "iPhone 16", id: "AAAA-1", state: "Booted" }]);
  });
});

describe("parseAdb", () => {
  it("lit les appareils après l'en-tête, avec leur modèle", () => {
    const out = [
      "List of devices attached",
      "emulator-5554          device product:sdk_gphone model:Pixel_8 device:x transport_id:1",
      "R58M123ABC             offline",
      "",
    ].join("\n");
    expect(parseAdb(out)).toEqual([
      { platform: "android", name: "Pixel 8", id: "emulator-5554", state: "device" },
      { platform: "android", name: "R58M123ABC", id: "R58M123ABC", state: "offline" },
    ]);
  });
});

describe("screenshot", () => {
  it("refuse une plateforme inconnue, un chemin relatif ou non PNG, un identifiant suspect", async () => {
    await expect(screenshot({ platform: "windows" as never, out: "/tmp/a.png" })).rejects.toThrow(/plateforme inconnue/);
    await expect(screenshot({ platform: "ios", out: "relatif.png" })).rejects.toThrow(/absolu/);
    await expect(screenshot({ platform: "ios", out: "/tmp/a.jpg" })).rejects.toThrow(/absolu/);
    await expect(screenshot({ platform: "android", device: "x; rm", out: "/tmp/a.png" })).rejects.toThrow(/identifiant/);
  });
});
