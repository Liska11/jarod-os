// Where the interface still speaks English only: for each .tsx under src/, the visible strings that do not go
// through the catalogue (JSX text, and title/label/placeholder/description/aria-label attributes), most first.
//   node scripts/i18n-report.mjs [--all]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const all = process.argv.includes('--all')
const TEXT = />\s*([A-Z][^<>{}]*[a-z][^<>{}]*?)\s*</g
const ATTR = /\b(?:title|label|placeholder|description|subtitle|aria-label|hint)="([^"]*[A-Za-z]{3,}[^"]*)"/g

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)

    return entry.isDirectory() ? walk(file) : entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [file] : []
  })
}

const rows = walk(root)
  .map(file => {
    const source = fs.readFileSync(file, 'utf8')
    const strings = [...source.matchAll(TEXT), ...source.matchAll(ATTR)]
      .map(match => match[1].trim())
      // The TEXT pattern reads `=> Promise<unknown>` arrows as a JSX text node, so the word
      // "Promise" shows up as an untranslated string in most async files. It is never visible.
      .filter(text => text.length > 1 && text !== 'Promise')

    return { file: path.relative(root, file).replaceAll('\\', '/'), count: strings.length, translated: /lib\/i18n\.ts'/.test(source), strings }
  })
  .filter(row => row.count > 0)
  .sort((a, b) => b.count - a.count)

const total = rows.reduce((sum, row) => sum + row.count, 0)
console.log(`${total} English-only strings in ${rows.length} files (files already using the catalogue are marked *).\n`)

for (const row of all ? rows : rows.slice(0, 40)) {
  console.log(`${String(row.count).padStart(4)}  ${row.translated ? '*' : ' '} ${row.file}`)
}
