// Compile la passerelle de Jarod-OS en UN fichier JavaScript lançable par `node`, sans TypeScript ni découverte de dossiers à l'exécution.
//   node scripts/bundle-gateway.mjs --out <dossier>
//
// Sortie : <dossier>/gateway.mjs (le noyau et tous les plugins), les fichiers de travail JavaScript simples que certains plugins lancent à côté
// (wakeword-worker.cjs, runner.cjs), et <dossier>/node_modules avec les modules NATIFS (SQLite chiffré) copiés avec leurs dépendances.
//
// Pas embarqué (consigné dans WINDOWS-PORT-NOTES.md) : les workers d'embeddings et de reranker (ils lancent du TypeScript par tsx et OpenVINO), onnxruntime-node et
// openvino. Les fonctions qui en dépendent ne sont pas disponibles dans l'application installée.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
if (outIndex < 0 || !process.argv[outIndex + 1]) {
  console.error("usage : node scripts/bundle-gateway.mjs --out <dossier>");
  process.exit(2);
}
const out = resolve(process.argv[outIndex + 1]);

/** Modules natifs ou trop lourds : jamais compilés dans le fichier. Les deux premiers sont copiés dans <out>/node_modules ; les autres sont absents. */
const COPIED_NATIVE = ["better-sqlite3-multiple-ciphers"];
const ABSENT = ["openvino-node", "openvino-genai-node", "onnxruntime-node", "node-pty", "electron"];

// 1. Les plugins, déclarés statiquement (le noyau n'a plus de dossier à lire).
const pluginsDir = join(root, "packages", "plugins");
const plugins = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(pluginsDir, d.name, "package.json")))
  .map((d) => ({ dir: d.name, pkg: JSON.parse(readFileSync(join(pluginsDir, d.name, "package.json"), "utf8")) }))
  .filter((p) => p.pkg.jarod?.plugin)
  .map((p) => ({ dir: p.dir, name: p.pkg.jarod.plugin, pkg: p.pkg.name, order: p.pkg.jarod.order ?? 100, entry: join(pluginsDir, p.dir, "src", "index.ts") }));
const slash = (p) => p.split("\\").join("/");
const entrySource = [
  // Premier : les variables encore posées sous leur ancien nom sont adoptées avant que les plugins ne lisent process.env (renommage, phase 2).
  `import "@jarod/kernel/legacy-env-adopt";`,
  `import { setBundledPlugins } from "@jarod/kernel";`,
  ...plugins.map((p, i) => `import * as plugin${i} from ${JSON.stringify(slash(p.entry))};`),
  `setBundledPlugins([`,
  ...plugins.map((p, i) => `  { name: ${JSON.stringify(p.name)}, pkg: ${JSON.stringify(p.pkg)}, order: ${p.order}, entry: "(empaqueté)", module: plugin${i} },`),
  `]);`,
  `await import(${JSON.stringify(slash(join(root, "packages", "cli", "src", "gateway", "main.ts")))});`,
].join("\n");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
  stdin: { contents: entrySource, resolveDir: join(root, "packages", "cli"), sourcefile: "bundle-entry.mjs", loader: "js" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: join(out, "gateway.mjs"),
  external: [...COPIED_NATIVE, ...ABSENT],
  banner: { js: `import { createRequire as __jarodCreateRequire } from "node:module"; const require = __jarodCreateRequire(import.meta.url);` },
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
  // Les chemins du métafichier sont relatifs à ce dossier, quel que soit le dossier d'où le script est lancé.
  absWorkingDir: root,
});
const size = statSync(join(out, "gateway.mjs")).size;

// 2. Les fichiers de travail JavaScript simples, à côté du fichier compilé (les plugins les trouvent par `import.meta.url`).
const WORKERS = [
  ["voice", "wakeword-worker.cjs"],
  ["workflows", "runner.cjs"],
];
for (const [plugin, file] of WORKERS) cpSync(join(pluginsDir, plugin, "src", file), join(out, file));

// 3. Les modules natifs, avec leurs dépendances, tels que pnpm les a installés pour CETTE version de Node.
const copied = new Set();
function copyPackage(name, fromDir) {
  const req = createRequire(join(fromDir, "noop.js"));
  const manifestPath = req.resolve(`${name}/package.json`);
  const dir = dirname(manifestPath);
  if (copied.has(dir)) return;
  copied.add(dir);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const target = join(out, "node_modules", name);
  cpSync(dir, target, {
    recursive: true,
    // Les sources C de SQLite (plusieurs dizaines de Mo) ne servent plus une fois le module compilé.
    filter: (src) => {
      const rel = src.slice(dir.length);
      if (/[\\/](deps|src|docs|test|tests|build)[\\/]/.test(rel + "/") || /\.(cc|cpp|h|c|gyp|obj|pdb|lib|exp|ilk)$/.test(src)) return false;
      // `prebuilds/<plateforme>-<arch>.node` : seul celui de la machine qui compile sert (le module est natif, donc propre à la plateforme).
      const prebuilt = /[\\/]prebuilds[\\/]([a-z0-9]+-[a-z0-9]+)\.node$/.exec(src);
      return !prebuilt || prebuilt[1] === `${process.platform}-${process.arch}`;
    },
  });
  for (const dep of Object.keys(manifest.dependencies ?? {})) copyPackage(dep, dir);
}
for (const name of COPIED_NATIVE) copyPackage(name, join(pluginsDir, "storage"));

const nativeFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".node")) nativeFiles.push(p);
  }
})(join(out, "node_modules"));

// 4. Les paquets npm compilés DANS gateway.mjs, lus dans le métafichier d'esbuild : Syft ne peut pas les voir dans un fichier groupé (G1, SBOM).
const bundled = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const p = slash(input);
  const at = p.lastIndexOf("node_modules/");
  if (at < 0) continue;
  const rest = p.slice(at + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const dir = resolve(root, p.slice(0, at + "node_modules/".length) + name);
  if (bundled.has(dir)) continue;
  try {
    const m = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    bundled.set(dir, { name: m.name ?? name, version: m.version ?? "", ...(typeof m.license === "string" ? { license: m.license } : {}) });
  } catch {
    bundled.set(dir, { name, version: "" });
  }
}
const packages = [...new Map([...bundled.values()].map((x) => [`${x.name}@${x.version}`, x])).values()].sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(
  join(out, "BUNDLE.json"),
  JSON.stringify({ node: process.version, plugins: plugins.map((p) => p.name), gatewayBytes: size, native: nativeFiles.map((f) => f.slice(out.length + 1)), inputs: Object.keys(result.metafile.inputs).length, packages }, null, 2),
);
console.log(`gateway.mjs ${(size / 1048576).toFixed(1)} Mo, ${plugins.length} plugins, ${nativeFiles.length} module(s) natif(s) : ${nativeFiles.map((f) => f.slice(out.length + 1)).join(", ")}`);
