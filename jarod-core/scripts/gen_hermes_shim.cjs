/**
 * Génère le shim `window.hermesAPI` (W8) depuis le preload SANK-UI (lecture seule, MIT).
 *
 *     node scripts/gen_hermes_shim.cjs [chemin SANK-UI, défaut S:/SANK-UI]
 *
 * Portage mécanique, corps d'origine conservés : seuls les appels Electron changent de guichet.
 *   - `ipcRenderer.invoke(c, …)`                          → `oneai.invoke(c, …)`
 *   - `ipcRenderer.on(c, h); return () => ipcRenderer.removeListener(c, h);` → `return oneai.on(c, h);`
 *     (et le 1er paramètre `_event: Electron.IpcRendererEvent` du gestionnaire disparaît : `oneai.on`
 *     ne transmet que la charge utile)
 *   - `ipcRenderer.send(c, …);`                           → `void oneai.invoke(c, …);`
 *   - `webUtils.getPathForFile(f)`                        → `oneai.host.getPathForFile(f)`
 * Toute autre forme fait ÉCHOUER la génération (jamais de portage approximatif silencieux).
 *
 * Sorties : packages/contracts/src/ipc-hermes-channels.ts (allowlists),
 * packages/desktop/src/renderer/hermes-api.ts (shim + manifeste méthode → canal) et (D1)
 * packages/desktop/src/sank/src/preload/index.d.ts : le CONTRAT DE TYPE du renderer SANK-UI (son
 * `tsconfig.web.json` vérifie les écrans contre cette déclaration écrite à la main, pas contre l'implémentation
 * du preload) — copie verbatim à la même place relative (ses imports `../shared/*` restent valides), fins de
 * ligne LF ; seul le fichier d'origine non modifié dans l'arbre SANK-UI est accepté.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SANK = (process.argv[2] ?? "S:/SANK-UI").replace(/\\/g, "/");
const ROOT = path.resolve(__dirname, "..");
const ts = require(path.join(SANK, "node_modules/typescript"));
const FILE = path.join(SANK, "src/preload/index.ts");
const REV = execFileSync("git", ["-C", SANK, "rev-parse", "--short", "HEAD"]).toString().trim();
// Fins de ligne normalisées (le preload SANK-UI mêle CRLF et LF ; le dépôt est en LF).
const text = fs.readFileSync(FILE, "utf8").replace(/\r\n?/g, "\n");
const sf = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true);
const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
const fail = (msg, node) => {
  throw new Error(`${msg}${node ? ` (index.ts:${lineOf(node.getStart())})` : ""}`);
};

// ── Repérage ─────────────────────────────────────────────────────────────────────────────────────
let hermes, electronApi;
const localTypes = [];
const opaque = [];
for (const st of sf.statements) {
  if (ts.isImportDeclaration(st)) {
    const from = st.moduleSpecifier.text;
    if (from === "electron") continue;
    if (!st.importClause?.isTypeOnly) fail(`import non type-only : ${from}`, st);
    for (const el of st.importClause.namedBindings.elements) opaque.push({ name: el.name.text, from });
  } else if (ts.isInterfaceDeclaration(st)) {
    localTypes.push(st);
  } else if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) {
      if (d.name.getText() === "hermesAPI") hermes = d;
      if (d.name.getText() === "electronAPI") electronApi = d;
    }
  }
}
if (!hermes || !ts.isObjectLiteralExpression(hermes.initializer)) fail("objet hermesAPI introuvable");

// ── Types partagés de SANK-UI (dette D1) ─────────────────────────────────────────────────────────
// Chaque type importé par le preload est repris VERBATIM de `src/shared/*`, avec les types dont il
// dépend (même module, ou `import` d'un autre module partagé). Un type qui dépend d'une VALEUR
// (`typeof X`, constante, enum) ou d'un module hors `src/shared` fait échouer la génération.
const SHARED = path.join(SANK, "src/shared").replace(/\\/g, "/");
const modules = new Map();
function loadModule(spec, fromFile) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const file = [`${base}.ts`, path.join(base, "index.ts")].find((c) => fs.existsSync(c));
  if (!file) fail(`module partagé introuvable : ${spec}`);
  if (!file.replace(/\\/g, "/").startsWith(`${SHARED}/`)) fail(`type hors src/shared : ${spec}`);
  if (modules.has(file)) return modules.get(file);
  const t = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  const msf = ts.createSourceFile(file, t, ts.ScriptTarget.Latest, true);
  const m = { file, rel: path.relative(path.join(SANK, "src"), file).replace(/\\/g, "/"), text: t, decls: new Map(), values: new Set(), imports: new Map() };
  for (const st of msf.statements) {
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) m.decls.set(st.name.text, st);
    else if (ts.isImportDeclaration(st)) {
      for (const el of st.importClause?.namedBindings?.elements ?? []) {
        m.imports.set(el.name.text, { from: st.moduleSpecifier.text, name: (el.propertyName ?? el.name).text });
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        m.values.add(d.name.getText());
        // `const X = "littéral"` (éventuellement `as const`) : seule valeur admise, pour `typeof X`.
        let init = d.initializer;
        if (init && ts.isAsExpression(init) && init.type.getText() === "const") init = init.expression;
        const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
        if (isConst && init && (ts.isStringLiteral(init) || ts.isNumericLiteral(init) || init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword)) {
          m.literals ??= new Map();
          m.literals.set(d.name.getText(), init.getText());
        }
      }
    }
    else if ((ts.isFunctionDeclaration(st) || ts.isEnumDeclaration(st) || ts.isClassDeclaration(st)) && st.name) m.values.add(st.name.text);
  }
  modules.set(file, m);
  return m;
}
const sharedTypes = new Map(); // nom → { rel, text }
function needType(m, name) {
  const im = m.imports.get(name);
  if (im) {
    if (im.name !== name) fail(`import renommé non pris en charge : ${im.name} as ${name} (${m.rel})`);
    return needType(loadModule(im.from, m.file), name);
  }
  const d = m.decls.get(name);
  if (!d) fail(`type ${name} introuvable dans ${m.rel}${m.values.has(name) ? " (c'est une valeur)" : ""}`);
  const seen = sharedTypes.get(name);
  if (seen) {
    if (seen.rel !== m.rel) fail(`type ${name} défini deux fois (${seen.rel}, ${m.rel})`);
    return;
  }
  let declText = m.text.slice(d.getFullStart(), d.getEnd()).replace(/^\n+/, "");
  if (!d.modifiers?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword)) {
    declText = declText.replace(/^((?:\s*\/\*[\s\S]*?\*\/\s*|\s*\/\/[^\n]*\n)*)(\s*)/, `$1$2export `);
  }
  sharedTypes.set(name, { rel: m.rel, text: declText });
  const params = new Set((d.typeParameters ?? []).map((p) => p.name.text));
  d.forEachChild(function walk(n) {
    if (ts.isTypeQueryNode(n)) {
      const v = n.exprName.getText();
      const lit = m.literals?.get(v);
      if (lit === undefined) fail(`\`typeof ${v}\` dans ${name} (${m.rel}) : dépend d'une valeur non littérale`);
      const seenV = sharedTypes.get(v);
      if (seenV && seenV.rel !== m.rel) fail(`nom ${v} défini deux fois (${seenV.rel}, ${m.rel})`);
      // Type seul : aucune valeur à l'exécution, le même littéral pour `typeof`.
      if (!seenV) sharedTypes.set(v, { rel: m.rel, text: `export declare const ${v}: ${lit};` });
      return;
    }
    let id = null;
    if (ts.isTypeReferenceNode(n)) id = n.typeName.getText().split(".")[0];
    else if (ts.isExpressionWithTypeArguments(n)) id = n.expression.getText().split(".")[0];
    if (id && !params.has(id)) {
      if (m.decls.has(id) || m.imports.has(id)) needType(m, id);
      else if (m.values.has(id)) fail(`${name} (${m.rel}) dépend de la valeur ${id}`);
    }
    n.forEachChild(walk);
  });
}
for (const o of opaque) needType(loadModule(o.from, FILE), o.name);
for (const d of localTypes) if (sharedTypes.has(d.name.text)) fail(`type local du preload en conflit avec un type partagé : ${d.name.text}`);

// ── Réécriture ───────────────────────────────────────────────────────────────────────────────────
const obj = hermes.initializer;
const edits = []; // [start, end, replacement]
const manifest = [];
const str = (n) => (ts.isStringLiteral(n) ? n.text : fail("canal non littéral", n));

for (const prop of obj.properties) {
  const name = prop.name?.getText() ?? fail("propriété sans nom", prop);
  const found = { invoke: [], on: [], removeListener: [], send: [], webUtils: [] };
  prop.forEachChild(function walk(n) {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText();
      const m = /^ipcRenderer\.(invoke|on|removeListener|send)$/.exec(callee);
      if (m) found[m[1]].push(n);
      else if (callee === "webUtils.getPathForFile") found.webUtils.push(n);
      else if (/^(ipcRenderer|webUtils|contextBridge)\b/.test(callee)) fail(`appel Electron inattendu ${callee}`, n);
    }
    n.forEachChild(walk);
  });
  const fn = prop.initializer;
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) fail(`${name} n'est pas une fonction`, prop);
  const params = fn.parameters.map((p) => p.name.getText());

  if (found.invoke.length === 1 && !found.on.length && !found.send.length && !found.webUtils.length) {
    const call = found.invoke[0];
    const [ch, ...args] = call.arguments;
    const argNames = args.map((a) => a.getText());
    manifest.push({ name, kind: "invoke", channel: str(ch), passthrough: argNames.join() === params.join() });
    edits.push([call.expression.getStart(), call.expression.getEnd(), "oneai.invoke"]);
  } else if (found.on.length === 1 && found.removeListener.length === 1 && !found.invoke.length) {
    const on = found.on[0];
    const off = found.removeListener[0];
    const onStmt = on.parent;
    const ret = off.parent?.parent; // () => ipcRenderer.removeListener(…) ; return …
    if (!ts.isExpressionStatement(onStmt) || !ret || !ts.isReturnStatement(ret)) fail(`${name} : forme on/removeListener inattendue`, on);
    const [ch, h] = on.arguments;
    const [ch2, h2] = off.arguments;
    if (str(ch) !== str(ch2) || h.getText() !== h2.getText()) fail(`${name} : on/removeListener désaccordés`, on);
    const block = onStmt.parent;
    const idx = block.statements.indexOf(onStmt);
    if (block.statements[idx + 1] !== ret) fail(`${name} : return attendu juste après on()`, on);
    edits.push([onStmt.getStart(), ret.getEnd(), `return oneai.on(${ch.getText()}, ${h.getText()});`]);
    // Le gestionnaire perd son `_event` : `oneai.on` ne transmet que la charge utile.
    const decl = block.statements
      .filter(ts.isVariableStatement)
      .flatMap((v) => v.declarationList.declarations)
      .find((d) => d.name.getText() === h.getText());
    if (!decl || !ts.isArrowFunction(decl.initializer)) fail(`${name} : gestionnaire ${h.getText()} introuvable`, on);
    const hp = decl.initializer.parameters;
    let arity = hp.length;
    if (hp[0] && /IpcRendererEvent/.test(hp[0].getText())) {
      edits.push([hp[0].getStart(), hp[1] ? hp[1].getStart() : hp[0].getEnd(), ""]);
      arity -= 1;
    } else if (hp.length) fail(`${name} : 1er paramètre du gestionnaire n'est pas l'événement IPC`, hp[0]);
    manifest.push({ name, kind: "event", channel: str(ch), arity });
  } else if (found.send.length === 1 && !found.invoke.length && !found.on.length) {
    const call = found.send[0];
    const stmt = call.parent;
    if (!ts.isExpressionStatement(stmt)) fail(`${name} : send hors instruction`, call);
    edits.push([call.expression.getStart(), call.expression.getEnd(), "void oneai.invoke"]);
    const args = call.arguments.slice(1).map((a) => a.getText());
    manifest.push({ name, kind: "send", channel: str(call.arguments[0]), passthrough: args.join() === params.join() });
  } else if (found.webUtils.length === 1 && !found.invoke.length && !found.on.length && !found.send.length) {
    const call = found.webUtils[0];
    edits.push([call.expression.getStart(), call.expression.getEnd(), "oneai.host.getPathForFile"]);
    manifest.push({ name, kind: "host" });
  } else {
    fail(`${name} : combinaison d'appels non prise en charge ${JSON.stringify(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length])))}`, prop);
  }
}

let body = text.slice(obj.getStart(), obj.getEnd());
const base = obj.getStart();
for (const [s, e, r] of edits.sort((a, b) => b[0] - a[0])) body = body.slice(0, s - base) + r + body.slice(e - base);
for (const bad of ["ipcRenderer", "webUtils", "Electron.", "contextBridge"]) {
  if (body.includes(bad)) fail(`reste « ${bad} » après réécriture`);
}

// ── Sorties ──────────────────────────────────────────────────────────────────────────────────────
const uniq = (xs) => [...new Set(xs)];
const invokeChannels = uniq(manifest.filter((m) => m.kind === "invoke" || m.kind === "send").map((m) => m.channel));
const eventChannels = uniq(manifest.filter((m) => m.kind === "event").map((m) => m.channel));
for (const c of eventChannels) if (invokeChannels.includes(c)) fail(`canal à la fois invoke et event : ${c}`);
const counts = manifest.reduce((acc, m) => ((acc[m.kind] = (acc[m.kind] ?? 0) + 1), acc), {});
const src = `S:\\SANK-UI\\src\\preload\\index.ts:${lineOf(hermes.getStart())}-${lineOf(hermes.getEnd())} (rév. ${REV}, MIT © github.com/fathah)`;
const banner = `// GÉNÉRÉ par scripts/gen_hermes_shim.cjs depuis ${src}. Ne pas éditer à la main.`;
const list = (xs) => xs.map((c) => `  ${JSON.stringify(c)},`).join("\n");

fs.writeFileSync(
  path.join(ROOT, "packages/contracts/src/ipc-hermes-channels.ts"),
  `${banner}
/** Canaux request/response de la surface \`hermesAPI\` (${invokeChannels.length}) — invoke + l'unique \`send\` (servi en invoke). */
export const HERMES_INVOKE_CHANNELS = [
${list(invokeChannels)}
] as const;

/** Canaux poussés main → renderer de la surface \`hermesAPI\` (${eventChannels.length}). */
export const HERMES_EVENT_CHANNELS = [
${list(eventChannels)}
] as const;
`,
  { encoding: "utf8" },
);

// Types partagés : un fichier de @jarod/contracts, groupé par module d'origine, dans l'ordre de découverte.
const byModule = new Map();
for (const [, t] of sharedTypes) byModule.set(t.rel, [...(byModule.get(t.rel) ?? []), t.text]);
const sharedSrc = `S:\\SANK-UI\\src\\shared (rév. ${REV}, MIT © github.com/fathah)`;
fs.writeFileSync(
  path.join(ROOT, "packages/contracts/src/hermes-types.ts"),
  `// GÉNÉRÉ par scripts/gen_hermes_shim.cjs depuis ${sharedSrc}. Ne pas éditer à la main.
/**
 * Types des charges utiles de la surface \`hermesAPI\` (dette D1 soldée) : repris à l'identique des
 * modules \`src/shared/*\` de SANK-UI que son preload importe, avec leurs dépendances de types
 * (${sharedTypes.size} déclarations, ${byModule.size} modules). Aucune valeur : seulement des types.
 */
/* eslint-disable */
${[...byModule].map(([rel, decls]) => `\n// ── ${rel} ──\n\n${decls.join("\n\n")}`).join("\n")}
`,
  { encoding: "utf8" },
);
const opaqueDecl = `import type {\n${uniq(opaque.map((o) => o.name))
  .map((n) => `  ${n},`)
  .join("\n")}\n} from "@jarod/contracts/hermes-types";`;
const localDecl = localTypes.map((d) => text.slice(d.getFullStart(), d.getEnd()).replace(/^\n+/, "")).join("\n\n");
const electronBody = electronApi ? text.slice(electronApi.initializer.getStart(), electronApi.initializer.getEnd()) : "{}";
const manifestLines = manifest
  .map((m) => `  ${m.name}: ${JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => k !== "name")))},`)
  .join("\n");

fs.mkdirSync(path.join(ROOT, "packages/desktop/src/renderer"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "packages/desktop/src/renderer/hermes-api.ts"),
  `${banner}
/**
 * Shim \`window.hermesAPI\` au-dessus de l'ui-bridge unique \`window.oneai\` (PLAN §0.4, W8, Q6 = hermesAPI
 * complet) : ${manifest.length} méthodes, corps d'origine. Le renderer ne touche jamais \`ipcRenderer\` ; le
 * preload n'expose que \`oneai\`. Types SANK-UI importés par l'original : \`@jarod/contracts/hermes-types\`
 * (générés depuis \`src/shared/*\`, verbatim).
 */
/* eslint-disable */
import type { OneaiBridge } from "@jarod/contracts/ipc";

${opaqueDecl}

${localDecl}

/** Ce que chaque méthode traverse : canal et forme (tests de fidélité, allowlists). */
export const HERMES_API_MANIFEST = {
${manifestLines}
} as const;

/** \`electronAPI\` d'origine (index.ts:${lineOf(electronApi?.getStart() ?? 0)}) : ce que le preload sait du processus. */
export function createElectronAPI(oneai: OneaiBridge) {
  const process = oneai.host.process;
  return ${electronBody};
}

export function createHermesAPI(oneai: OneaiBridge) {
  return ${body};
}

export type HermesAPI = ReturnType<typeof createHermesAPI>;
`,
  { encoding: "utf8" },
);
// ── Contrat de type du renderer (D1) ────────────────────────────────────────────────────────────
const DTS = "src/preload/index.d.ts";
if (execFileSync("git", ["-C", SANK, "status", "--porcelain", "--", DTS]).toString().trim()) fail(`${DTS} modifié dans l'arbre SANK-UI : copie refusée`);
const dts = fs.readFileSync(path.join(SANK, DTS), "utf8").replace(/\r\n?/g, "\n");
if (!/declare global \{\n {2}interface Window \{\n {4}electron: ElectronAPI;\n {4}hermesAPI: HermesAPI;\n {2}\}\n\}\n*$/.test(dts)) fail(`${DTS} : forme inattendue (déclaration globale window.electron/hermesAPI)`);
fs.mkdirSync(path.join(ROOT, "packages/desktop/src/sank/src/preload"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "packages/desktop/src/sank/src/preload/index.d.ts"), dts, { encoding: "utf8" });

console.log(`hermesAPI : ${manifest.length} méthodes ${JSON.stringify(counts)} ; canaux invoke ${invokeChannels.length}, event ${eventChannels.length} ; rév. ${REV}`);
