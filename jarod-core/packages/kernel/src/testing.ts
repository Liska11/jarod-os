/**
 * Coutures de test partagées : un kernel réel (vrais plugins, vraie base) sur un dossier temporaire,
 * libéré après chaque test. Portage de `packages/core/test/helpers.ts` (makeCore → kernel cordis).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JarodApp } from "./app.js";
import { type Started, start, stop } from "./lifecycle.js";

export { discoverPlugins } from "./registry.js";

const dirs: string[] = [];
const running: Started[] = [];

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "jarod-test-"));
  dirs.push(d);
  return d;
}

/**
 * V-07 : l'analyseur de la quarantaine des kernels de test — « propre », déterministe, sans Defender (absent sous Linux et macOS, et lent à
 * l'échelle de mille tests). Un test qui veut un autre verdict passe son propre `scanner` ; Defender réel : plugins/quarantine/test/admit.test.ts.
 */
const TEST_SCANNER = { scan: () => ({ verdict: "clean", scanner: "test" }) };

/** Démarre un kernel avec les plugins donnés ; libéré par `cleanup()`. */
export async function bootApp(plugins: Record<string, Record<string, unknown> | false>): Promise<JarodApp & { started: Started }> {
  const quarantine = plugins.quarantine;
  if (quarantine && !("scanner" in quarantine)) plugins = { ...plugins, quarantine: { ...quarantine, scanner: TEST_SCANNER } };
  const app = new JarodApp({ plugins });
  const started = await start(app);
  running.push(started);
  return Object.assign(app, { started });
}

/** Arrête un kernel démarré par `bootApp` (idempotent). */
export async function shutdown(app: { started: Started }): Promise<void> {
  const i = running.indexOf(app.started);
  if (i >= 0) running.splice(i, 1);
  await stop(app.started);
}

export async function cleanup(): Promise<void> {
  for (const s of running.splice(0)) await stop(s).catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
