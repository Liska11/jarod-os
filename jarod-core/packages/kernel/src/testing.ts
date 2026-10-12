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

/** Démarre un kernel avec les plugins donnés ; libéré par `cleanup()`. */
export async function bootApp(plugins: Record<string, Record<string, unknown> | false>): Promise<JarodApp & { started: Started }> {
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
