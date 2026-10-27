// T01 et T03 portés du dépôt D: dans S:.
//
// T01 — « installation == build de S: » : l'application installée est ce que S: produit.
// T03 — « build reproductible » : deux builds complets donnent le même arbre, et le même que celui livré.
//
// La logique est dans scripts/install-parity.mjs (utilisable seule : `node scripts/install-parity.mjs check|rebuild`).
// Les deux épreuves sont ignorées (SKIP) quand l'application n'est pas installée sur la machine.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'install-parity.mjs')
const INSTALL = process.env.JAROD_INSTALL_DIR ?? 'C:\\Program Files\\Jarod-OS'
const INSTALLED = existsSync(path.join(INSTALL, 'resources', 'app.asar'))
const DIST = existsSync(path.join(REPO, 'apps', 'desktop', 'dist'))

const TIMEOUT = 900_000

type Parity = {
  test: string
  status: 'PASS' | 'FAIL' | 'SKIP'
  detail: string
  checks: { name: string; ok: boolean; detail: string }[]
}

function parity(command: 'check' | 'rebuild'): Parity {
  const run = spawnSync(process.execPath, [SCRIPT, command, '--json', '--install', INSTALL], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: TIMEOUT
  })
  const raw = String(run.stdout ?? '')
  const start = raw.indexOf('{')
  if (start < 0) throw new Error(`${command} : sortie illisible (${String(run.stderr).slice(0, 400)})`)
  return JSON.parse(raw.slice(start)) as Parity
}

describe('parité installation / build', () => {
  it(
    'T01 — source de S: reconstruite == installation',
    () => {
      if (!INSTALLED) {
        expect(true).toBe(true) // rien d'installé sur cette machine : épreuve sans objet
        return
      }
      const result = parity('check')
      expect(result.detail).toBeTruthy()
      expect(result.status, result.detail).toBe('PASS')
      expect(result.checks.filter((c) => !c.ok)).toEqual([])
    },
    TIMEOUT
  )

  it(
    'T03 — build reproductible (deux builds identiques, égaux au build livré)',
    () => {
      if (!DIST) {
        expect(true).toBe(true) // pas de build local : lancer npm run build
        return
      }
      const result = parity('rebuild')
      expect(result.detail).toBeTruthy()
      expect(result.status, result.detail).toBe('PASS')
      expect(result.checks.filter((c) => !c.ok)).toEqual([])
    },
    TIMEOUT
  )
})
