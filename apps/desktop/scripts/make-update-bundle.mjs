// Turns a built app folder (release/win-unpacked) into an update bundle for the A/B updater (V-21, contract c10-update-manifest):
// the files, `manifest.json` listing each one with its size and SHA-256, and `manifest.sig`.
//
//   node scripts/make-update-bundle.mjs --from release/win-unpacked --version 0.2.0 --out <empty folder>
//        [--entry Jarod-OS.exe] [--channel stable|edge] [--link] [--key <PEM private key, ECDSA P-256>]
//
// --link makes hard links instead of copies (same volume; the updater copies them into its slot anyway).
// --key signs with a PEM key: only for a test key made for a probe. The real key never comes here: without --key the script prints the
// cosign command that signs the manifest, which is a step reserved to the human or to CI (host-rust/docs/updater.md).
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PATH_RULE = /^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)*$/
const ENTRY_RULE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/
const VERSION_RULE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

function args(argv) {
  const out = { entry: 'Jarod-OS.exe', channel: 'stable', link: false }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${flag} attend une valeur`)
      return v
    }

    if (flag === '--from') out.from = value()
    else if (flag === '--version') out.version = value()
    else if (flag === '--out') out.out = value()
    else if (flag === '--entry') out.entry = value()
    else if (flag === '--channel') out.channel = value()
    else if (flag === '--key') out.key = value()
    else if (flag === '--link') out.link = true
    else throw new Error(`option inconnue : ${flag}`)
  }

  if (!out.from || !out.version || !out.out) throw new Error('--from, --version et --out sont obligatoires')
  if (!VERSION_RULE.test(out.version)) throw new Error(`version invalide : ${out.version} (majeure.mineure.correctif)`)
  if (!['stable', 'edge'].includes(out.channel)) throw new Error('--channel : stable ou edge')
  if (!ENTRY_RULE.test(out.entry)) throw new Error(`entrée invalide : ${out.entry}`)

  return out
}

function walk(root, dir = root, found = []) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)

    if (item.isSymbolicLink()) throw new Error(`lien refusé dans le dossier source : ${full}`)
    if (item.isDirectory()) walk(root, full, found)
    else found.push(path.relative(root, full).split(path.sep).join('/'))
  }

  return found
}

const sha256 = file =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })

export async function makeBundle(options) {
  const from = path.resolve(options.from)
  const out = path.resolve(options.out)

  if (existsSync(out) && readdirSync(out).length) throw new Error(`le dossier de sortie n’est pas vide : ${out}`)

  const files = walk(from).sort()
  const bad = files.filter(file => !PATH_RULE.test(file) || file.length > 240)
  if (bad.length) throw new Error(`${bad.length} chemin(s) hors du contrat c10, dont : ${bad.slice(0, 3).join(', ')}`)
  if (!files.includes(options.entry)) throw new Error(`l’entrée ${options.entry} n’est pas dans ${from}`)
  const lower = new Set()
  for (const file of files) {
    if (lower.has(file.toLowerCase())) throw new Error(`deux chemins ne diffèrent que par la casse : ${file}`)
    lower.add(file.toLowerCase())
  }

  const entries = []

  for (const file of files) {
    const source = path.join(from, ...file.split('/'))
    const target = path.join(out, ...file.split('/'))

    mkdirSync(path.dirname(target), { recursive: true })
    if (options.link) linkSync(source, target)
    else copyFileSync(source, target)
    entries.push({ path: file, sha256: await sha256(target), size: statSync(target).size })
  }

  const manifest = Buffer.from(
    `${JSON.stringify({ schema: 1, product: 'jarod-os', version: options.version, channel: options.channel, createdAt: new Date().toISOString(), entry: options.entry, files: entries }, null, 1)}\n`
  )

  writeFileSync(path.join(out, 'manifest.json'), manifest)

  if (options.key) {
    const key = createPrivateKey(readFileSync(options.key))
    writeFileSync(path.join(out, 'manifest.sig'), sign('sha256', manifest, key).toString('base64'))
  }

  return { out, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), signed: Boolean(options.key) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = args(process.argv.slice(2))
  const done = await makeBundle(options)

  console.log(`bundle ${options.version} : ${done.files} fichiers, ${(done.bytes / 1e6).toFixed(1)} Mo -> ${done.out}`)
  if (!done.signed) {
    console.log('Non signé. Pour le signer avec la clé de Jarod (action humaine ou CI) :')
    console.log(`  cosign sign-blob --key <clé cosign> --output-signature "${path.join(done.out, 'manifest.sig')}" "${path.join(done.out, 'manifest.json')}"`)
  }
}
