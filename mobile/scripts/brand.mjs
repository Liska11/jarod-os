// Draws the app's launcher icons and splash screens from the desktop's mark
// (apps/desktop/src/assets/brand/jarod-core-mark.webp): the glowing core on the app's night blue.
// The results are committed; run this again only when the mark changes. Needs ffmpeg on the PATH.
//   node scripts/brand.mjs
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mark = resolve(here, '../../apps/desktop/src/assets/brand/jarod-core-mark.webp')
const res = resolve(here, '../android/app/src/main/res')
/** `--bg` in src/styles.css; also `ic_launcher_background` and the splash colour in values/. */
const NIGHT = '0x050f33'

function draw(out, { width, height, markSize, background, round = false }) {
  const canvas = background ? `color=c=${background}:s=${width}x${height}` : `color=c=black@0.0:s=${width}x${height},format=rgba`
  const mask = round ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-W/2+0.5,Y-H/2+0.5),W/2),255,0)'` : ''
  const filter = `[1]scale=${markSize}:${markSize}:flags=lanczos[m];[0][m]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgba${mask}`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', canvas, '-i', mark, '-filter_complex', filter, '-frames:v', '1', join(res, out)])
}

// Launcher: 48 dp, and the adaptive icon's 108 dp foreground whose middle 66 dp is always visible.
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [d, k] of Object.entries(densities)) {
  const icon = Math.round(48 * k)
  const fg = Math.round(108 * k)
  draw(`mipmap-${d}/ic_launcher_foreground.png`, { width: fg, height: fg, markSize: Math.round(76 * k) })
  draw(`mipmap-${d}/ic_launcher.png`, { width: icon, height: icon, markSize: Math.round(44 * k), background: NIGHT })
  draw(`mipmap-${d}/ic_launcher_round.png`, { width: icon, height: icon, markSize: Math.round(42 * k), background: NIGHT, round: true })
}

// Splash before Android 12 (the window background): the mark in the middle of the night blue.
const splashes = {
  drawable: [480, 320],
  'drawable-land-mdpi': [480, 320],
  'drawable-land-hdpi': [800, 480],
  'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280],
  'drawable-port-mdpi': [320, 480],
  'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600],
  'drawable-port-xxxhdpi': [1280, 1920]
}
for (const [dir, [width, height]] of Object.entries(splashes)) {
  draw(`${dir}/splash.png`, { width, height, markSize: Math.round(Math.min(width, height) * 0.45), background: NIGHT })
}
console.log('Icons and splash screens drawn in', res)
