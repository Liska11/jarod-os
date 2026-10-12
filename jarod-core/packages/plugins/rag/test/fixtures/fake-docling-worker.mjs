// Faux worker de documents pour les tests (précédent : fake-mcp.mjs). Le comportement dépend du CONTENU du fichier
// reçu : sa première ligne est une consigne (CRASH, HANG…), sinon il rend un manifeste Markdown valide.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

function manifestFor(bytes, text, over = {}) {
  const sections = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) sections.push({ start: pos, end: text.length, page: null, level: 1, title: line.slice(2).trim() });
    pos += line.length + 1;
  }
  return {
    manifestVersion: 1,
    parser: { name: "fake-docling", version: "1.0.0" },
    source: { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mime: "application/octet-stream" },
    language: null,
    pages: null,
    sections,
    tables: [],
    images: [],
    errors: [],
    ...over,
  };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.op === "quit") process.exit(0);
  if (msg.op === "hello") {
    if (process.env.FAKE_HELLO === "wrong-name") return send({ ok: true, name: "autre", version: "1.0.0", protocol: 1, pid: process.pid });
    return send({ ok: true, name: "fake-docling", version: "1.0.0", protocol: 1, pid: process.pid });
  }
  const bytes = readFileSync(msg.path);
  const text = bytes.toString("utf8");
  const [head = "", arg = ""] = text.split("\n");
  switch (head) {
    case "CRASH":
      process.exit(3);
      break;
    case "HANG":
      break; // ne répond jamais
    case "HANG-GRANDCHILD": {
      // Un petit-enfant qui survivrait au worker : son pid est écrit dans le fichier nommé à la ligne 2.
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(arg, String(child.pid));
      break;
    }
    case "GARBAGE":
      process.stdout.write("ceci n'est pas du JSON\n");
      break;
    case "BADMANIFEST":
      send({ id: msg.id, ok: true, manifest: { nope: true }, text });
      break;
    case "WRONGHASH":
      send({ id: msg.id, ok: true, manifest: manifestFor(Buffer.from("autre chose"), text), text });
      break;
    case "BADSPAN":
      send({ id: msg.id, ok: true, manifest: manifestFor(bytes, text, { tables: [{ start: 0, end: text.length + 10, page: null }] }), text });
      break;
    case "WRONGID":
      send({ id: msg.id + 1, ok: true, manifest: manifestFor(bytes, text), text });
      break;
    case "ERR":
      // Un message libre contenant du texte du document : l'adaptateur ne doit en retenir que le code.
      send({ id: msg.id, ok: false, code: "corrupt-file", message: `échec sur : ${text}` });
      break;
    case "ERR-BADCODE":
      send({ id: msg.id, ok: false, code: `mauvais code <b>${text}</b>` });
      break;
    case "ENV":
      send({
        id: msg.id,
        ok: true,
        manifest: manifestFor(bytes, text),
        text: JSON.stringify({
          secret: process.env.JAROD_SECRET_TEST ?? null,
          offline: process.env.HF_HUB_OFFLINE ?? null,
          threads: process.env.OMP_NUM_THREADS ?? null,
          custom: process.env.FAKE_CUSTOM ?? null,
          hasPath: Boolean(process.env.PATH ?? process.env.Path),
        }),
      });
      break;
    case "STDERR":
      process.stderr.write(`texte du document sur stderr : ${text}\n`);
      send({ id: msg.id, ok: true, manifest: manifestFor(bytes, text), text });
      break;
    default:
      send({ id: msg.id, ok: true, manifest: manifestFor(bytes, text), text });
  }
});
