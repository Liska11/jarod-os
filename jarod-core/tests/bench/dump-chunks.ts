/**
 * Lecture locale d'une COPIE de profil : liste les documents indexés (passages, caractères) et, avec `--doc <fragment>`, imprime les passages de ce
 * document (`doc#ordre : début du texte`), pour écrire à la main des questions de test avec leurs cibles (jeu hors échantillon de la recherche
 * hybride). Ne modifie rien. Le texte reste sur la machine (sortie standard).
 *     tsx bench/dump-chunks.ts <dossier-profil-copie> [--doc <fragment de source>] [--chars 220] [--only 3,7,12]
 */
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (!dir) throw new Error("usage : tsx bench/dump-chunks.ts <dossier-profil-copie> [--doc <fragment>] [--chars n] [--only 1,2]");
  const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const doc = opt("--doc");
  const chars = Number(opt("--chars") ?? 220);
  const only = opt("--only")?.split(",").map(Number);
  const app = new JarodApp({ plugins: { storage: { dataDir: dir, cipher: electronSecretsCipher(electronUserDataDir(process.env)) } } } as never);
  const started = await start(app);
  try {
    const db = (app as unknown as { storage: { db: { all<T>(sql: string, ...p: unknown[]): T[] } } }).storage.db;
    if (!doc) {
      for (const r of db.all<{ doc_id: string; n: number; c: number }>("SELECT doc_id, count(*) AS n, sum(length(text)) AS c FROM rag_chunks GROUP BY doc_id ORDER BY doc_id")) console.log(`${r.doc_id}\t${r.n} passages\t${r.c} caractères`);
      return;
    }
    const rows = db.all<{ doc_id: string; ord: number; text: string }>("SELECT doc_id, ord, text FROM rag_chunks WHERE doc_id LIKE ? ORDER BY doc_id, ord", `%${doc}%`);
    for (const r of rows) if (!only || only.includes(r.ord)) console.log(`${r.doc_id}#${r.ord} : ${r.text.replace(/\s+/g, " ").slice(0, chars)}`);
  } finally {
    await stop(started);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
