/**
 * Journal JSONL borné : une ligne par appel, rotation à `maxBytes` (l'ancien fichier devient `<fichier>.1`, écrasé s'il existe — jamais
 * plus de deux fichiers). N'échoue jamais : un journal ne doit pas casser l'opération qu'il décrit.
 */
import { appendFileSync, renameSync, statSync } from "node:fs";

export function appendJsonl(file: string, entry: unknown, maxBytes: number): void {
  try {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      /* pas encore de fichier */
    }
    if (size >= maxBytes) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    /* journal impossible : silencieux, volontairement */
  }
}
