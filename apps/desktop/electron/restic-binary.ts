import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * G4 : où trouver restic.exe — JAROD_RESTIC, sinon JAROD_ENGINES_DIR\restic, sinon le dossier `engines` du dépôt (application lancée depuis
 * les sources : `app.getAppPath()` = apps/desktop), sinon `resources\restic` d'un paquet. Null s'il n'est nulle part : l'écran le dit.
 */
export function resticBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.JAROD_RESTIC,
    env.JAROD_ENGINES_DIR && path.join(env.JAROD_ENGINES_DIR, 'restic', 'restic.exe'),
    path.join(app.getAppPath(), '..', '..', 'engines', 'restic', 'restic.exe'),
    process.resourcesPath && path.join(process.resourcesPath, 'restic', 'restic.exe')
  ].filter((c): c is string => Boolean(c))

  return candidates.find(c => fs.existsSync(c)) ?? null
}
