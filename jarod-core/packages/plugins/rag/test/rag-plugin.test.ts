// plugin-rag : pièces jointes chiffrées avec la clé dérivée de la base (core.ts:341-342,369), coffre.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";

afterEach(cleanup);

describe("plugin-rag", () => {
  it("chiffre une pièce jointe sur disque et la relit en clair", async () => {
    const dataDir = tempDir();
    const app = await bootApp({ storage: { dataDir, keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
    const a = app.rag.attachments.save("note.txt", "text/plain", Buffer.from("secret de famille"));
    const files = readdirSync(join(dataDir, "attachments"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dataDir, "attachments", files[0]!)).includes(Buffer.from("secret de famille"))).toBe(false);
    expect(app.rag.attachments.read(a.id).toString()).toBe("secret de famille");
  });

  it("base en clair : pas de clé de fichiers, la pièce jointe se relit (comme Jarod-One)", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, llm: {}, rag: {} });
    expect(app.storage.fileKey).toBeNull();
    const a = app.rag.attachments.save("n.txt", "text/plain", Buffer.from("visible"));
    expect(app.rag.attachments.read(a.id).toString()).toBe("visible");
  });
});
