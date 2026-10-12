/**
 * Boot headless : `pnpm start -- <dataDir>` (défaut `.work/profile`). Démarre storage + scheduler,
 * affiche l'état, s'arrête proprement sur SIGINT/SIGTERM.
 */
import { resolve } from "node:path";
import { JarodApp } from "./app.js";
import { start, stop } from "./lifecycle.js";

const dataDir = resolve(process.argv[2] ?? ".work/profile");
const app = new JarodApp({ plugins: { storage: { dataDir }, scheduler: {} } });
const started = await start(app);
const ctx = app as unknown as { storage: { db: { encrypted: boolean } }; scheduler: { list(): unknown[] } };
console.log(
  JSON.stringify({
    ready: true,
    plugins: started.loaded.map((p) => p.name),
    encrypted: ctx.storage.db.encrypted,
    schedules: ctx.scheduler.list().length,
  }),
);
const shutdown = async () => {
  await stop(started);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
if (process.env.JAROD_EXIT_AFTER_BOOT) await shutdown();
