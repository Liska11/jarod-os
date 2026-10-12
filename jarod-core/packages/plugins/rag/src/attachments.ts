// Portage de packages/core/src/services/attachments.ts (rév. 2e180305).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Db } from "@jarod/plugin-storage";
import type { Attachment } from "@jarod/contracts";
import { newId, now, parseJson } from "@jarod/kernel/util";
import { type LoadedAttachment } from "@jarod/contracts";
import { type AttachmentKind } from "@jarod/contracts";
export type { AttachmentKind };
export type { LoadedAttachment };

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 120_000;

// AttachmentKind : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

// LoadedAttachment : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".swift",
  ".sh",
  ".ps1",
  ".bat",
  ".sql",
  ".log",
  ".env",
  ".vue",
  ".svelte",
  ".lua",
  ".r",
]);

export function attachmentKind(name: string, mime: string): AttachmentKind {
  if (IMAGE_MIMES.has(mime)) return "image";
  if (mime === "application/pdf" || extname(name).toLowerCase() === ".pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    /json|xml|javascript|yaml|toml|x-sh/.test(mime) ||
    TEXT_EXTENSIONS.has(extname(name).toLowerCase())
  ) {
    return "text";
  }
  return "binary";
}

/** Encrypted file layout: magic, 12-byte IV, 16-byte GCM tag, then the ciphertext. */
const MAGIC = Buffer.from("JRD1", "ascii");

export function encryptFile(key: Buffer, data: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptFile(key: Buffer, blob: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(4, 16));
  decipher.setAuthTag(blob.subarray(16, 32));
  return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
}

const isEncrypted = (blob: Buffer) => blob.length >= 32 && blob.subarray(0, 4).equals(MAGIC);

/**
 * Files attached to messages, stored under `<dataDir>/attachments`. With a key (encrypted profile)
 * they are stored with AES-256-GCM; files written before encryption are converted on startup.
 */
export class AttachmentService {
  constructor(
    private readonly db: Db,
    readonly dir: string,
    private readonly key: Buffer | null = null,
  ) {
    mkdirSync(dir, { recursive: true });
    if (key) this.encryptLegacyFiles();
  }

  private encryptLegacyFiles(): void {
    for (const { file } of this.db.all<{ file: string }>("SELECT file FROM attachments")) {
      const path = join(this.dir, file);
      if (!existsSync(path)) continue;
      const blob = readFileSync(path);
      if (!isEncrypted(blob)) writeFileSync(path, encryptFile(this.key!, blob));
    }
  }

  save(name: string, mime: string, data: Buffer): Attachment {
    if (data.length > MAX_ATTACHMENT_BYTES)
      throw new Error(`Fichier trop volumineux (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo)`);
    const id = newId();
    const safeName = name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) || "fichier";
    const file = `${id}${extname(safeName).slice(0, 12)}`;
    writeFileSync(join(this.dir, file), this.key ? encryptFile(this.key, data) : data);
    const type = mime || "application/octet-stream";
    this.db.run(
      "INSERT INTO attachments (id, name, mime, size, file, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      safeName,
      type,
      data.length,
      file,
      now(),
    );
    return { id, name: safeName, mime: type, size: data.length };
  }

  get(id: string): (Attachment & { file: string }) | undefined {
    return this.db.get("SELECT id, name, mime, size, file FROM attachments WHERE id = ?", id);
  }

  read(id: string): Buffer {
    const a = this.get(id);
    if (!a) throw new Error("Pièce jointe introuvable");
    const blob = readFileSync(join(this.dir, a.file));
    if (!isEncrypted(blob)) return blob;
    if (!this.key) throw new Error("Pièce jointe chiffrée : clé indisponible");
    return decryptFile(this.key, blob);
  }

  dataUrl(id: string): string {
    const a = this.get(id);
    if (!a) throw new Error("Pièce jointe introuvable");
    return `data:${a.mime};base64,${this.read(id).toString("base64")}`;
  }

  load(att: Attachment): LoadedAttachment {
    const kind = attachmentKind(att.name, att.mime);
    try {
      const buf = this.read(att.id);
      if (kind === "image" || kind === "pdf") return { ...att, kind, data: buf.toString("base64") };
      if (kind === "text") {
        const text = buf.toString("utf8");
        return {
          ...att,
          kind,
          text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n… [tronqué]` : text,
        };
      }
      return { ...att, kind };
    } catch {
      return { ...att, kind: "binary" };
    }
  }

  delete(id: string): void {
    const a = this.get(id);
    if (!a) return;
    rmSync(join(this.dir, a.file), { force: true });
    this.db.run("DELETE FROM attachments WHERE id = ?", id);
    this.db.run("DELETE FROM image_descriptions WHERE attachment_id = ?", id);
  }

  /** Ids of attachments still referenced by a message (a forked conversation shares its files). */
  private referenced(): Set<string> {
    const ids = new Set<string>();
    for (const r of this.db.all<{ attachments: string }>(
      "SELECT attachments FROM messages WHERE attachments IS NOT NULL",
    )) {
      for (const a of parseJson<Attachment[]>(r.attachments, [])) ids.add(a.id);
    }
    return ids;
  }

  /** Deletes those of `ids` that no message uses any more. */
  deleteUnreferenced(ids: string[]): number {
    const used = this.referenced();
    let n = 0;
    for (const id of new Set(ids)) {
      if (used.has(id) || !this.get(id)) continue;
      this.delete(id);
      n++;
    }
    return n;
  }

  /** Deletes files uploaded but never sent (or orphaned by an older version), once older than `minAgeMs`. */
  pruneOrphans(minAgeMs = 24 * 3600_000): number {
    const used = this.referenced();
    const old = this.db.all<{ id: string }>("SELECT id FROM attachments WHERE created_at < ?", now() - minAgeMs);
    let n = 0;
    for (const { id } of old) {
      if (used.has(id)) continue;
      this.delete(id);
      n++;
    }
    return n;
  }
}

/** Text rendering of non-media attachments, for providers that only accept text. */
export function describeAttachment(a: LoadedAttachment): string {
  if (a.kind === "text") return `<fichier nom="${a.name}">\n${a.text ?? ""}\n</fichier>`;
  return `[Pièce jointe « ${a.name} » (${a.mime}, ${Math.round(a.size / 1024)} Ko) : format non lisible par ce modèle]`;
}
