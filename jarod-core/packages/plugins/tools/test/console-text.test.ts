// Portage de packages/core/test/console-text.test.ts (rév. 2e180305).
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ConsoleDecoder, decodeConsoleOutput } from "../src/console-text.js";
import { runShell } from "../src/builtin.js";

/** « exécutable » as cmd.exe writes it on a French Windows (code page 850): é is the byte 0x82. */
const CP850 = Buffer.from([0x65, 0x78, 0x82, 0x63, 0x75, 0x74, 0x61, 0x62, 0x6c, 0x65]);

describe("la sortie d'un programme console", () => {
  it("garde l'UTF-8 tel quel", () => {
    expect(decodeConsoleOutput(Buffer.from("exécutable — ✓", "utf8"), 850)).toBe("exécutable — ✓");
  });

  it("lit la page de codes OEM quand ce n'est pas de l'UTF-8", () => {
    expect(decodeConsoleOutput(CP850, 850)).toBe("exécutable");
    expect(decodeConsoleOutput(Buffer.from([0x82, 0x85, 0x87]), 437)).toBe("éàç");
    expect(decodeConsoleOutput(Buffer.from([0xd5]), 858)).toBe("€");
  });

  it("sans page connue, retombe sur l'UTF-8 plutôt que d'inventer", () => {
    expect(decodeConsoleOutput(CP850, null)).toBe("ex�cutable");
  });

  it("par morceaux : un caractère UTF-8 coupé en deux attend sa fin", () => {
    const bytes = Buffer.from("été", "utf8");
    const decoder = new ConsoleDecoder(850);
    const text = decoder.write(bytes.subarray(0, 1)) + decoder.write(bytes.subarray(1)) + decoder.end();
    expect(text).toBe("été");
  });

  it("par morceaux : un morceau OEM est lu comme tel, et le suivant en UTF-8 aussi", () => {
    const decoder = new ConsoleDecoder(850);
    expect(decoder.write(CP850)).toBe("exécutable");
    expect(decoder.write(Buffer.from(" été", "utf8"))).toBe(" été");
  });
});

describe.runIf(process.platform === "win32")("run_shell sous Windows", () => {
  it("rend lisibles les messages de cmd.exe", async () => {
    // Le message d'erreur de cmd lui-même, dans la langue et la page de codes de la machine.
    const brut = spawnSync("commande_qui_n_existe_pas", { shell: true, windowsHide: true }).stderr;
    const attendu = decodeConsoleOutput(brut);
    const { output } = await runShell("commande_qui_n_existe_pas", process.cwd());
    expect(output).toContain(attendu.trim().split(/\r?\n/)[0]);
    expect(output).not.toContain("�");
  });
});
