// Diagnostic LECTURE SEULE du profil réel (application fermée) : tables, messages d'une plage horaire, réglages de l'agent.
//   ../../node_modules/.bin/tsx src/diag-profile.ts tables
//   ../../node_modules/.bin/tsx src/diag-profile.ts messages <début ISO> <fin ISO>
//   ../../node_modules/.bin/tsx src/diag-profile.ts settings
// Ne pose aucun réglage et n'écrit rien (seul le démarrage du noyau, comme pour wire-reranker). Les messages sont lus tels quels, en local.
import { homedir } from "node:os";
import { join } from "node:path";
import { JarodApp, start, stop } from "@jarod/kernel";
import { ProfileManager } from "@jarod/plugin-persona";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";

type Db = { all<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T[] };
type Settings = { get(k: string): unknown };

async function main(): Promise<void> {
  const [mode, a, b] = process.argv.slice(2);
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const root = process.env.JAROD_HOME ?? join(appData, "Jarod-One", "data");
  const dir = new ProfileManager(root).dirFor("default");
  const app = new JarodApp({ plugins: { storage: { dataDir: dir, cipher: electronSecretsCipher(electronUserDataDir(process.env)) } } } as never);
  const started = await start(app);
  try {
    const st = (app as unknown as { storage: { db: Db; settings: Settings } }).storage;
    if (mode === "tables") {
      for (const r of st.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")) {
        const n = st.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM "${r.name}"`)[0]?.n;
        console.log(`${r.name}\t${n}`);
      }
    } else if (mode === "messages") {
      const cols = st.db.all<{ name: string }>("PRAGMA table_info(messages)").map((c) => c.name);
      console.log(`colonnes : ${cols.join(", ")}`);
      const tcol = cols.includes("at") ? "at" : cols.includes("created_at") ? "created_at" : cols[0]!;
      const rows = st.db.all(`SELECT * FROM messages WHERE ${tcol} >= ? AND ${tcol} <= ? ORDER BY ${tcol}`, Date.parse(a!), Date.parse(b!));
      for (const r of rows) console.log(JSON.stringify(r).slice(0, 1500));
    } else if (mode === "settings") {
      for (const k of ["agent", "chat", "tools", "rag", "ecosystem"]) {
        try {
          console.log(`${k} : ${JSON.stringify(st.settings.get(k))}`);
        } catch (e) {
          console.log(`${k} : (illisible : ${(e as Error).message})`);
        }
      }
    }
  } finally {
    await stop(started);
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
