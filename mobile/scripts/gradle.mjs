// Runs the Android project's Gradle wrapper with the SDK this machine has, without touching any
// global setting: ANDROID_HOME / ANDROID_SDK_ROOT if set, else the usual per-user location.
// `node scripts/gradle.mjs assembleDebug` → android/app/build/outputs/apk/debug/app-debug.apk
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const android = join(dirname(fileURLToPath(import.meta.url)), '..', 'android')
const candidates = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  join(homedir(), 'Library', 'Android', 'sdk'),
  join(homedir(), 'Android', 'Sdk')
].filter(Boolean)
const sdk = candidates.find(dir => existsSync(join(dir, 'platforms')))
if (!sdk) {
  console.error(`Android SDK introuvable (cherché dans : ${candidates.join(', ')}). Voir docs/ANDROID-APP.md, « Construire l'APK ».`)
  process.exit(1)
}
// local.properties is git-ignored: it only says where the SDK is on this machine.
writeFileSync(join(android, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`)
const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
const run = spawnSync(wrapper, process.argv.slice(2), { cwd: android, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(run.status ?? 1)
