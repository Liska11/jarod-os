// Un écrivain ZIP minimal (méthode « deflate », sans chiffrement ni Zip64) : de quoi emballer un document Office (docx, xlsx, pptx sont des ZIP de XML).
// Écrit ici pour ne rien ajouter aux dépendances du produit.
import { deflateRawSync } from "node:zlib";

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: string | Uint8Array;
}

/** Le 1er janvier 1980 à minuit : un même contenu donne les mêmes octets (pas d'horloge dans le fichier). */
const DOS_TIME = 0;
const DOS_DATE = 0x21;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0x7fffffff;

export function zip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) throw new Error("Trop de parties dans le document.");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.name || e.name.startsWith("/") || e.name.includes("..") || e.name.includes("\\")) throw new Error(`Nom de partie invalide : ${e.name}`);
    if (seen.has(e.name)) throw new Error(`Partie en double : ${e.name}`);
    seen.add(e.name);
    const name = Buffer.from(e.name, "utf8");
    const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : Buffer.from(e.data);
    const packed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version nécessaire
    local.writeUInt16LE(0x0800, 6); // noms en UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
    if (offset > MAX_BYTES) throw new Error("Document trop gros.");
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Relit la liste des parties d'un ZIP (pour vérifier ce qui vient d'être écrit) ; lève si l'archive est abîmée. */
export function listZip(buf: Buffer): string[] {
  const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) throw new Error("Pas une archive ZIP.");
  const count = buf.readUInt16LE(at + 10);
  let p = buf.readUInt32LE(at + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Répertoire central abîmé.");
    const n = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    names.push(buf.toString("utf8", p + 46, p + 46 + n));
    p += 46 + n + extra + comment;
  }
  return names;
}
